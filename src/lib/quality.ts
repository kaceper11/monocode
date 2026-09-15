import { invoke } from "@tauri-apps/api/core";
import { readTextFile, statFiles } from "./fs";
import { joinPath } from "./paths";

/**
 * Built-in quality checks — the "Quality checks" sentinel command on
 * checks-on-finish. Instead of a saved command, the checkout's own quality
 * tooling is detected at run time and compiled into check steps:
 *
 * - jscpd — the duplication gate. A committed `.jscpd-baseline.json` wins;
 *   a `.jscpd.json` naming a baseline supplies it instead; otherwise an
 *   ephemeral `HEAD` baseline fails the run only on clones the turn
 *   introduced; outside Git checkouts it degrades to a strict
 *   `--exit-code 1` gate.
 * - pre-commit — the repo's own hooks, run over the whole tree.
 *
 * Probes execute where the check will run (`run_check` is WSL-aware), and
 * `jscpd --help` output doubles as the capability probe — gating flags are
 * emitted only when the installed version understands them. An installed
 * jscpd too old to gate on new clones must not shadow a capable npx copy,
 * so both are probed and the first capable one wins; a runnable but
 * incapable jscpd only ever emits the non-Git strict gate.
 */

export const QUALITY_COMMAND_NAME = "Quality checks";

const JSCPD_BASELINE = ".jscpd-baseline.json";
const JSCPD_CONFIG = ".jscpd.json";
const PRECOMMIT_CONFIG = ".pre-commit-config.yaml";

/** `--help` on an installed binary is cheap; `npx --yes` may download the
 * package on first run, so it gets the generous timeout. */
const QUICK_PROBE_TIMEOUT_SECS = 15;
const DOWNLOAD_PROBE_TIMEOUT_SECS = 90;

/** Probe results cache per checkout, keyed on the config-file mtimes so a
 * config change invalidates instantly. The short TTL covers a tool being
 * installed mid-session; without it every finished turn would pay three
 * subprocess spawns before the check itself. */
const PROBE_CACHE_TTL_MS = 5 * 60_000;
const PROBE_CACHE_MAX = 50;

type JscpdProbe = {
  /** Working invocation — `jscpd` or `npx --yes jscpd`. */
  exe: string;
  /** Understands --fail-on-new-clones. */
  newClones: boolean;
  /** Understands --baseline-from-ref. */
  fromRef: boolean;
  /** The `--exit-code`/`--exitCode` spelling this build advertises, "" when
   * unsupported — emitted verbatim so either dialect works. */
  exitCode: string;
};

export type QualityProbe = {
  jscpd?: JscpdProbe;
  /** `.jscpd-baseline.json` is present in the checkout. */
  jscpdBaselineFile: boolean;
  /** `.jscpd.json` exists — the repo owns jscpd's settings (reporters,
   * ignore, thresholds), so CLI flags are limited to the new-clones gate. */
  jscpdConfig: boolean;
  /** The repo config itself names `baseline`/`baselineFromRef` — passing
   * our own baseline flags would conflict. */
  jscpdConfigBaseline: boolean;
  /** `.pre-commit-config.yaml` exists and `pre-commit` runs. */
  preCommit: boolean;
};

export type QualityStep = { exec: string };

type ProbeResult = { code: number | null; output: string };

async function probeCommand(
  cwd: string,
  exec: string,
  timeoutSecs: number,
): Promise<ProbeResult | null> {
  try {
    return await invoke<ProbeResult>("run_check", {
      cwd,
      steps: [{ exec }],
      timeoutSecs,
    });
  } catch {
    return null;
  }
}

/** Prefer a `--fail-on-new-clones`-capable jscpd: an installed but old one
 * can't gate on turn-introduced clones, so npx's (fresh) copy outranks it.
 * A runnable-but-old jscpd is kept as the non-Git strict-gate fallback. */
async function probeJscpd(cwd: string): Promise<JscpdProbe | undefined> {
  let fallback: JscpdProbe | undefined;
  for (const [exe, timeoutSecs] of [
    ["jscpd", QUICK_PROBE_TIMEOUT_SECS],
    ["npx --yes jscpd", DOWNLOAD_PROBE_TIMEOUT_SECS],
  ] as const) {
    const help = await probeCommand(cwd, `${exe} --help`, timeoutSecs);
    if (!help || help.code !== 0) continue;
    const probe: JscpdProbe = {
      exe,
      newClones: help.output.includes("--fail-on-new-clones"),
      fromRef: help.output.includes("--baseline-from-ref"),
      exitCode: help.output.includes("--exit-code")
        ? "--exit-code"
        : help.output.includes("--exitCode")
          ? "--exitCode"
          : "",
    };
    if (probe.newClones) return probe;
    fallback ??= probe;
  }
  return fallback;
}

