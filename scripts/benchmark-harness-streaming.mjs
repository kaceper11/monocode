// Production-bundled reducer benchmark; excludes provider, IPC and DOM time.
// Run: node scripts/benchmark-harness-streaming.mjs [output.json]
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const temporary = await mkdtemp(join(tmpdir(), "monocode-streaming-"));
try {
  const bundle = join(temporary, "reducer.mjs");
  await build({
    stdin: {
      contents:
        'export { applyHarnessEvent, applyHarnessEvents } from "./src/lib/harness/apply"; export { newSession } from "./src/lib/session";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const { applyHarnessEvent, applyHarnessEvents, newSession } = await import(
    pathToFileURL(bundle)
  );
  const events = Array.from({ length: 1024 }, (_, i) => ({
    type: "message.delta",
    text: ` ${i % 97}.`,
  }));
  const rows = [];
  let checksum = 0;
  for (const historySize of [100, 1000, 5000]) {
    const session = newSession("codex", "/tmp");
    session.blocks = Array.from({ length: historySize }, (_, i) => ({
      id: `history-${i}`,
      role: i % 2 ? "assistant" : "user",
      text: "Completed message. ".repeat(20),
    }));
    session.blocks.push({
      id: "current",
      role: "assistant",
      text: "Answer:",
      streaming: true,
    });
    for (const batchSize of [1, 8, 32, 128]) {
      const batches = [];
      for (let i = 0; i < events.length; i += batchSize)
        batches.push(events.slice(i, i + batchSize));
      const run = (mode) => {
        const start = performance.now();
        for (let repeat = 0; repeat < 8; repeat += 1) {
          let current = session;
          for (const batch of batches)
            current =
              mode === "before"
                ? batch.reduce(applyHarnessEvent, current)
                : applyHarnessEvents(current, batch);
          checksum += current.blocks.at(-1).text.length;
        }
        return (performance.now() - start) / 8;
      };
      for (let warmup = 0; warmup < 10; warmup += 1) {
        run("before");
        run("after");
      }
      for (let sample = 0; sample < 20; sample += 1) {
        for (const mode of sample % 2
          ? ["after", "before"]
          : ["before", "after"]) {
          rows.push({
            historySize,
            batchSize,
            sample,
            mode,
            durationMs: run(mode),
          });
        }
      }
    }
  }
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = [];
  for (const historySize of [100, 1000, 5000]) {
    for (const batchSize of [1, 8, 32, 128]) {
      const samples = rows.filter(
        (row) => row.historySize === historySize && row.batchSize === batchSize,
      );
      const before = median(
        samples
          .filter((row) => row.mode === "before")
          .map((row) => row.durationMs),
      );
      const after = median(
        samples
          .filter((row) => row.mode === "after")
          .map((row) => row.durationMs),
      );
      summary.push({
        historySize,
        batchSize,
        beforeMs: before,
        afterMs: after,
        reductionPercent: (1 - after / before) * 100,
      });
    }
  }
  const result = {
    hardware: cpus()[0]?.model,
    memoryGiB: totalmem() / 1024 ** 3,
    platform: process.platform,
    os: release(),
    node: process.version,
    events: events.length,
    samples: 20,
    checksum,
    summary,
    rows,
  };
  if (process.argv[2])
    await writeFile(
      resolve(process.argv[2]),
      JSON.stringify(result, null, 2) + "\n",
    );
  console.table(summary);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
