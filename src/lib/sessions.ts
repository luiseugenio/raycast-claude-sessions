import { createReadStream, promises as fs, existsSync } from "fs";
import { createInterface } from "readline";
import { homedir } from "os";
import { join, basename } from "path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Minimal key-value cache contract used to memoize per-file parse results
 * keyed by `path:mtime`. Deliberately framework-agnostic (no dependency on
 * `@raycast/api`, which only resolves inside the Raycast app runtime) so
 * this module can also be exercised by a standalone Node script.
 */
export interface KeyValueCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** Simple in-memory cache — useful for tests/scripts, not persisted across process restarts. */
export class InMemoryCache implements KeyValueCache {
  private store = new Map<string, string>();
  get(key: string): string | undefined {
    return this.store.get(key);
  }
  set(key: string, value: string): void {
    this.store.set(key, value);
  }
}

/**
 * Wrapper tag names Claude Code (and Conductor) prepend to a user turn that
 * aren't themselves a human-typed prompt. Critically, these can be a
 * *prefix* of the same message rather than a separate line — e.g. every
 * Conductor session's first user message is literally
 * `<system_instruction>...boilerplate...</system_instruction>\n\n<the real
 * human prompt>` in one string. `stripLeadingWrapperBlocks` below strips any
 * of these (possibly several in a row) off the front and keeps whatever real
 * text remains, instead of discarding the whole message.
 */
const WRAPPER_TAG_NAMES = [
  "ide_selection",
  "system_instruction",
  "system-reminder",
  "command-message",
  "command-name",
  "local-command-stdout",
];
const LEADING_WRAPPER_RE = new RegExp(
  `^\\s*<(${WRAPPER_TAG_NAMES.join("|")})>[\\s\\S]*?<\\/\\1>\\s*`,
);

const HEAD_MAX_LINES = 60;
const HEAD_MAX_BYTES = 96 * 1024;
const TAIL_MAX_BYTES = 128 * 1024;
const PREVIEW_MESSAGE_COUNT = 3;

export type EntrypointKind = "claude-desktop" | "conductor" | "cli";

export interface SessionMeta {
  sessionId: string;
  filePath: string;
  projectDirName: string;
  cwd: string;
  gitBranch?: string;
  slug?: string;
  entrypoint?: string;
  version?: string;
  createdAt: Date;
  mtime: Date;
  size: number;
  /** First real human-authored prompt text, truncated to ~80 chars. Always available. */
  firstPromptTitle: string;
  /** First real human-authored prompt text, capped at ~2000 chars, for the detail markdown. */
  firstPromptFull: string;
  /** `custom-title` / `ai-title` records found while scanning the file, if any. */
  customTitle?: string;
  aiTitle?: string;
  messageCount: number;
}

export interface SessionPreviewMessage {
  role: "user" | "assistant";
  text: string;
}

interface JsonlRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  entrypoint?: string;
  version?: string;
  timestamp?: string;
  isSidechain?: boolean;
  customTitle?: string;
  aiTitle?: string;
  message?: { role?: string; content?: unknown };
}

function safeParseLine(line: string): JsonlRecord | undefined {
  if (!line) return undefined;
  try {
    return JSON.parse(line) as JsonlRecord;
  } catch {
    return undefined;
  }
}

/** Extracts the first plain-text block from a user/assistant message's content. */
function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text"
      ) {
        const text = (block as { text?: string }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return undefined;
}

/**
 * Strips any leading `<wrapper>...</wrapper>` block(s) (see
 * `WRAPPER_TAG_NAMES`) off `text`, then returns the real, human-typed prompt
 * that remains — or `undefined` if nothing real is left (the whole message
 * was wrapper content, or what remains is just a `/slash-command`).
 */
function extractRealPromptText(text: string): string | undefined {
  let remaining = text;
  while (LEADING_WRAPPER_RE.test(remaining)) {
    remaining = remaining.replace(LEADING_WRAPPER_RE, "");
  }
  const trimmed = remaining.trim();
  if (!trimmed || trimmed.startsWith("/")) return undefined;
  return trimmed;
}

function truncateTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 79).trimEnd()}…`;
}

function capText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}…`;
}

/** Reads only the first `maxLines`/`maxBytes` of a file, one line at a time. */
async function readHeadLines(
  filePath: string,
  maxLines = HEAD_MAX_LINES,
  maxBytes = HEAD_MAX_BYTES,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    let bytes = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      resolve(lines);
    };
    rl.on("line", (line) => {
      lines.push(line);
      bytes += Buffer.byteLength(line, "utf8");
      if (lines.length >= maxLines || bytes >= maxBytes) finish();
    });
    rl.on("close", finish);
    stream.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Streams the whole file once, counting real (non-sidechain) user/assistant
 * messages and picking up the latest `custom-title`/`ai-title` records seen.
 * This is the only full-file pass we do, and only on a cache miss (mtime
 * changed since last scan).
 */
