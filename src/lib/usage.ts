import { createReadStream, promises as fs, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { deriveProjectRoot } from "./format";
import { mapWithConcurrency } from "./sessions";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const SCAN_CHUNK_BYTES = 256 * 1024;
const CLASSIFY_WINDOW_BYTES = 4 * 1024;
/**
 * Assistant lines are materialized in full (unlike the session scanner) so we
 * can read the `usage` block that sits at the end of `message`. They're the
 * model's own turns — normally small — but a big tool-use input can inflate
 * one, so we cap it: past this we skip the turn rather than hold an unbounded
 * string. Peak memory is one assistant line per in-flight file.
 */
const MAX_ASSISTANT_LINE_BYTES = 8 * 1024 * 1024;
const SCAN_CONCURRENCY = 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Estimated cost of the *priced* turns only. */
  costUSD: number;
  /** True if any turn here used a model with no known price, so `costUSD` is a floor. */
  hasUnpriced: boolean;
}

export interface NamedUsage extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageReport {
  fiveHour: UsageTotals;
  today: UsageTotals;
  week: UsageTotals;
  month: UsageTotals;
  all: UsageTotals;
  byModel: NamedUsage[];
  byProject: NamedUsage[];
  /** Most recent assistant turn seen (ms), if any. */
  lastActivity?: number;
}

interface Rate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * USD per million tokens, by model family. These are list prices and change
 * over time, and the 1M-context tier is billed higher above 200k tokens —
 * this deliberately ignores that nuance, so cost is an estimate, not a bill.
 * Kept in one place so it's easy to update when prices move.
 */
const RATES: Record<"opus" | "sonnet" | "haiku", Rate> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

function rateFor(model: string): Rate | undefined {
  const m = model.toLowerCase();
  if (m.includes("opus")) return RATES.opus;
  if (m.includes("sonnet")) return RATES.sonnet;
  if (m.includes("haiku")) return RATES.haiku;
  return undefined;
}

interface RawTurn {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cwd?: string;
}

/** Cost of one turn, plus whether the model was priced (unpriced → 0 cost). */
function costOfTurn(turn: RawTurn): { cost: number; priced: boolean } {
  const rate = rateFor(turn.model);
  if (!rate) return { cost: 0, priced: false };
  const cost =
    (turn.input * rate.input +
      turn.output * rate.output +
      turn.cacheCreation * rate.cacheWrite +
      turn.cacheRead * rate.cacheRead) /
    1_000_000;
  return { cost, priced: true };
}

interface ParsedRecord {
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function parseTurn(line: string): RawTurn | undefined {
  let record: ParsedRecord;
  try {
    record = JSON.parse(line) as ParsedRecord;
  } catch {
    return undefined;
  }
  if (record.isSidechain) return undefined;
  const usage = record.message?.usage;
  if (!usage) return undefined;
  const ts =
    typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return {
    ts: Number.isNaN(ts) ? 0 : ts,
    model:
      typeof record.message?.model === "string"
        ? record.message.model
        : "unknown",
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
  };
}

type LineKind = "unclassified" | "assistant" | "ignore";

/**
 * Streams one file in fixed-size chunks and collects every real (non-sidechain)
 * assistant turn's usage. Mirrors the memory discipline of the session
 * scanner: a line is buffered only while it might be an assistant turn (or is
 * one), classified from a small prefix on `"role":"assistant"`, and dropped
 * immediately once it's known to be a user/tool line — so the multi-MB
 * tool-result lines are only byte-counted, never held.
 */
async function scanFileUsage(filePath: string): Promise<RawTurn[]> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, {
      highWaterMark: SCAN_CHUNK_BYTES,
    });
    const turns: RawTurn[] = [];
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;
    let kind: LineKind = "unclassified";

    function classify() {
      const prefix = Buffer.concat(lineChunks).toString("utf8");
      const isAssistant =
        prefix.includes('"role":"assistant"') ||
        prefix.includes('"role": "assistant"');
      const isSidechain =
        prefix.includes('"isSidechain":true') ||
        prefix.includes('"isSidechain": true');
      kind = isAssistant && !isSidechain ? "assistant" : "ignore";
      if (kind === "ignore") lineChunks = [];
    }

    function finishLine() {
      if (kind === "unclassified") classify();
      if (kind === "assistant" && lineBytes <= MAX_ASSISTANT_LINE_BYTES) {
        const turn = parseTurn(Buffer.concat(lineChunks).toString("utf8"));
        if (turn) turns.push(turn);
      }
      lineChunks = [];
      lineBytes = 0;
      kind = "unclassified";
    }

    stream.on("data", (rawChunk: Buffer | string) => {
      const chunk =
        typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
      let offset = 0;
      while (offset < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, offset);
        const end = newlineIndex === -1 ? chunk.length : newlineIndex;
        const piece = chunk.subarray(offset, end);

        if (
          kind !== "ignore" &&
          lineBytes + piece.length <= MAX_ASSISTANT_LINE_BYTES
        ) {
          lineChunks.push(piece);
        }
        lineBytes += piece.length;

        if (kind === "unclassified" && lineBytes >= CLASSIFY_WINDOW_BYTES) {
          classify();
        }

        if (newlineIndex !== -1) {
          finishLine();
          offset = newlineIndex + 1;
        } else {
          offset = chunk.length;
        }
      }
    });
    stream.on("end", () => {
      if (lineBytes > 0) finishLine();
      resolve(turns);
    });
    stream.on("error", reject);
  });
}

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    costUSD: 0,
    hasUnpriced: false,
  };
}

