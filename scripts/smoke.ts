/**
 * Standalone smoke test for the data layer (src/lib/sessions.ts), run with
 * plain Node/tsx — no Raycast runtime involved. `@raycast/api` only resolves
 * to a real module inside the Raycast app, so the data layer takes an
 * injectable `KeyValueCache` (see src/lib/sessions.ts) instead of importing
 * `@raycast/api` directly; here we use a simple in-memory cache to exercise
 * both the cold-scan and warm-scan (cache hit) paths.
 *
 * Read-only against ~/.claude — never writes there.
 *
 * Run with: npx tsx scripts/smoke.ts
 */
import { existsSync, promises as fsPromises } from "fs";
import { homedir } from "os";
import { join } from "path";
import { InMemoryCache, scanAllSessions } from "../src/lib/sessions";
import { loadAllDesktopSessionRecords, loadDesktopSessionIndex } from "../src/lib/desktopSessions";
import { loadConductorSessionTitleMap, loadConductorWorkspaceMap } from "../src/lib/conductor";
import { computeSessionStatus } from "../src/lib/sessionStatus";
import { isConductorCwd, prettyProjectName, relativeTime } from "../src/lib/format";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const DESKTOP_SESSIONS_DIR = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
/**
 * Optional, machine-specific ground-truth file for the Active-list acceptance
 * test below. It's just a JSON array of `{ localId, title }` pairs dumped
 * from Claude Desktop's own session-management API on some real profile —
 * there's nothing generic to ship here, so this file is gitignored and the
 * whole diff section skips gracefully when it's absent (e.g. on a fresh
 * checkout). See the README for how to generate your own if you want this
 * check locally.
 */
const GROUND_TRUTH_PATH = join(__dirname, "ground-truth.local.json");

/** All `local_*.json` file paths on disk, regardless of whether we could extract a valid record from them. */
async function findAllDesktopSessionFilePaths(): Promise<string[]> {
  async function walk(dir: string, depth: number): Promise<string[]> {
    if (depth < 0) return [];
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(entryPath, depth - 1)));
      else if (entry.isFile() && /^local_.*\.json$/.test(entry.name)) out.push(entryPath);
    }
    return out;
  }
  return walk(DESKTOP_SESSIONS_DIR, 4);
}

/**
 * Raw filesystem diagnostic, independent of the data layer: finds `.jsonl`
 * filenames (session UUIDs) that appear in more than one project directory.
 * This is exactly the scenario that caused the "duplicated ids" crash in
 * Raycast — a session resumed from a different `cwd` gets a second file with
 * the same UUID filename in a different project-dir bucket.
 */
