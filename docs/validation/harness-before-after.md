# Harness before/after measurements

Date: 2026-09-15. Baseline: original main base `348c22e07723c32cd683483eb07e58952e08e88b`. After: uncommitted `perf/agent-harness-reliability` worktree. Current main had advanced and was deliberately excluded from this comparison.

## Result

These samples do not establish a consistent speedup: every available paired first-content interval includes zero, and local dispatch overhead is essentially unchanged. This patch's demonstrated benefit is reliability. All ten baseline Codex warm prompts failed with the unsupported `default` model error; all ten patched warm prompts succeeded. Muse and Devin completed all measured prompts on both versions.

The later [checkpoint optimization](checkpoint-latency.md) reduces backend pre-send latency; that stage was excluded from this adapter benchmark.

## Method

- Apple M5 Pro, 24 GiB RAM, macOS 26.6.2; Muse 1.3.0-R3057.1, Devin 3000.10.27, Codex 0.154.0. Muse updated since the earlier smoke run; both sides of this comparison use 1.3.0.
- Ten before/after pairs per installed provider. Order alternates each pair. Providers run serially, with no builds launched during measurement. Other workstation activity was not controlled.
- Each run starts a fresh host/session, sends one cold prompt, then one warm follow-up. The two sides share a disposable Git workspace and identical prompts, Default model selection, empty model settings, supervised mode, and existing authenticated account. Provider defaults were not downgraded for speed.
- Both sides run the byte-identical opt-in test through Vitest. Actual provider executables and stdio run locally. Tauri binary discovery, bridge, WebView, React and Git checkpoints are outside this measurement boundary. This is not a full release-app benchmark.
- Prompt requests a fixed marker and forbids tools, commands and file changes; any approval request is denied. Only successful responses contribute to latency medians. Failures are counted separately.
- Muse warm prompts wait for the previous actual host terminal event on both sides. Baseline adapter settlement occurs early; comparing that directly with patched settlement would compare different meanings of completion.

## First answer latency

Medians; before → after. Cold includes process startup and protocol initialization. Warm starts from an idle existing host.

| Provider | Cold first content | Warm first content | Successful prompts before → after |
| --- | ---: | ---: | ---: |
| Muse | 1.81 s → 2.05 s | 2.28 s → 2.12 s | 20/20 → 20/20 |
| Devin | 2.57 s → 2.25 s | 1.69 s → 1.63 s | 20/20 → 20/20 |
| Codex | 6.80 s → 6.82 s | — → 3.01 s | 10/20 → 20/20 |
| Copilot | Unavailable | Unavailable | CLI not installed |

## Local request dispatch

Median time from adapter submission to provider request write, in milliseconds. Includes native startup for cold prompts. Failed responses are excluded.

| Provider | Cold before → after | Warm before → after |
| --- | ---: | ---: |
| Muse | 212.770 ms → 211.215 ms | 0.155 ms → 0.105 ms |
| Devin | 78.067 ms → 79.678 ms | 0.112 ms → 0.079 ms |
| Codex | 89.286 ms → 92.498 ms | — → 0.151 ms |

## Variability

Paired first-content difference (after minus before), median and exploratory 95% bootstrap interval. Negative means faster after. Ten thousand resamples of paired differences, fixed seed 42; ten pairs are a small sample, not a universal performance guarantee.

| Provider / condition | Paired median difference | Bootstrap interval | Successful pairs |
| --- | ---: | ---: | ---: |
| Muse / cold | +0.11 s | -0.25 to +0.47 s | 10 |
| Muse / warm | -0.08 s | -0.32 to +0.73 s | 10 |
| Devin / cold | -0.36 s | -0.65 to +0.27 s | 10 |
| Devin / warm | +0.05 s | -0.40 to +0.37 s | 10 |
| Codex / cold | +0.03 s | -1.67 to +1.13 s | 10 |

## Completion semantics

| Muse condition | Adapter settlement before → after | Actual host terminal before → after |
| --- | ---: | ---: |
| Cold | 1.81 s → 14.74 s | 12.56 s → 14.74 s |
| Warm | 2.29 s → 14.01 s | 10.28 s → 14.01 s |

The patched adapter kept Muse busy through its real terminal event when these numbers were recorded — a correctness change, not evidence of slower answer generation. Settlement has since moved earlier: the adapter now resolves the visible turn at drain detection (only bookkeeping children remain) while the host still owns the terminal event, so the "after" settled medians above predate that change. The UI queue and mid-turn steering are not exercised by this idle-follow-up benchmark.

## Reproduction and artifacts

[Raw samples](harness-before-after.csv) contain all 120 attempted prompts, including errors. The driver and per-run native logs are in `/tmp/monocode-before-after` on the measurement machine; provider runtime artifacts remain outside the repository.

Run the same `src/lib/harness/nativeSmoke.test.ts` on both checkouts with `MONOCODE_COMPARE=1`, `MONOCODE_LIVE_PROVIDER`, `MONOCODE_VARIANT`, `MONOCODE_PAIR`, `MONOCODE_BENCH_CWD`, and `MONOCODE_RESULT_PATH`. The test sends two real prompts and records failures without turning them into fast successful samples.

Copilot was absent from PATH and the macOS resolver candidate locations. Other harnesses and Windows/WSL were not measured. Native application send-to-DOM latency, checkpoint overhead, sustained streaming, tool-heavy tasks, and application CPU/memory remain separate acceptance work.
