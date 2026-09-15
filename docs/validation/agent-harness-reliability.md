# Agent harness reliability and latency

Paired before/after results and raw samples: [measurement report](harness-before-after.md).

Additional measured speed improvement: [checkpoint latency reduction](checkpoint-latency.md).

Latest shared changes and checks: [streaming and lifecycle follow-up](streaming-latency.md).

Local-app regressions: [home workspace startup and follow-up formatting](startup-and-message-formatting.md).

Validation date: 2026-09-15. Branch: `perf/agent-harness-reliability`, based on main `348c22e07723c32cd683483eb07e58952e08e88b`.

## Changes

- Composer clears a draft only after submission acceptance. Rejection, preflight failure, and text typed during asynchronous acceptance preserve the draft. Repeated Send during acceptance submits once.
- Submissions and provider events share synchronously updated session state. A provider flush cannot overwrite a newly appended message with the previous render's snapshot.
- Busy Send steers a ready provider; startup, handoff, and final bookkeeping use the existing visible queue. If preparation outlives the active turn, the unwritten follow-up starts once as the next turn. Written requests are not automatically replayed.
- Main-turn cleanup waits for follow-up preparation and requests. Generation checks prevent old cleanup from stopping a newer turn. Devin/Copilot wait for outstanding ACP prompts and share main-prompt terminal/error handling. Serialized submissions retain their own event sinks.
- Codex/Muse ignore stale terminal events for newer turns. Muse settles the UI turn when end-of-turn bookkeeping (drain) is detected; steer is refused at that boundary, and a follow-up Send goes through `turn/start` with `ifBusy:"queue"` and runs when the host's bookkeeping finishes.
- Copilot reuses the existing shared-start/prewarm helper and applies independent model/mode controls concurrently. Other provider lifecycle implementations remain in their existing adapters.
- Default model placeholders retain the provider-selected default when a live catalog replaces fallback models.

No schema, credential, account, dependency, or runtime-mode migration. No upstream provider lifecycle replacement. This is a localized repair on the supplied main; it does not claim parity with an unreviewed newer upstream revision.

## Reproduced live failures

**Codex:** first prompt with saved `codex:default` succeeded; model catalog discovery then replaced the fallback entry. The second prompt sent literal model `default`, which Codex rejected with HTTP 400 for the ChatGPT account. Preserving the placeholder's empty native ID fixed the case; three consecutive live prompts passed.

**Muse:** steering immediately after answer completion returned an accepted acknowledgement but produced no follow-up response. A separate run using the readiness check and next-turn queue produced both the original response and `HARNESS_FOLLOWUP`, then completed two more normal prompts. The bookkeeping delay belongs to the host; settling the UI turn at drain detection does not make the host ready for another turn, so a follow-up Send is admitted through `turn/start` with `ifBusy:"queue"` and runs only when the host finishes bookkeeping.

## Automated and visible checks

- Final web check: 2,961 tests passed, one opt-in live test skipped; TypeScript passed, including the Copilot prewarm/Send regression.
- Rust formatting and Clippy passed; 437 tests passed, two ignored. Those checks preceded the subsequent Rust checkpoint optimization linked above.
- Isolated macOS release bundle built successfully as **MonoCode Harness Check**, identifier `com.kaceper11.monocode.harnesscheck`. Existing installation/data were not replaced.
- Actual Composer component exercised in Chromium with native IO stubbed: rejected Send retained draft/error; retry and a second message appeared once each, with composer cleared after acceptance. DOM tests also cover asynchronous double Send, editing the next draft during acceptance, and failure recovery.
- Live macOS adapter/stdio runs: three consecutive prompts each for Muse, Devin, Codex; Muse post-answer queue scenario passed. Copilot executable was unavailable.

Commands:

```sh
# Node 26's experimental global localStorage conflicts with happy-dom.
NODE_OPTIONS=--no-experimental-webstorage npm run check

# Uses installed CLI/auth and a disposable Git workspace; sends real requests.
MONOCODE_LIVE_PROVIDER=muse npm test -- src/lib/harness/nativeSmoke.test.ts
MONOCODE_LIVE_PROVIDER=muse MONOCODE_LIVE_STEER=1 npm test -- src/lib/harness/nativeSmoke.test.ts
MONOCODE_LIVE_PROVIDER=devin MONOCODE_BENCH_PAIRS=10 npm test -- src/lib/harness/nativeSmoke.test.ts
```

