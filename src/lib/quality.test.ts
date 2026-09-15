import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  probeQuality,
  qualityCheckSteps,
  resetQualityProbeCache,
} from "./quality";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const CWD = "/repo";
const CAPABLE_HELP =
  "Usage: jscpd --baseline --baseline-from-ref --fail-on-new-clones --exitCode";
const CAPABLE_HELP_DASH =
  "Usage: jscpd --baseline --baseline-from-ref --fail-on-new-clones --exit-code";
const OLD_HELP = "Usage: jscpd --min-lines --min-tokens";

type ProbeMocks = {
  baseline?: boolean;
  /** `.jscpd.json` exists; its file content when set. */
  config?: string | null;
  precommit?: boolean;
  jscpd?: { code: number; output: string } | null;
  npx?: { code: number; output: string } | null;
  precommitOk?: boolean;
};

function mockProbe({
  baseline = false,
  config = null,
  precommit = false,
  jscpd = { code: 0, output: CAPABLE_HELP },
  npx = { code: 1, output: "" },
  precommitOk = true,
}: ProbeMocks = {}) {
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "stat_files")
      return Promise.resolve([
        { path: `${CWD}/.jscpd-baseline.json`, mtimeMs: baseline ? 1 : null },
        { path: `${CWD}/.jscpd.json`, mtimeMs: config != null ? 1 : null },
        {
          path: `${CWD}/.pre-commit-config.yaml`,
          mtimeMs: precommit ? 1 : null,
        },
      ]);
    if (command === "read_text_file") return Promise.resolve(config ?? "");
    if (command === "run_check") {
      const exec = (args as { steps: { exec: string }[] }).steps[0].exec;
      if (exec === "jscpd --help")
        return Promise.resolve(jscpd ?? { code: 1, output: "" });
      if (exec === "npx --yes jscpd --help")
        return Promise.resolve(npx ?? { code: 1, output: "" });
      if (exec === "pre-commit --version")
        return Promise.resolve({ code: precommitOk ? 0 : 1, output: "" });
      return Promise.resolve({ code: 0, output: "ok" });
    }
    // The test runner itself can tickle the mocked module — resolve instead
    // of asserting so an internal call never fails the test.
    return Promise.resolve({ code: 1, output: "" });
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  resetQualityProbeCache();
});

it("gates on the repo's committed baseline when present", async () => {
  mockProbe({ baseline: true });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([
    {
      exec: 'jscpd . --baseline ".jscpd-baseline.json" --fail-on-new-clones',
    },
  ]);
});

it("gates on an ephemeral HEAD baseline in a Git checkout", async () => {
  mockProbe();
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([
    { exec: "jscpd . --baseline-from-ref HEAD --fail-on-new-clones" },
  ]);
});

it("falls back to a strict exit code outside Git checkouts", async () => {
  mockProbe();
  const steps = await qualityCheckSteps(CWD, false);
  expect(steps).toEqual([{ exec: "jscpd . --exitCode 1" }]);
});

it("emits the --exit-code spelling the build advertises", async () => {
  mockProbe({ jscpd: { code: 0, output: CAPABLE_HELP_DASH } });
  const steps = await qualityCheckSteps(CWD, false);
  expect(steps).toEqual([{ exec: "jscpd . --exit-code 1" }]);
});

it("falls back to npx when jscpd is not installed", async () => {
  mockProbe({ jscpd: null, npx: { code: 0, output: CAPABLE_HELP } });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([
    { exec: "npx --yes jscpd . --baseline-from-ref HEAD --fail-on-new-clones" },
  ]);
});

it("lets a capable npx copy outrank an installed but old jscpd", async () => {
  mockProbe({
    jscpd: { code: 0, output: OLD_HELP },
    npx: { code: 0, output: CAPABLE_HELP },
  });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([
    { exec: "npx --yes jscpd . --baseline-from-ref HEAD --fail-on-new-clones" },
  ]);
});

it("skips a jscpd too old to gate rather than fail on old clones", async () => {
  mockProbe({ jscpd: { code: 0, output: OLD_HELP } });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([]);
});

it("lets a repo .jscpd.json baseline supply the new-clones gate", async () => {
  mockProbe({ config: '{ "baseline": ".jscpd-baseline.json" }' });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([{ exec: "jscpd . --fail-on-new-clones" }]);
});

it("adds the HEAD baseline to a repo .jscpd.json that names none", async () => {
  mockProbe({ config: '{ "threshold": 5 }' });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([
    { exec: "jscpd . --baseline-from-ref HEAD --fail-on-new-clones" },
  ]);
});

it("runs a repo .jscpd.json bare outside Git — its rules own the gate", async () => {
  mockProbe({ config: '{ "threshold": 5 }' });
  const steps = await qualityCheckSteps(CWD, false);
  expect(steps).toEqual([{ exec: "jscpd ." }]);
});

it("appends the repo's pre-commit hooks after the duplication gate", async () => {
  mockProbe({ precommit: true });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([
    { exec: "jscpd . --baseline-from-ref HEAD --fail-on-new-clones" },
    { exec: "pre-commit run --all-files" },
  ]);
});

it("never runs pre-commit outside a Git checkout", async () => {
  mockProbe({ jscpd: null, npx: null, precommit: true });
  const steps = await qualityCheckSteps(CWD, false);
  expect(steps).toEqual([]);
});

it("still runs pre-commit alone when jscpd is absent", async () => {
  mockProbe({ jscpd: null, npx: null, precommit: true });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([{ exec: "pre-commit run --all-files" }]);
});

it("emits nothing in an empty checkout", async () => {
  mockProbe({ jscpd: null });
  const steps = await qualityCheckSteps(CWD, true);
  expect(steps).toEqual([]);
});

it("caches probes per checkout until a config file changes", async () => {
  mockProbe();
  const first = await probeQuality(CWD);
  const second = await probeQuality(CWD);
  expect(second).toBe(first);
  const probes = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "run_check");
  expect(probes).toHaveLength(1);

  mockProbe({ baseline: true });
  const third = await probeQuality(CWD);
  expect(third.jscpdBaselineFile).toBe(true);
});

it("probe failures degrade to absent tools, never throw", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    command ? Promise.reject(new Error("backend gone")) : Promise.resolve(null),
  );
  const probe = await probeQuality(CWD);
  expect(probe).toEqual({
    jscpdBaselineFile: false,
    jscpdConfig: false,
    jscpdConfigBaseline: false,
    preCommit: false,
  });
});
