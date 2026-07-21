/**
 * Synthetic memory-safety stress test for the data layer (src/lib/sessions.ts).
 *
 * This exists because of a real crash report: on a machine with a large
 * `~/.claude/projects` history, the extension died immediately with "Worker
 * terminated due to reaching memory limit: JS heap out of memory". We have no
 * access to that machine, so instead of tuning against one dataset, this
 * generates a synthetic worst case — many large `.jsonl` files, some with a
 * single enormous line (simulating a huge embedded tool result) — and proves
 * `scanAllSessions()` gets through all of it under a deliberately small,
 * capped V8 heap. If the scanner regresses to materializing whole files or
 * whole lines in memory, or goes back to unbounded concurrency, this is
 * designed to reproduce the crash.
 *
 * Never touches `~/.claude` — fixtures are generated in a throwaway directory
 * (passed as `argv[2]`, the caller's own scratch space) and deleted after.
 *
 * Usage (three separate process invocations — generation and cleanup run
 * under a normal heap; only the scan itself runs under the small cap that
 * matters):
 *
 *   npx tsx scripts/stress-test.ts generate <fixtureDir>
 *   NODE_OPTIONS="--max-old-space-size=256" npx tsx scripts/stress-test.ts scan <fixtureDir>
 *   npx tsx scripts/stress-test.ts cleanup <fixtureDir>
 */
import { createWriteStream, promises as fs } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getHeapStatistics } from "v8";
import { InMemoryCache, scanAllSessions } from "../src/lib/sessions";

const PROJECT_COUNT = 5;
const FILES_PER_PROJECT = 6; // 30 files total
const MIN_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const HUGE_LINE_MIN_BYTES = 5 * 1024 * 1024;
const HUGE_LINE_MAX_BYTES = 10 * 1024 * 1024;

/** A single ~2KB block of filler text, reused (not regenerated) to keep generation fast. */
const FILLER_BLOCK = "The quick brown fox jumps over the lazy dog. ".repeat(45); // ~2.1KB

function fillerOfLength(length: number): string {
  if (length <= FILLER_BLOCK.length) return FILLER_BLOCK.slice(0, length);
  const repeats = Math.ceil(length / FILLER_BLOCK.length);
  return FILLER_BLOCK.repeat(repeats).slice(0, length);
}

async function writeLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
  const ok = stream.write(line + "\n");
  if (!ok) {
    await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
  }
}