function addTurn(
  dst: UsageTotals,
  turn: RawTurn,
  cost: number,
  priced: boolean,
): void {
  dst.input += turn.input;
  dst.output += turn.output;
  dst.cacheRead += turn.cacheRead;
  dst.cacheCreation += turn.cacheCreation;
  dst.costUSD += cost;
  if (!priced) dst.hasUnpriced = true;
}

/** Total tokens across all four tiers. */
export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheCreation;
}

/**
 * Scans every session transcript under `~/.claude/projects` and aggregates
 * assistant-turn token usage into time windows, per model, and per project.
 * Fully local and read-only; cost is an estimate from `RATES`. `projectsDir`
 * is overridable only for testing.
 */
export async function scanAllUsage(
  projectsDir: string = PROJECTS_DIR,
): Promise<UsageReport> {
  const now = Date.now();
  const report: UsageReport = {
    fiveHour: emptyTotals(),
    today: emptyTotals(),
    week: emptyTotals(),
    month: emptyTotals(),
    all: emptyTotals(),
    byModel: [],
    byProject: [],
  };
  if (!existsSync(projectsDir)) return report;

  const files: string[] = [];
  const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });
  for (const entry of projectDirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(projectsDir, entry.name);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".jsonl") && !name.startsWith(".")) {
        files.push(join(dir, name));
      }
    }
  }

  const perFile = await mapWithConcurrency(
    files,
    SCAN_CONCURRENCY,
    (filePath) => scanFileUsage(filePath).catch((): RawTurn[] => []),
  );

  const fiveHourAgo = now - 5 * HOUR_MS;
  const weekAgo = now - 7 * DAY_MS;
  const monthAgo = now - 30 * DAY_MS;
  const todayStart = new Date(now).setHours(0, 0, 0, 0);

  const byModel = new Map<string, UsageTotals>();
  const byProject = new Map<string, { label: string; totals: UsageTotals }>();

  for (const turns of perFile) {
    for (const turn of turns) {
      const { cost, priced } = costOfTurn(turn);

      addTurn(report.all, turn, cost, priced);
      if (turn.ts >= monthAgo) addTurn(report.month, turn, cost, priced);
      if (turn.ts >= weekAgo) addTurn(report.week, turn, cost, priced);
      if (turn.ts >= todayStart) addTurn(report.today, turn, cost, priced);
      if (turn.ts >= fiveHourAgo) addTurn(report.fiveHour, turn, cost, priced);
      if (!report.lastActivity || turn.ts > report.lastActivity) {
        report.lastActivity = turn.ts;
      }

      let modelTotals = byModel.get(turn.model);
      if (!modelTotals) {
        modelTotals = emptyTotals();
        byModel.set(turn.model, modelTotals);
      }
      addTurn(modelTotals, turn, cost, priced);

      if (turn.cwd) {
        const root = deriveProjectRoot(turn.cwd);
        let project = byProject.get(root.key);
        if (!project) {
          project = { label: root.label, totals: emptyTotals() };
          byProject.set(root.key, project);
        }
        addTurn(project.totals, turn, cost, priced);
      }
    }
  }

  report.byModel = Array.from(byModel.entries())
    .map(([key, totals]) => ({ key, label: key, ...totals }))
    .filter((entry) => totalTokens(entry) > 0)
    .sort(sortByCostThenTokens);
  report.byProject = Array.from(byProject.entries())
    .map(([key, { label, totals }]) => ({ key, label, ...totals }))
    .filter((entry) => totalTokens(entry) > 0)
    .sort(sortByCostThenTokens);

  return report;
}

function sortByCostThenTokens(a: NamedUsage, b: NamedUsage): number {
  if (b.costUSD !== a.costUSD) return b.costUSD - a.costUSD;
  return totalTokens(b) - totalTokens(a);
}