The opt-in test also accepts `codex` and `copilot` for normal smoke runs. Direct comparison mode supports Muse, Devin, Codex. JSON measurements are written under the OS temporary directory, outside the repository.

## Diagnostic performance measurements

Hardware: Apple M5 Pro, 24 GiB RAM, macOS. Installed CLIs: Muse Code 1.2.1 (MSP host reports 1.3.0), Devin 3000.10.27, Codex 0.154.0.

These are **TypeScript adapter + real native CLI subprocess measurements**, not release-app/WebView measurements. Three sequential prompts share one provider session. Each prompt requests one fixed marker and forbids tools, commands, and file changes.

| Provider | Cold submit to provider write | Warm writes, turns 2 / 3 | First content, turns 1 / 2 / 3 | Settled, turns 1 / 2 / 3 |
| --- | ---: | ---: | ---: | ---: |
| Devin | 300 ms | 0.06 / 0.05 ms | 4.42 / 2.22 / 3.27 s | 4.44 / 2.23 / 3.27 s |
| Muse | 304 ms | 0.13 / 0.10 ms | 3.22 / 1.72 / 1.94 s | 27.63 / 6.13 / 10.68 s |
| Codex | 555 ms | 0.16 / 0.07 ms | 7.06 / 2.00 / 2.19 s | 7.36 / 2.33 / 2.53 s |

Ten additional cold-start pairs per provider alternate adapter-first and CLI-first order. Both sides use the same marker prompt, disposable working directory and provider default selection; the adapter forgets its session between pairs. CLI comparison uses provider headless execution (`muse exec`, `devin -p`, `codex exec`), **not an interactive terminal**. Adapter completion and CLI process exit are different boundaries, particularly for Muse's bookkeeping.

| Provider | Adapter write median / p95 | Adapter first content median | Adapter settled median | Headless CLI exit median |
| --- | ---: | ---: | ---: | ---: |
| Devin | 93 / 287 ms | 5.49 s | 5.51 s | 4.34 s |
| Muse | 222 / 596 ms | 2.37 s | 11.46 s | 15.35 s |
| Codex | 101 / 723 ms | 7.03 s | 7.32 s | 8.56 s |

p95 uses nearest rank, so with ten samples it is the maximum. Provider comparisons overlapped and other developer processes/build checks were running. Exact effective model/reasoning defaults and headless/interactive execution semantics were not independently equated. These samples identify boundaries and variability; they do not prove a speedup from this patch or satisfy the requested release-app CLI parity acceptance.

## Timing instrumentation and remaining acceptance

Devtools `[turn provider session generation]` marks distinguish submission, preparation/checkpoint readiness, provider request write, first content received, visible transcript DOM commit, and settlement. Handshake/status messages do not count as first content. Hidden session renders do not count as visible transcript commits. Follow-ups currently share their owning turn's clock; separate per-follow-up latency distributions remain to be measured.

The proposed p95 targets (100 ms submitted-message DOM, 100 ms received-content-to-DOM, 250 ms warm submission overhead including checkpoint) **are not yet established by release-app measurements**. App/backend/WebView CPU and memory, bridge overhead, and rendered long-transcript throughput remain unmeasured. Native release checkpoint timings and production-bundled reducer timings are reported separately in the linked follow-ups.

Native macOS window automation could not inspect/capture the isolated app's windows in this session. The successful release build and browser component check do not establish native end-to-end interaction. Windows/WSL and authenticated Copilot were unavailable.

Before claiming full parity, run on each target platform/provider:

1. Ten interleaved release-app/interactive-CLI pairs with the same effective model, reasoning, approvals, prompt, attachments and working tree; separate cold and warm runs. Record stage timings and separate app/backend/WebView/provider costs.
2. Send second/third messages during startup, tool execution, answer completion and checkpoint cleanup; verify each remains visible and is delivered once or visibly queued.
3. Exercise attachment preparation failure, rapid Send, Stop during preparation/steering, provider exit, reconnect and session removal; verify no late callback changes the next turn and no ambiguous request is replayed.
4. Repeat with a large repository and long transcript. On Windows UI + WSL, verify both Git and provider execute inside the intended distribution and paths remain host-correct.
