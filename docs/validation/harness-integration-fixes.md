# Harness integration fixes

Date: 2026-09-15. Branch: `perf/agent-harness-reliability`, based on `348c22e07723c32cd683483eb07e58952e08e88b`, with the earlier reliability/performance work retained. This implements the confirmed findings in the [fresh integration review](harness-integration-review.md), with four Astra workers owning separate provider/UI areas and a final independent review of the shared transport.

Further fixes and final validation are recorded in [the second repairs pass](harness-integration-fixes-round2.md) and [fresh post-fix review](harness-integration-review-round3.md). This document preserves the earlier pass's evidence.

## Result

All confirmed review findings have a code fix or an explicit supported fallback. Work remains in the existing isolated worktree, uncommitted. The changes preserve the existing adapters, queue, transcript, approval/question components and native process host. No dependency or database migration was added.

### Execution ownership and transport

- Stop/removal invalidates startup and queued-turn ownership across the adapters. Late startup results cannot resurrect removed work or kill a replacement. Muse/Codex recycle the owned host when cancellation occurs before a turn ID is known; saved provider bindings remain available for resume.
- Native stdout, stderr and exits carry the process generation. SSE data/end events carry stream generation. Old events are discarded, while valid output arriving before spawn acknowledgement remains supported.
- Monotonic command generations reject a cancelled spawn even if native execution had not begun. A replacement spawn/stream waits for pending single/global stop. Native cleanup cannot stop a newer stream or remove a newer process.
- Writes run off the native main thread and are serialized before IPC. Each live input queue permits at most 128 pending writes and 64 MiB of estimated string storage. A blocked write has a 10-second deadline; failure retires the owned process and never replays queued input.
- JSON-RPC timeout/cancel settles independently of write acknowledgement. Cancellation reaches queued writes so they cannot be delivered later. A definitive fast server rejection preserves the host for correction/retry. Closed clients ignore late requests/events.
- Cursor handshakes/controls now use bounded ACP timeouts; prompt requests retain a separate long turn deadline. SSE message/line sizes are bounded.

### Settings, permissions and resume

- Muse rejects failed required model/approval-mode changes before dispatch. OpenCode serializes permission updates and awaits the confirmed rules before starting a supervised/plan prompt.
- Devin, Cursor, Grok and fx propagate rejected or demonstrably ignored selections. Unsupported-method fallback is separated from ordinary provider errors. Grok skips redundant confirmed effort writes.
- Pi/omp initialize effective reasoning from provider state and apply the requested effort before prompting. Rejected changes are not cached as successful.
- A model/effort selection made during a running turn applies to the next new turn. Such followups queue; actual steers retain the active turn's model/settings provenance. The composer gives a compact “Next turn” indication.
- Failed resume in ACP providers and Pi/omp preserves the saved provider binding and reports the failure. It no longer silently replaces the conversation with empty provider context.
- Cursor/Grok/fx display ACP refusal/limit stop reasons instead of presenting every resolved request as successful completion.

### Followups, questions and conversation UI

- Steering readiness defaults to false without a provider-specific runtime predicate. Claude/OpenCode and the other supported adapters expose their actual readiness. Definitely-unsent followups return to the existing queue after a preparation/turn-end race.
- Unconfirmed steer delivery retains transcript evidence and a paused queue item with a delivery warning. It neither marks the primary turn idle nor automatically resends potentially delivered input.
- Cursor followups queue. Its previous notification-only steering path provided no acceptance result. This is an explicit compatibility boundary; native steering must be verified before enabling it again.
- Muse approvals/questions remain actionable after definitive rejected decisions. Unknown delivery is not blindly retried.
- Pi extension select/input/editor requests use the existing question component and return the actual answer. Pi/omp serialize visible questions so overlapping requests cannot hide one another.
- Numeric ACP elicitation preserves number/integer types and validates finite/safe values plus supported numeric schema bounds. Invalid replies show a nonterminal correction message while keeping the question and agent waiting. Unsupported form shapes are reported explicitly.
- Cursor fixed-choice questions disable unsupported custom input. Invalid/stale typed replies remain actionable; text-only requests explain the skip-and-followup fallback. Advertised ACP permission kinds select their actual opaque option IDs.
- User messages retain Markdown formatting and literal coding syntax such as `Array<T>` and `<script>`. The sanitizer remains enabled.
- Codex snapshot deduplication is scoped to provider items, preventing a final answer or reasoning item from repeating after earlier content in the same turn.
- Muse reminder children no longer create permanent status rows. One transient “Muse is finishing…” indicator marks the bookkeeping drain; the visible turn now settles at drain detection while the host still owns terminal completion, and follow-ups queue host-side during bookkeeping.
- MCP settings distinguish configured servers from confirmed runtime connections and explain reconnect/new-session application.

### Retained state and performance

- Completed ACP ownership/prose/alias state and Cursor enrichment use a bounded recent history, preserving active work and late routing.
- Nested Muse terminal events unsubscribe completed descendants and release follow slots. Codex bounds completed mappings and unknown-child pending payloads (including a global byte budget).
- OpenCode indexes parts by message rather than repeatedly scanning all historical parts. Finalized replay retains at most 256 parts and 1 MiB of estimated state, with 2,048 recent retired IDs. Active streams remain retained. These are logical retention bounds, not an RSS guarantee.
- Pi/omp's optional post-turn stats wait was an optimization candidate, not a confirmed correctness defect. It remains unchanged pending measurement of safe completion semantics.