const probeCache = new Map<
  string,
  { key: string; at: number; probe: QualityProbe }
>();

/** Test hook — cache entries are per checkout and TTL'd, but tests share
 * the cwd fixture. */
export function resetQualityProbeCache(): void {
  probeCache.clear();
}

/** What's runnable in `cwd`. Every probe is best-effort — a tool that
 * fails to answer simply isn't offered, never errors the run. */
export async function probeQuality(cwd: string): Promise<QualityProbe> {
  const stats = await statFiles([
    joinPath(cwd, JSCPD_BASELINE),
    joinPath(cwd, JSCPD_CONFIG),
    joinPath(cwd, PRECOMMIT_CONFIG),
  ]).catch(() => []);
  const baselineMs = stats[0]?.mtimeMs ?? null;
  const configMs = stats[1]?.mtimeMs ?? null;
  const preCommitMs = stats[2]?.mtimeMs ?? null;

  const cacheKey = `${baselineMs}|${configMs}|${preCommitMs}`;
  const cached = probeCache.get(cwd);
  if (
    cached &&
    cached.key === cacheKey &&
    Date.now() - cached.at < PROBE_CACHE_TTL_MS
  )
    return cached.probe;

  const [jscpd, configText, preCommit] = await Promise.all([
    probeJscpd(cwd),
    configMs != null
      ? readTextFile(joinPath(cwd, JSCPD_CONFIG)).catch(() => "")
      : Promise.resolve(""),
    preCommitMs != null
      ? probeCommand(cwd, "pre-commit --version", QUICK_PROBE_TIMEOUT_SECS)
          .then((result) => result?.code === 0)
          .catch(() => false)
      : Promise.resolve(false),
  ]);

  const probe: QualityProbe = {
    jscpd,
    jscpdBaselineFile: baselineMs != null,
    jscpdConfig: configMs != null,
    jscpdConfigBaseline: /"baseline(FromRef)?"\s*:/.test(configText),
    preCommit,
  };
  probeCache.set(cwd, { key: cacheKey, at: Date.now(), probe });
  if (probeCache.size > PROBE_CACHE_MAX)
    probeCache.delete(probeCache.keys().next().value!);
  return probe;
}

/** The check's step list for `probe` — empty when nothing runnable gates. */
export function qualitySteps(
  probe: QualityProbe,
  isGit: boolean,
): QualityStep[] {
  const steps: QualityStep[] = [];
  if (probe.jscpd) {
    const { exe } = probe.jscpd;
    const gate =
      probe.jscpdBaselineFile && probe.jscpd.newClones
        ? `--baseline "${JSCPD_BASELINE}" --fail-on-new-clones`
        : probe.jscpdConfigBaseline && probe.jscpd.newClones
          ? // The repo config supplies the baseline — only gate on new clones.
            "--fail-on-new-clones"
          : isGit && probe.jscpd.fromRef && probe.jscpd.newClones
            ? "--baseline-from-ref HEAD --fail-on-new-clones"
            : !probe.jscpdConfig && !isGit && probe.jscpd.exitCode
              ? // No VCS baseline exists — a flat clone-count gate is all
                // that is possible. (A repo .jscpd.json owns its own
                // thresholds instead.)
                `${probe.jscpd.exitCode} 1`
              : "";
    // A .jscpd.json with no baseline keys keeps full control — run it bare
    // rather than force flags that could conflict with its settings.
    if (gate || probe.jscpdConfig)
      steps.push({ exec: `${exe} .${gate ? ` ${gate}` : ""}` });
  }
  // pre-commit only operates on Git checkouts.
  if (probe.preCommit && isGit)
    steps.push({ exec: "pre-commit run --all-files" });
  return steps;
}

/** Probe + steps in one — the quality check's run-time command body. */
export async function qualityCheckSteps(
  cwd: string,
  isGit: boolean,
): Promise<QualityStep[]> {
  return qualitySteps(await probeQuality(cwd), isGit);
}
