// Bounded feasibility experiment, not a MonoCode runtime or provider adapter.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const script = fileURLToPath(import.meta.url);
const [mode, root, runId] = process.argv.slice(2);

if (mode === "launcher") {
  const child = spawn(process.execPath, [script, "worker", root, runId], {
    detached: true, stdio: "ignore",
  });
  child.unref();
} else if (mode === "worker") {
  // Finite producer: at most 100 small records at 25 ms intervals.
  const log = join(root, "events.jsonl");
  for (let sequence = 0; sequence < 100; sequence++) {
    const cancel = join(root, "cancel");
    if (fs.existsSync(cancel) && fs.readFileSync(cancel, "utf8") === runId) break;
    fs.appendFileSync(log, JSON.stringify({ runId, host: "local", sequence }) + "\n");
    await delay(25);
  }
  fs.writeFileSync(join(root, "done.tmp"), runId);
  fs.renameSync(join(root, "done.tmp"), join(root, "done"));
} else {
  test("bounded owner survives launcher exit, replays after detach and acknowledges cancellation", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "monocode-boundary-"));
    const identity = randomUUID();
    const log = join(dir, "events.jsonl");
    function read(expectedIdentity) {
      if (!fs.existsSync(log)) return [];
      const bytes = fs.readFileSync(log, "utf8");
      assert.ok(Buffer.byteLength(bytes) < 32 * 1024);
      // A concurrent last append may be incomplete; replay only whole records.
      const events = bytes.split("\n").slice(0, -1).map(line => JSON.parse(line));
      events.forEach((event, index) => {
        assert.equal(event.runId, expectedIdentity);
        assert.equal(event.host, "local");
        assert.equal(event.sequence, index);
      });
      return events;
    }
    async function until(predicate) {
      const deadline = performance.now() + 5000;
      while (!predicate()) {
        assert.ok(performance.now() < deadline, "bounded worker did not acknowledge in 5 seconds");
        await delay(25);
      }
    }
    try {
      // execFileSync returns only after the launcher has exited. The worker's
      // handles are not inherited by this observer; output continues on disk.
      execFileSync(process.execPath, [script, "launcher", dir, identity], { timeout: 5000 });
      await until(() => read(identity).length >= 2);
      const cursor = read(identity).length;
      await delay(150); // no observer attached during this interval
      const reconnected = read(identity);
      assert.ok(reconnected.length > cursor);
      assert.equal(reconnected.slice(cursor)[0].sequence, cursor);
      assert.throws(() => read("wrong-run"), /AssertionError/);
      fs.writeFileSync(join(dir, "cancel"), "wrong-run");
      await until(() => read(identity).length > reconnected.length);
      fs.writeFileSync(join(dir, "cancel"), identity);
      fs.writeFileSync(join(dir, "cancel"), identity); // duplicate cancellation
      await until(() => fs.existsSync(join(dir, "done")));
      assert.equal(fs.readFileSync(join(dir, "done"), "utf8"), identity);
      const final = read(identity).length;
      await delay(75);
      assert.equal(read(identity).length, final);
      assert.ok(final < 100, "cancellation must stop the producer before its natural limit");
      console.log(`local-only trial: launcher exited; replay cursor ${cursor}; ${final} ordered events; cancellation acknowledged`);
    } finally {
      fs.writeFileSync(join(dir, "cancel"), identity);
      // Never kill a PID or remove files beneath a producer still using them.
      // Failure keeps only this exclusive, bounded disposable directory.
      if (fs.existsSync(join(dir, "done"))) fs.rmSync(dir, { recursive: true });
      else console.error(`trial directory retained: ${dir}`);
    }
  });
}
