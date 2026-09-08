# Performance baseline (#3)

This is a partial baseline, not acceptance of the complete desktop workload.
Keep Windows, WSL and authenticated provider evidence separate. The benchmark
adds no production service, dependency, polling or schema migration.

## Repeatable storage workload

From a clean checkout, follow [local setup](LOCAL_DEVELOPMENT.md), then run:

```sh
npm ci
npm run check
npm run build
cargo test --release storage_baseline -- --ignored --nocapture
```

The ignored Rust test creates an exclusive temporary directory, three empty Git
repositories, a freshly migrated SQLite database with 3,000 histories (1,000 per
repository), and ten approximately 1 MB transcripts. Ordinary histories contain
1,024 repeated lines. It exercises the production project-list, transcript-load
and unsuccessful full-history-search functions. Fixture setup uses bulk SQL;
these measurements do not measure session writes, IPC, rendering or concurrency.
The list path includes the existing Git metadata cache and its cold misses.
One initial sample per operation is discarded; all remaining sorted samples,
median and maximum are printed. No credentials or model calls are involved.

The generated directory is removed after success. Set `MONOCODE_BENCH_KEEP=1`
before running to retain the disposable corpus; its exact path is printed.
Failures retain their directory for diagnosis. Never copy it over an existing
app profile. Neither this fixture nor a loaded saved transcript is a running agent.

`historyScale.test.ts` runs in ordinary web checks and verifies project isolation,
unique identities, live-session visibility and initial paging across a 3,000-row
history refresh. Existing covering-index and persistence tests remain the owning
regression checks. There are no hosted timing thresholds.

## Initial observations

Base `1ddb6e6ad1183497a6b753cae566f50826d414a3`, with benchmark-only changes;
macOS 26.6.2 arm64, Apple M5 Pro (15 cores), 24 GB RAM, Rust 1.98.1.
[Raw storage observations](performance/2026-09-08-storage.txt) record the release
test process, not application/WebView or agent/build-process memory.

| Operation | Samples | Median | Maximum |
| --- | ---: | ---: | ---: |
| List 1,000 summaries | 30 | 0.311 ms | 25.308 ms |
| Load approximately 1 MB transcript | 30 | 0.627 ms | 0.654 ms |
| Missing query across all histories | 10 | 77.846 ms | 78.395 ms |

For comparisons on this same machine/workload, investigate a repeatable median
increase over 25% across three runs. Also investigate list maxima exceeding 40 ms,
load maxima exceeding 2 ms or search maxima exceeding 125 ms across three runs.
These are provisional storage investigation budgets, not desktop acceptance
budgets. Retain outliers, record concurrent workstation load, and do not adjust
budgets to hide a failure. Search holds the database mutex during its scan; this
microbenchmark does not establish latency of competing writes.

The untouched base passed `npm run check`: 135 web files / 1,396 tests and 215
Rust tests, TypeScript, rustfmt and Clippy. `npm run build` passed with existing
Vite large-chunk and mixed-import warnings. Those warnings are not responsiveness
measurements.

## Required desktop continuation

Use an unsigned release app with a fresh Tauri identifier and fresh data directory.
Record exact commit/configuration, OS/toolchains, hardware, viewport and display
scale. Do not overwrite stock or existing fork profiles. Build instructions are
in [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).

1. In three disposable Git repositories, open ten synthetic streaming sessions
   through the actual provider/event path and twenty PTYs. Use bounded output
   (for example 200 lines at 50 ms intervals per PTY); do not spend model tokens
   for load. Separately run one authorized authenticated agent smoke.
2. Load the substantial history corpus, long transcripts and a large Git diff.
   Type without submitting, switch sessions during history refresh, scroll and
   resize during output, and inspect the diff while Git refresh is running.
3. Measure launch-to-usable-window and input/session-switch latency using native
   instrumentation or timestamped recordings. Report the measurement resolution.
   Observe foreground, hidden/minimized, idle and sustained output for at least
   five minutes each, then close the synthetic sessions and observe recovery.