async function generateFixtureFile(filePath: string, targetBytes: number, includeHugeLine: boolean): Promise<void> {
  const stream = createWriteStream(filePath);
  const timestamp = new Date().toISOString();

  // First line carries the fields parseHead() needs (cwd in particular) so
  // the file is treated as a real, resumable session and scanFullFile() is
  // actually exercised end to end — not short-circuited by a missing cwd.
  await writeLine(
    stream,
    JSON.stringify({
      type: "user",
      cwd: `/fake/stress-test/${filePath}`,
      gitBranch: "main",
      slug: "stress-test",
      entrypoint: "cli",
      version: "1.0.0",
      timestamp,
      message: { role: "user", content: "Fake prompt for the memory stress test." },
    }),
  );

  let bytesWritten = 0;
  let messageIndex = 0;
  const messageLineTemplate = (role: "user" | "assistant", text: string) =>
    JSON.stringify({
      type: role,
      isSidechain: false,
      timestamp,
      message: { role, content: text },
    });

  if (includeHugeLine) {
    const hugeLineBytes = HUGE_LINE_MIN_BYTES + Math.floor(Math.random() * (HUGE_LINE_MAX_BYTES - HUGE_LINE_MIN_BYTES));
    const hugeLine = messageLineTemplate("assistant", fillerOfLength(hugeLineBytes));
    await writeLine(stream, hugeLine);
    bytesWritten += hugeLine.length + 1;
    messageIndex++;
  }

  // Pad the rest of the file with moderate-size (~2KB) alternating messages.
  while (bytesWritten < targetBytes) {
    const role = messageIndex % 2 === 0 ? "user" : "assistant";
    const line = messageLineTemplate(role, fillerOfLength(2000));
    await writeLine(stream, line);
    bytesWritten += line.length + 1;
    messageIndex++;
  }

  await writeLine(stream, JSON.stringify({ type: "custom-title", customTitle: `Stress fixture ${filePath}` }));

  await new Promise<void>((resolve, reject) => {
    stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
}

async function generate(fixtureDir: string): Promise<void> {
  console.log(`Generating synthetic fixtures under ${fixtureDir} …`);
  const start = performance.now();
  let fileCount = 0;
  for (let p = 0; p < PROJECT_COUNT; p++) {
    const projectDir = join(fixtureDir, `-fake-project-${p}`);
    await fs.mkdir(projectDir, { recursive: true });
    for (let f = 0; f < FILES_PER_PROJECT; f++) {
      const targetBytes = MIN_FILE_BYTES + Math.floor(Math.random() * (MAX_FILE_BYTES - MIN_FILE_BYTES));
      const includeHugeLine = f % 3 === 0; // every third file gets a 5-10MB single line
      const filePath = join(projectDir, `${randomUUID()}.jsonl`);
      await generateFixtureFile(filePath, targetBytes, includeHugeLine);
      fileCount++;
      console.log(
        `  [${fileCount}/${PROJECT_COUNT * FILES_PER_PROJECT}] ${filePath} (~${(targetBytes / 1024 / 1024).toFixed(0)}MB${includeHugeLine ? ", +huge line" : ""})`,
      );
    }
  }
  const elapsedS = (performance.now() - start) / 1000;
  console.log(`Done generating ${fileCount} fixture files in ${elapsedS.toFixed(1)}s.`);
}

async function scan(fixtureDir: string): Promise<void> {
  const heapLimitMb = getHeapStatistics().heap_size_limit / 1024 / 1024;
  console.log(`Scanning synthetic fixtures under ${fixtureDir} (V8 old-space limit: ${heapLimitMb.toFixed(0)}MB) …`);
  const cache = new InMemoryCache();
  const start = performance.now();
  const sessions = await scanAllSessions(cache, fixtureDir);
  const elapsedS = (performance.now() - start) / 1000;

  if (global.gc) global.gc();
  const heapUsedMb = process.memoryUsage().heapUsed / 1024 / 1024;
  const rssMb = process.memoryUsage().rss / 1024 / 1024;

  console.log(`Scanned ${sessions.length} synthetic sessions in ${elapsedS.toFixed(1)}s.`);
  console.log(`Peak-ish heap used: ${heapUsedMb.toFixed(1)}MB, RSS: ${rssMb.toFixed(1)}MB (heap limit was ${heapLimitMb.toFixed(0)}MB).`);

  const expectedCount = PROJECT_COUNT * FILES_PER_PROJECT;
  if (sessions.length !== expectedCount) {
    console.error(`FAIL: expected ${expectedCount} sessions, got ${sessions.length}.`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS: scanAllSessions() completed over ~2GB of synthetic fixtures without running out of heap.");
}

async function cleanup(fixtureDir: string): Promise<void> {
  console.log(`Removing fixtures at ${fixtureDir} …`);
  await fs.rm(fixtureDir, { recursive: true, force: true });
  console.log("Done.");
}

async function main() {
  const [, , mode, fixtureDirArg] = process.argv;
  if (!mode || !fixtureDirArg) {
    console.error("Usage: tsx scripts/stress-test.ts <generate|scan|cleanup> <fixtureDir>");
    process.exitCode = 1;
    return;
  }
  const fixtureDir = fixtureDirArg;

  if (mode === "generate") await generate(fixtureDir);
  else if (mode === "scan") await scan(fixtureDir);
  else if (mode === "cleanup") await cleanup(fixtureDir);
  else {
    console.error(`Unknown mode "${mode}". Expected generate|scan|cleanup.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Stress test failed:", error);
  process.exitCode = 1;
});