async function scanFullFile(
  filePath: string,
): Promise<{ messageCount: number; customTitle?: string; aiTitle?: string }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let messageCount = 0;
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    rl.on("line", (line) => {
      // Cheap substring pre-checks avoid JSON.parse for the vast majority of lines.
      if (
        line.includes('"type":"user"') ||
        line.includes('"type": "user"') ||
        line.includes('"type":"assistant"') ||
        line.includes('"type": "assistant"')
      ) {
        const record = safeParseLine(line);
        if (
          record &&
          !record.isSidechain &&
          (record.type === "user" || record.type === "assistant")
        ) {
          messageCount++;
        }
        return;
      }
      if (
        line.includes('"type":"custom-title"') ||
        line.includes('"type": "custom-title"')
      ) {
        const record = safeParseLine(line);
        if (record?.customTitle) customTitle = record.customTitle;
        return;
      }
      if (
        line.includes('"type":"ai-title"') ||
        line.includes('"type": "ai-title"')
      ) {
        const record = safeParseLine(line);
        if (record?.aiTitle) aiTitle = record.aiTitle;
      }
    });
    rl.on("close", () => resolve({ messageCount, customTitle, aiTitle }));
    stream.on("error", reject);
  });
}

/** Reads the last `maxBytes` bytes of a file as text (used for detail previews). */
async function readTailText(
  filePath: string,
  size: number,
  maxBytes = TAIL_MAX_BYTES,
): Promise<string> {
  const start = Math.max(0, size - maxBytes);
  const fh = await fs.open(filePath, "r");
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await fh.close();
  }
}

interface HeadParseResult {
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  entrypoint?: string;
  version?: string;
  createdAt?: string;
  firstPromptTitle: string;
  firstPromptFull: string;
}

async function parseHead(filePath: string): Promise<HeadParseResult> {
  const lines = await readHeadLines(filePath);
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let slug: string | undefined;
  let entrypoint: string | undefined;
  let version: string | undefined;
  let createdAt: string | undefined;
  let firstPromptTitle = "Untitled session";
  let firstPromptFull = "_No prompt text found._";
  let foundFirstPrompt = false;

  for (const line of lines) {
    const record = safeParseLine(line);
    if (!record) continue;
    if (record.type === "queue-operation" || record.type === "attachment")
      continue;
    if (record.isSidechain) continue;

    if (!cwd && record.cwd) cwd = record.cwd;
    if (!gitBranch && record.gitBranch) gitBranch = record.gitBranch;
    if (!slug && record.slug) slug = record.slug;
    if (!entrypoint && record.entrypoint) entrypoint = record.entrypoint;
    if (!version && record.version) version = record.version;
    if (
      !createdAt &&
      record.timestamp &&
      (record.type === "user" || record.type === "assistant")
    ) {
      createdAt = record.timestamp;
    }

    if (
      !foundFirstPrompt &&
      record.type === "user" &&
      record.message?.role === "user"
    ) {
      const rawText = extractText(record.message.content);
      const text = rawText ? extractRealPromptText(rawText) : undefined;
      if (text) {
        firstPromptTitle = truncateTitle(text);
        firstPromptFull = capText(text, 2000);
        foundFirstPrompt = true;
      }
    }
  }

  return {
    cwd,
    gitBranch,
    slug,
    entrypoint,
    version,
    createdAt,
    firstPromptTitle,
    firstPromptFull,
  };
}

interface TreeCacheEntry {
  fileMtime: number;
  data: {
    customTitle?: string;
    messageCount?: number;
  };
}

interface TreeCacheFile {
  sessions?: Record<string, TreeCacheEntry>;
}

/** Reads (read-only) a project's `.tree-cache.json`, if present. Never written to. */
async function readTreeCache(
  projectDir: string,
): Promise<Record<string, TreeCacheEntry>> {
  const path = join(projectDir, ".tree-cache.json");
  if (!existsSync(path)) return {};
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as TreeCacheFile;
    return parsed.sessions ?? {};
  } catch {
    return {};
  }
}

interface CachedMeta {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  slug?: string;
  entrypoint?: string;
  version?: string;
  createdAt: string;
  firstPromptTitle: string;
  firstPromptFull: string;
  customTitle?: string;
  aiTitle?: string;
  messageCount: number;
}

/**
 * Parses one session file, using the mtime-keyed cache when possible.
 *
 * `sessionId` is the canonical identity for this session — it's the file's
 * basename (the UUID Claude Code itself uses for `claude --resume <uuid>` /
 * `claude://resume?session=<uuid>`), not the embedded `sessionId` field from
 * the JSONL content. In practice the two always agree, but the filename is
 * guaranteed to exist for every file (no parsing required) and is what the
 * CLI/desktop app actually key off of, so it's the source of truth here.
 */