async function findDuplicateSessionFilenames(): Promise<Map<string, string[]>> {
  const projectDirs = await fsPromises.readdir(PROJECTS_DIR, { withFileTypes: true });
  const byFilename = new Map<string, string[]>();

  for (const entry of projectDirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const projectDir = join(PROJECTS_DIR, entry.name);
    let files: string[];
    try {
      files = (await fsPromises.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const paths = byFilename.get(file) ?? [];
      paths.push(join(projectDir, file));
      byFilename.set(file, paths);
    }
  }

  const duplicates = new Map<string, string[]>();
  for (const [file, paths] of byFilename) {
    if (paths.length > 1) duplicates.set(file, paths);
  }
  return duplicates;
}

async function main() {
  console.log("Checking for duplicate session filenames across project dirs…");
  const rawDuplicates = await findDuplicateSessionFilenames();
  if (rawDuplicates.size === 0) {
    console.log("  none found on disk right now.");
  } else {
    for (const [file, paths] of rawDuplicates) {
      console.log(`  ${file} appears in ${paths.length} project dirs:`);
      for (const path of paths) {
        const stat = await fsPromises.stat(path);
        console.log(`    ${path}  (mtime=${stat.mtime.toISOString()}, ${stat.size}B)`);
      }
    }
  }
  console.log("");

  const cache = new InMemoryCache();

  const coldStart = performance.now();
  const sessions = await scanAllSessions(cache);
  const coldMs = performance.now() - coldStart;

  const warmStart = performance.now();
  const warmSessions = await scanAllSessions(cache);
  const warmMs = performance.now() - warmStart;

  console.log(`Scanned ${sessions.length} sessions across ~/.claude/projects`);
  console.log(`Cold scan: ${coldMs.toFixed(1)}ms  |  Warm (cached) scan: ${warmMs.toFixed(1)}ms`);
  console.log(`Warm-scan session count matches cold scan: ${warmSessions.length === sessions.length}`);

  // The exact assertion that would have caught the "duplicated ids" crash:
  // scanAllSessions()'s output must never contain two entries with the same
  // sessionId (List.Item id/key collision) or the same filePath.
  const sessionIdCounts = new Map<string, number>();
  const filePathCounts = new Map<string, number>();
  for (const session of sessions) {
    sessionIdCounts.set(session.sessionId, (sessionIdCounts.get(session.sessionId) ?? 0) + 1);
    filePathCounts.set(session.filePath, (filePathCounts.get(session.filePath) ?? 0) + 1);
  }
  const duplicateSessionIds = [...sessionIdCounts.entries()].filter(([, count]) => count > 1);
  const duplicateFilePaths = [...filePathCounts.entries()].filter(([, count]) => count > 1);

  if (duplicateSessionIds.length > 0 || duplicateFilePaths.length > 0) {
    console.error("\nFAIL: scanAllSessions() returned duplicate ids after dedup:");
    for (const [id, count] of duplicateSessionIds) console.error(`  sessionId ${id} appears ${count} times`);
    for (const [path, count] of duplicateFilePaths) console.error(`  filePath ${path} appears ${count} times`);
    process.exitCode = 1;
  } else {
    console.log("No duplicate sessionIds or filePaths in scanAllSessions() output — dedup is working.");
  }
  console.log("");
  console.log("10 most recent sessions:");
  console.log("");

  for (const session of sessions.slice(0, 10)) {
    const title = session.customTitle ?? session.aiTitle ?? session.firstPromptTitle;
    console.log(`- [${relativeTime(session.mtime)}] ${title}`);
    console.log(
      `    project=${prettyProjectName(session.cwd)}  slug=${session.slug ?? "—"}  messages=${session.messageCount}  branch=${session.gitBranch ?? "—"}`,
    );
  }

  if (warmMs > 2000) {
    console.warn(`\nWARNING: warm scan took ${warmMs.toFixed(1)}ms, expected < 2000ms`);
    process.exitCode = 1;
  }

  // Desktop session index (~/Library/Application Support/Claude/claude-code-sessions).
  // This previously blew the Raycast worker's heap by fully JSON.parse-ing every
  // local_*.json file (each ~99.9% a huge `enabledMcpTools` blob we never use) —
  // it now only reads/regex-scans a small byte prefix per file. Exercise it here
  // and check memory directly, since that's the thing that broke last time.
  console.log("\nLoading Claude Desktop session index…");
  const desktopCache = new InMemoryCache();
  const desktopStart = performance.now();
  const desktopIndex = await loadDesktopSessionIndex(desktopCache);
  const desktopMs = performance.now() - desktopStart;
  const desktopEntries = Object.entries(desktopIndex);
  console.log(
    `Desktop sessions indexed: ${desktopEntries.length} (${desktopEntries.filter(([, v]) => v.bridgeId).length} with a bridge id) in ${desktopMs.toFixed(1)}ms`,
  );

  // Status breakdown (active / archived / other) using the exact same
  // computeSessionStatus() the UI uses — see src/lib/sessionStatus.ts.
  console.log("\nChecking active/archived/other status…");
  const conductorWorkspaces = await loadConductorWorkspaceMap();
  const statusCounts = { active: 0, archived: 0, other: 0 };
  const ourActiveSessions: typeof sessions = [];
  for (const session of sessions) {
    const status = computeSessionStatus(session, desktopIndex, conductorWorkspaces);
    statusCounts[status]++;
    if (status === "active") ourActiveSessions.push(session);
  }
  console.log(
    `Active: ${statusCounts.active}  Archived: ${statusCounts.archived}  Other (CLI-only/scheduled): ${statusCounts.other}  (of ${sessions.length} total)`,
  );

  // Conductor-cwd sessions: were invisible under Active before (no desktop
  // record, so they fell into "other") — bug report confirmed a user
  // searching for a Conductor session got "No sessions found" in Active
  // mode. Assert at least one resolves active now, and print them with
  // whatever title we resolve (conductor session title > custom-title >
  // ai-title > desktop title > first prompt — mirrors resolveTitle() in
  // list-sessions.tsx, minus the LocalStorage rename override which isn't
  // reachable from this standalone script).
  console.log("\nConductor-cwd sessions:");
  const conductorSessionTitles = await loadConductorSessionTitleMap();
  const conductorSessions = sessions.filter((s) => isConductorCwd(s.cwd));
  let conductorActiveCount = 0;
  for (const session of conductorSessions) {
    const status = computeSessionStatus(session, desktopIndex, conductorWorkspaces);
    if (status === "active") conductorActiveCount++;
    const title =
      conductorSessionTitles[session.sessionId] ?? session.customTitle ?? session.aiTitle ?? session.firstPromptTitle;
    console.log(`  - [${status}] ${title}  (cwd=${session.cwd})`);
  }
  console.log(`${conductorSessions.length} Conductor-cwd sessions found, ${conductorActiveCount} resolve active.`);
  if (conductorSessions.length > 0 && conductorActiveCount === 0) {
    console.error("FAIL: found Conductor-cwd sessions but none resolve to active status.");
    process.exitCode = 1;
  }

  // Ground-truth acceptance test (optional — see GROUND_TRUTH_PATH's doc
  // comment): compares our computed Active list against a dump of Claude
  // Desktop's own session-management API / sidebar. Matched by the
  // desktop's local_<uuid> id, not by title (titles can legitimately differ
  // — we may show a JSONL-derived title where Desktop shows none, or vice
  // versa).
  if (!existsSync(GROUND_TRUTH_PATH)) {
    console.log(
      "\nSkipping ground-truth Active-list diff — no scripts/ground-truth.local.json on this machine (expected on a fresh checkout; see README for how to make one).",
    );
  } else {
    console.log("\nDiffing our Active list against Claude Desktop's sidebar ground truth…");
    const allDesktopRecords = await loadAllDesktopSessionRecords(desktopCache);
    const byLocalId = new Map(allDesktopRecords.map((r) => [r.localSessionId, r]));
    const allDesktopFilePaths = await findAllDesktopSessionFilePaths();
    const groundTruthSidebar = JSON.parse(await fsPromises.readFile(GROUND_TRUTH_PATH, "utf8")) as {
      localId: string;
      title: string;
    }[];

    let matched = 0;
    const missingFromOurs: string[] = [];
    for (const expected of groundTruthSidebar) {
      const record = byLocalId.get(expected.localId);
      if (!record) {
        // Two distinct reasons a local_<uuid>.json can fail to produce a
        // record: the file is simply gone, or it exists but has no
        // cliSessionId at all (readDesktopSessionInfo requires one, since
        // that's the only join key back to a .jsonl file — see below).
        const filePath = allDesktopFilePaths.find((p) => p.includes(expected.localId));
        const reason = filePath
          ? `file exists (${filePath}) but has no cliSessionId at all — can't join it to any .jsonl file`
          : "no local_*.json file exists for this id at all";
        missingFromOurs.push(`${expected.localId} (${expected.title}) — ${reason}`);
        continue;
      }
      const cliSession = sessions.find((s) => s.sessionId === record.cliSessionId);
      if (!cliSession) {
        missingFromOurs.push(
          `${expected.localId} (${expected.title}) — desktop record's cliSessionId=${record.cliSessionId} has no matching .jsonl file under ~/.claude/projects`,
        );
        continue;
      }
      const status = computeSessionStatus(cliSession, desktopIndex, conductorWorkspaces);
      if (status !== "active") {
        missingFromOurs.push(
          `${expected.localId} (${expected.title}) — found, but computed status is "${status}" not "active" (resolved title: ${cliSession.customTitle ?? cliSession.aiTitle ?? cliSession.firstPromptTitle})`,
        );
        continue;
      }
      matched++;
    }

    console.log(`Ground truth expects ${groundTruthSidebar.length} sidebar sessions; matched ${matched}.`);
    if (missingFromOurs.length > 0) {
      console.log("Expected-active sessions we did NOT mark active:");
      for (const line of missingFromOurs) console.log(`  - ${line}`);
    }

    const expectedCliIds = new Set(
      groundTruthSidebar.map((g) => byLocalId.get(g.localId)?.cliSessionId).filter((id): id is string => !!id),
    );
    const extraActive = ourActiveSessions.filter((s) => !expectedCliIds.has(s.sessionId));
    console.log(`\nSessions we marked Active but aren't in the ground-truth sidebar list: ${extraActive.length}`);
    for (const session of extraActive) {
      const title = session.customTitle ?? session.aiTitle ?? session.firstPromptTitle;
      const desktopInfo = desktopIndex[session.sessionId];
      console.log(
        `  - ${title}  (cliSessionId=${session.sessionId}, localSessionId=${desktopInfo?.localSessionId ?? "?"}, cwd=${session.cwd})`,
      );
    }
  }

  if (global.gc) global.gc();
  const heapUsedMb = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`\nHeap used after full CLI scan + desktop index load: ${heapUsedMb.toFixed(1)} MB`);
  const HEAP_LIMIT_MB = 200;
  if (heapUsedMb > HEAP_LIMIT_MB) {
    console.error(`FAIL: heap used ${heapUsedMb.toFixed(1)}MB exceeds the ${HEAP_LIMIT_MB}MB sanity limit`);
    process.exitCode = 1;
  } else {
    console.log(`OK: under the ${HEAP_LIMIT_MB}MB sanity limit.`);
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exitCode = 1;
});