4. Sample the exact app PID and attributable WebView helper PIDs. Record CPU,
   RSS (or named platform memory metric) and process count separately from agent,
   terminal and build children. Do not attribute every system WebKit process to
   this app. Preserve unrelated agents and applications.
5. Repeat three times, retain raw observations and define desktop budgets from
   the measured baseline. Record failure/recovery and disabled-feature idle work.

Still required: the actual ten-session/twenty-terminal streaming workload,
large-diff and refresh interaction evidence, startup/input/scroll/resize timings,
long-running aggregate resource/recovery observations, authenticated live smoke,
and native Windows evidence through [#28](https://github.com/kaceper11/monocode/issues/28).
WSL remains [#22](https://github.com/kaceper11/monocode/issues/22) acceptance.

### Native macOS smoke, 2026-09-08

Built `npm run tauri build -- --bundles app --config /tmp/monocode-3-isolated.conf.json`
with product name `MonoCode Benchmark` and fresh identifier
`com.kaceper11.monocode.benchmarkc42a59b1`. The ad-hoc signed release bundle launched
and quit alongside the already running stock app. This does not establish full
stock credential/update coexistence acceptance for #2.

After quitting the benchmark, SQLite's backup API copied the retained corpus into
its newly created database only after verifying that it had zero sessions. The
stock and regular fork databases were not used. Open Project selected the exact
disposable `project 0` directory. The sidebar loaded 1,000 histories with 32 initial
cards. Opening histories 2997 and 2994 displayed their synthetic transcripts;
typing unsent text in 2997, switching to 2994 and returning preserved that text.
The generator now canonicalizes temporary paths because the macOS picker resolves
`/var` to `/private/var`; mismatched fixture paths initially showed no histories.

The native terminal opened at the disposable repository prompt. However, computer
use focus/paste/type/key-event attempts did not visibly deliver even `echo 1`.
No command or output was observed. A designated tester must verify terminal input
and run the bounded PTY workload; this observation does not distinguish an app
input defect from an automation limitation. No agent prompt was submitted.
Numeric interaction latency, streaming agent load, twenty noisy terminals and
complete app/WebView resource attribution remain unverified. The app and disposable
profile are retained outside the repository; only the benchmark app is quit after
the smoke, leaving stock MonoCode running.

[Thirty one-second backend samples](performance/2026-09-08-native-backend.csv),
from `ps -p 75392 -o %cpu=,rss=`, observed 0.3–1.0% CPU (median 0.5%) and
128,992–129,024 KiB RSS with two saved transcripts and one idle terminal open.
This is a short backend-only observation, not an aggregate or sustained-load
budget. WebView helpers, terminal shell, agents and concurrent build processes
are excluded; no app-wide memory/performance claim follows from these numbers.

## Upstream checkpoint

Fetch `origin/main` and `upstream/main`; record both full SHAs and inspect their
diff. Create a separate temporary branch/worktree from fork main and run
`git merge --no-commit --no-ff <reviewed-upstream-sha>`. Record conflicts and the
staged diff, run web/Rust checks and a relevant build there, and exercise affected
visible behavior. Do not merge this trial into a feature PR. Preserve conflicts
and useful unmerged work for review. If no upstream commits are new, record the
comparison instead of inventing a merge.

Initial trial: fork `1ddb6e6ad1183497a6b753cae566f50826d414a3` and upstream
`464e95e27ee8f8000e417817877bd3963642c2ec`, in
`/tmp/monocode-3-upstream-checkpoint` on `trial/issue-3-upstream-checkpoint`.
The uncommitted merge had no conflicts: only CHANGELOG.md, src/index.css and
src/surfaces/PaneTree.tsx changed (18 additions, one deletion). Upstream adds
code-block theme binding and shared split-chat background positioning; neither
duplicates the benchmark. Web checks (1,396 tests and TypeScript) and web build
passed. Rust formatting, Clippy and all 215 Rust tests also passed using the
existing local target cache. Visual compatibility remains unverified; a clean
textual merge does not prove it. #27 owns later checkpoints.