async function parseSessionFile(
  filePath: string,
  projectDirName: string,
  mtimeMs: number,
  size: number,
  sessionId: string,
  cache: KeyValueCache,
): Promise<SessionMeta | undefined> {
  const cacheKey = `${filePath}:${mtimeMs}`;
  const cached = cache.get(cacheKey);
  let meta: CachedMeta | undefined;

  if (cached) {
    try {
      meta = JSON.parse(cached) as CachedMeta;
    } catch {
      meta = undefined;
    }
  }

  if (!meta) {
    const head = await parseHead(filePath);
    // Identity comes from the filename, not the embedded `sessionId` field (see
    // `sessionId` param below) — `cwd` is what we actually need out of the head
    // parse to consider this a valid, resumable session file.
    if (!head.cwd) return undefined;
    const full = await scanFullFile(filePath);
    meta = {
      sessionId,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      slug: head.slug,
      entrypoint: head.entrypoint,
      version: head.version,
      createdAt: head.createdAt ?? new Date(mtimeMs).toISOString(),
      firstPromptTitle: head.firstPromptTitle,
      firstPromptFull: head.firstPromptFull,
      customTitle: full.customTitle,
      aiTitle: full.aiTitle,
      messageCount: full.messageCount,
    };
    cache.set(cacheKey, JSON.stringify(meta));
  }

  return {
    sessionId: meta.sessionId,
    filePath,
    projectDirName,
    cwd: meta.cwd,
    gitBranch: meta.gitBranch,
    slug: meta.slug,
    entrypoint: meta.entrypoint,
    version: meta.version,
    createdAt: new Date(meta.createdAt),
    mtime: new Date(mtimeMs),
    size,
    firstPromptTitle: meta.firstPromptTitle,
    firstPromptFull: meta.firstPromptFull,
    customTitle: meta.customTitle,
    aiTitle: meta.aiTitle,
    messageCount: meta.messageCount,
  };
}

/** Scans every session file under `~/.claude/projects`. */
export async function scanAllSessions(
  cache: KeyValueCache,
): Promise<SessionMeta[]> {
  if (!existsSync(PROJECTS_DIR)) return [];
  const projectDirs = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const results: SessionMeta[] = [];

  await Promise.all(
    projectDirs
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const projectDir = join(PROJECTS_DIR, entry.name);
        let files: string[];
        try {
          files = (await fs.readdir(projectDir)).filter(
            (f) => f.endsWith(".jsonl") && !f.startsWith("."),
          );
        } catch {
          return;
        }

        const treeCache = await readTreeCache(projectDir);

        await Promise.all(
          files.map(async (fileName) => {
            const filePath = join(projectDir, fileName);
            let stat;
            try {
              stat = await fs.stat(filePath);
            } catch {
              return;
            }
            if (stat.size === 0) return;

            const sessionId = basename(fileName, ".jsonl");

            let session: SessionMeta | undefined;
            try {
              session = await parseSessionFile(
                filePath,
                entry.name,
                stat.mtimeMs,
                stat.size,
                sessionId,
                cache,
              );
            } catch {
              return;
            }
            if (!session) return;

            const treeEntry = treeCache[sessionId];
            if (
              treeEntry &&
              treeEntry.fileMtime === stat.mtimeMs &&
              treeEntry.data?.customTitle
            ) {
              session.customTitle =
                session.customTitle ?? treeEntry.data.customTitle;
            }

            results.push(session);
          }),
        );
      }),
  );

  const deduped = dedupeBySessionId(results);
  deduped.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return deduped;
}

/**
 * A single logical session can end up as two files with the same UUID
 * filename in two different project directories — e.g. a conversation is
 * resumed from a different `cwd` (a worktree gets removed and the same
 * session id is continued from the parent checkout) and the storage bucket
 * is keyed by cwd, not just session id. When that happens, keep only the
 * most recently modified file for that session id so the list never shows
 * two rows (and never hands React two items with the same key) for what's
 * really one conversation.
 */
function dedupeBySessionId(sessions: SessionMeta[]): SessionMeta[] {
  const bySessionId = new Map<string, SessionMeta>();
  for (const session of sessions) {
    const existing = bySessionId.get(session.sessionId);
    if (!existing || session.mtime.getTime() > existing.mtime.getTime()) {
      bySessionId.set(session.sessionId, session);
    }
  }
  return Array.from(bySessionId.values());
}

/** Reads the last few real messages of a session file for the detail preview. */
export async function getSessionPreview(
  filePath: string,
  size: number,
): Promise<SessionPreviewMessage[]> {
  const tail = await readTailText(filePath, size);
  const rawLines = tail.split("\n").filter(Boolean);
  // The first line of a tail read is very likely a truncated partial line; drop it
  // unless the tail read happened to cover the whole file.
  const lines = size > TAIL_MAX_BYTES ? rawLines.slice(1) : rawLines;

  const messages: SessionPreviewMessage[] = [];
  for (
    let i = lines.length - 1;
    i >= 0 && messages.length < PREVIEW_MESSAGE_COUNT;
    i--
  ) {
    const record = safeParseLine(lines[i]);
    if (!record || record.isSidechain) continue;
    if (record.type !== "user" && record.type !== "assistant") continue;
    const role = record.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const rawText = extractText(record.message?.content);
    if (!rawText) continue;
    const text = role === "user" ? extractRealPromptText(rawText) : rawText;
    if (!text) continue;
    messages.push({ role, text: capText(text, 1000) });
  }
  return messages.reverse();
}
