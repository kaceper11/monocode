# Shared streaming and lifecycle follow-up

Validation date: 2026-09-15. Worktree: `agent-harness-reliability`, branch `perf/agent-harness-reliability`.

## What changed

- Both normal event flushes and immediate approval/question flushes use `applyHarnessEvents`. Consecutive assistant or reasoning chunks merge in their original order with at most two transcript-array copies per run, instead of one per changed chunk. Runs stop at every other event. Single-event batches retain the original reducer fast path.
- Stream joining still uses the existing token/snapshot rules against accumulated text. Approval, question, tool, completion and failure events keep their original ordering; no additional buffering delay was added.
- Repeated status detection scans backwards without copying/reversing the transcript. Appending a block reuses the array already copied to seal the preceding stream.
- The registry now counts pending warmup, compaction and steering operations as well as normal sends. An idle timer armed by an overlapping operation cannot stop a child that is still working. Explicit Stop/Cancel still uses the existing provider methods; children still park after the final operation settles.

## Measured reducer cost

Apple M5 Pro, 24 GiB RAM, macOS (Darwin 25.6.0), Node 26.8.1. The script bundles the production reducer with esbuild minification and production mode. It compares the previous sequential event-reduction path with the new batch path using identical input. Each row processes 1,024 text chunks over an existing transcript; times are milliseconds for all 1,024 chunks, **not per chunk**. Twenty samples per variant, eight repetitions per sample, ten warmup pairs, alternating before/after order. Raw samples: [CSV](streaming-latency.csv).

| Existing blocks | Chunks per flush | Sequential, ms | Batched, ms | Reduction |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 0.120 | 0.120 | -0.7% |
| 100 | 8 | 0.113 | 0.084 | 26.0% |
| 100 | 32 | 0.105 | 0.070 | 33.6% |
| 100 | 128 | 0.102 | 0.067 | 34.4% |
| 1,000 | 1 | 0.259 | 0.255 | 1.6% |
| 1,000 | 8 | 0.250 | 0.120 | 52.0% |
| 1,000 | 32 | 0.252 | 0.077 | 69.5% |
| 1,000 | 128 | 0.250 | 0.068 | 72.9% |
| 5,000 | 1 | 0.956 | 0.953 | 0.4% |
| 5,000 | 8 | 0.959 | 0.303 | 68.4% |
| 5,000 | 32 | 0.950 | 0.127 | 86.6% |
| 5,000 | 128 | 0.950 | 0.084 | 91.2% |

These are production-bundled **Node reducer microbenchmarks**, not a release Tauri/WebView or provider benchmark. Single-event differences are small (within 2% here). Larger bursts reduce allocations and CPU, but even the 5,000-block test saves less than a millisecond per 1,024 chunks. This does not establish faster model generation or explain a twofold end-to-end delay. The earlier [checkpoint optimization](checkpoint-latency.md) remains the measured seconds-scale pre-send improvement for large dirty worktrees.

## Validation

- `npm run check`: 2,966 web tests passed, 2 skipped; TypeScript passed. Rust formatting and Clippy passed; 439 Rust tests passed, 3 ignored.
- Batch regressions compare with the sequential reducer for every harness, four initial transcript states, and batch sizes 1–30. They check immutable input, snapshot replacement, repeated tokens, Markdown whitespace, reasoning, tool cancellation, approvals, questions, completion and errors at every flush.
- The actual React session-state regression interleaves three submissions and provider batches before a render; every user message and answer remains present.
- Three idle-parking cases reproduced premature child shutdown before the guard was extended. Warmup, compaction and steering cases now pass, as do existing failure/parking checks.
- Isolated macOS release app **MonoCode Harness Check** rebuilt successfully (`com.kaceper11.monocode.harnesscheck`); existing app installation/data were not replaced. Build success does not establish native interaction acceptance.
- No provider settings, prompts, approval policy, schema, credentials or dependencies changed.

Commands:

```sh
NODE_OPTIONS=--no-experimental-webstorage node scripts/benchmark-harness-streaming.mjs /tmp/monocode-streaming-benchmark.json
NODE_OPTIONS=--no-experimental-webstorage npm run check
```

## Other paths examined

Catalog refresh already coalesces pending discovery by provider and execution scope in `refreshModelCatalog`. Binary resolution already caches login-shell environment and expensive identity verdicts. Hidden transcript panes already skip prop-driven renders, and Markdown components are memoized. Additional duplicate caches or broader lifecycle replacements were unnecessary.

Fresh-session startup still follows preparation. Starting provider sessions earlier could overlap that work, but requires proving cancellation, failed-preparation recovery and provider-created session behavior before changing it. Existing prewarming of resumable sessions is retained.

Native macOS UI latency, interactive CLI parity, WebView CPU/paint costs, Windows/WSL and authenticated Copilot remain unverified. These results establish shared reducer behavior and the idle-parking fix; they do not establish flawless behavior for every live provider.