## Validation

### Automated checks

`NODE_OPTIONS=--no-experimental-webstorage CARGO_TARGET_DIR=/Users/kacperkepinski/.cache/monocode-harness-target npm run check`

- **3,091 web tests passed**, 2 opt-in tests skipped.
- TypeScript passed.
- Rust formatting and Clippy with warnings denied passed.
- **445 Rust tests passed**, 4 opt-in tests ignored.
- `git diff --check` passed.

The new regressions cover delayed startup/acknowledgement, cancelled queued sends, replacement identity, blocked writes, stale streams, required-setting failures, resume preservation/retry, overlapping questions, invalid answers, literal prompt rendering, duplicate snapshots and bounded completed state. They exercise the existing owning boundaries. Full mounted-App/native GUI race acceptance is a separate boundary from these tests.

Logs: `/tmp/monocode-harness-repairs-check.log`, `/tmp/acp-final-tests.log`, `/tmp/muse-codex-tests-final-227.log`. Per-worker counts overlap; the full-suite count above is authoritative.

### Real installed-provider smoke

Ran the existing opt-in `nativeSmoke.test.ts` serially for Muse, Codex and Devin, three consecutive read-only prompts each. All **9/9 prompts passed** without adapter errors. Prompts used disposable Git workspaces, requested fixed markers, forbade tools/file changes, and denied any approval request. Requested model was the provider's Default with supervised mode.

| Provider | First content, turns 1 / 2 / 3 | Actual adapter settlement, turns 1 / 2 / 3 |
| --- | --- | --- |
| Muse | 3.33 / 3.05 / 2.12 s | 21.06 / 9.07 / 23.69 s |
| Codex | 7.50 / 2.83 / 3.80 s | 8.03 / 3.09 / 4.08 s |
| Devin | 5.78 / 2.53 / 3.02 s | 5.79 / 2.67 / 3.02 s |

Muse warm admissions were queued by the host; at measurement time the adapter waited for their actual completion. Settlement now occurs at drain detection, so those settled medians predate the change. The answer/bookkeeping distinction remains visible without false readiness.

These are functional smoke samples, **not a before/after speed comparison**. They exercise actual CLI adapters/stdio with a test bridge, excluding native Tauri IPC, WebView, checkpoints and real MCP calls. Other providers were covered by simulated protocol/lifecycle tests. Logs: `/tmp/monocode-harness-repairs-{muse,codex,devin}-live.log`.

### Visible interaction

An isolated Chromium fixture imported the actual transcript, state reducer and app styles. It verified literal generic/HTML examples alongside emphasis/lists/fenced code, and the finishing → content → completion transitions. Finishing and content kept the session busy with two transcript blocks; completion made it idle without adding reminder rows. The fixture, server and named browser were removed after verification.

Screenshots: `/tmp/astra-workflow-ui-finishing.png`, `/tmp/astra-workflow-ui-completed.png`. These are component-browser checks, not native WebView acceptance.

### Release build and local startup

The macOS release bundle built successfully using `/tmp/monocode-harness-build.json` and the separate harness target directory. After confirming zero in-flight sessions, the prior Harness Check process was stopped gracefully and the new **MonoCode Harness Check** launched successfully (PID 58887 at verification). Its identifier remains `com.kaceper11.monocode.harnesscheck`; the normal installation's data is separate. Build log: `/tmp/monocode-harness-repairs-build.log`.

Native computer-use verification was unavailable (`CUA_REPL_ENABLED_SURFACES is required`). Process startup is verified; the browser component evidence above remains the visual acceptance performed in this environment.

### Reducer performance check

After builds/tests finished, the production-bundled existing streaming benchmark was rerun on this patch: 1,024 deltas against 5,000 historical blocks, batches of 32, took **0.1225 ms** median with batched reduction versus **0.9109 ms** applying events individually. This compares two reducer paths on the current code, not app latency before/after this repair. Single-event paths remain approximately equal, with small sample variation. Hardware: Apple M5 Pro / 24 GiB, macOS; no builds ran during measurement; other workstation activity was not controlled. Artifact: `/tmp/monocode-harness-repairs-streaming.json`.

## Compatibility and remaining acceptance

- Cursor's documented ACP interface covers prompt/cancel and multiple-choice questions; its [official ACP documentation](https://prod.cursor.com/docs/cli/acp) also confirms project/user MCP configuration support and excludes dashboard team MCP servers. The queue/custom-answer fallbacks are conservative integration choices; absence from that document alone is not proof that every CLI version lacks a steering extension.
- Native CLI MCP configuration ownership is preserved. No unrequested app-level MCP server injection, credentials migration or authentication change was added. Actual server discovery, authentication, tool execution, connection failures and every provider's model/effort transition still need live provider-specific acceptance.
- Live Windows and Windows-to-WSL remain unverified. Existing WSL tests passed, including protocol path and lifecycle boundaries.
- Previous [checkpoint](checkpoint-latency.md) and [reducer](streaming-latency.md) measurements remain scoped stage evidence. This patch does not claim faster model generation or measured end-to-end parity across all 11 CLIs.
