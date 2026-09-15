# Checkpoint latency reduction

This optimization removes measured pre-send work shared by structured-chat harnesses. It follows the adapter comparison, which showed no consistent provider-response speedup.

## Release-mode measurements

Apple M5 Pro, 24 GiB RAM, macOS 26.6.2. Ten samples per case/version. Actual optimized Rust `CheckpointStore::exclusive` + `ensure`, native Git and filesystem IO, disposable repositories. Modified/untracked files are about 44 KiB each. The same fixture ran in separately saved before/after test binaries; no builds ran during the final measurements. A preliminary baseline was also repeated after the optimized run to check that the improvement persisted.

| Working tree | Before, median | After, median | Time removed | Reduction |
| --- | ---: | ---: | ---: | ---: |
| clean | 58.3 ms | 36.4 ms | 21.9 ms | 37.5% |
| 50-dirty | 523.2 ms | 50.9 ms | 472.2 ms | 90.3% |
| 250-dirty | 2392.0 ms | 69.0 ms | 2323.0 ms | 97.1% |
| 250-untracked | 2273.4 ms | 63.4 ms | 2210.0 ms | 97.2% |

Existing-checkpoint calls remained below 1 ms in all measured samples. The improvement applies when the checkpoint is first created or recreated after clearing review state; it does not accelerate model generation or claim the same savings for every message. Prompt/attachment preparation can overlap this work, so end-to-end savings depend on which finishes last.

## Implementation

- Checkpoint creation requests changed paths instead of full diff statistics, branch metadata and untracked line counts. The Changes panel retains its existing statistics path.
- One scoped HEAD listing replaces one `git cat-file` call per checkpoint file. Membership is retained only for the bounded checkpoint candidate set. A failed listing falls back to the old per-file check.
- The existing snapshot writes, checkpoint limit, host/session ordering and wait-before-agent-dispatch remain in place. Relative paths also work when the selected working directory is a repository subfolder.
- Git operations continue through the existing native/WSL dispatcher. No model, reasoning, approval or sandbox settings changed.

## Validation

Checkpoint tests cover snapshot/Undo ownership, external modifications, staged/unstaged/untracked/deleted/renamed paths, kept-local exclusion, Unicode/subfolder paths and unborn HEAD. Full `npm run check` passed: 2,961 web tests (two opt-in skips), TypeScript, Rust formatting/Clippy, and 439 Rust tests (three ignored).

The isolated macOS release bundle (`MonoCode Harness Check.app`) also built successfully with the optimization.

The test invokes the actual native backend function used by `beginSessionTurn`; it excludes IPC/WebView rendering. Native app end-to-end latency, tool-heavy workloads and live Windows/WSL remain unverified. These are stage timings, not an asserted whole-response speedup.

[Raw measurements](checkpoint-latency.csv). Reproduce on each revision using:

```sh
MONOCODE_CHECKPOINT_BENCH_JSON=/tmp/checkpoint.json cargo test --release -p monocode checkpoint_send_latency_benchmark -- --ignored --nocapture
```
