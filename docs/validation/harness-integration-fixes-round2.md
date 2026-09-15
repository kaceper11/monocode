# Harness integration repairs — second pass

Date: 2026-09-15. Worktree `agent-harness-reliability`, branch `perf/agent-harness-reliability`, base `348c22e07723c32cd683483eb07e58952e08e88b` plus earlier uncommitted repairs. This implements all 18 confirmed issue groups in [the second review](harness-integration-review-round2.md). No commit, push, credentials migration or application restart was performed.

## Final result

All 18 original issue groups and six additional fresh-review findings were repaired and independently rechecked. Final full checks: **3,159 web + 453 Rust tests passed**; release bundle built; **9/9 live read-only smoke prompts passed**. Work remains uncommitted. Detailed boundaries and the Claude-after-Stop startup tradeoff are recorded below.

## Implemented behavior

| Findings | Change | Durable regression boundary |
| --- | --- | --- |
| MC1 | Muse/Codex Stop awaits bounded acknowledgements; rejected or unknown interruption retires only the owned host and retains resume. New sends wait for cancellation before shared startup acquisition. | Provider live tests cover rejected/unanswered Stop, unqueue, replacement survival, concurrent resume and send gating |
| MC2 | Muse serializes permission changes and reconciles the latest desired selection after each acknowledgement. | Delayed Auto → Supervised reversal and next-turn gating |
| MC3 | Temporary Muse resume failure preserves the original provider binding. | Retry resumes the same provider session |
| MC4 | Explicit Codex Standard sends `serviceTier: null` at thread start/resume and turn start; genuinely unspecified tier stays omitted. | Exact wire payloads for Fast/Standard/unspecified |
| O1 | Claude correlates and awaits permission control acknowledgements; rejected/missing tightening retires the owned host, preserves resume and blocks prompts. | Rejection, timeout, pending-mode cancellation and delayed approval release |
| O2 | PiRpc passes a per-request AbortSignal to the real child queue and revokes it on cancel/timeout/close; closed clients ignore late frames. | Actual child queue with only native IO mocked proves abandoned queued prompts never reach IPC |
| O3 | OpenCode abort failures propagate and retire uncertain live ownership; disposal starts stream close/process kill before yielding. Confirmed sibling Pi/omp abort failures now retire their owned hosts too. | Failed abort, retained resume, replacement-safe cleanup |
| O4 | omp records confirmed Fast state and surfaces a rejected disable, allowing correction/retry before dispatch. | Rejected disable retries and differing effective state |
| A1 | Cursor provider plan requests preserve MonoCode's explicit Build boundary; cancelled requests produce no late plan content. | Live Plan and post-cancel request outcomes |
| A2 | ACP question presentation is serialized, with cancellation generations preventing old queued questions from resurfacing in a replacement turn. | Overlapping and cancelled questions in Devin/Copilot/Cursor/Grok |
| A3 | Required MCP fields are preserved and invalid partial accepts stay actionable. Optional omission remains valid. | Actual reply builder + typed ACP converter |
| A4 | Titled MCP array choices using `items.anyOf` reuse the existing multiselect mapping and enforce item-count bounds. | Typed selected arrays and bounds |
| U1 | Manual and automatic queue delivery share stored submission options; Plan intent survives Send now and busy Plan steering is blocked. | Queue/Composer tests and actual extracted App callback |
| U2 | Question/approval/deadline replies route to their active provider owner after a next-provider picker change. | Session ownership tests and actual extracted App callback |
| U3 | Question forms provide Back navigation, preserving earlier and later entries for correction. | Mounted form tests and real browser interaction |
| U4 | Compaction captures the same in-flight settings snapshot as ordinary turns and clears it on completion. | Old acknowledgements cannot overwrite a newer model/effort choice |
| T1 | Native process exit waits for stdout/stderr readers to drain before terminal delivery. A shared emission gate prevents output after exit; inherited pipes have a one-second drain bound. | Real child writes terminal stdout before exit; bounded drain test |
| T2 | Native SSE uses an abortable async HTTP read instead of a blocking reader that cannot observe Stop. Close-before-task-install is handled; fragmented UTF-8, CRLF, multiline data and size limits remain supported. | Real idle TCP/SSE socket closes after cancel without peer data; task installation race and parser tests |

These changes use existing adapters, queue, session ownership and form components. Pi-family startup no longer applies settings twice: the existing run/compact boundary applies them before dispatch. No new settings framework or persisted schema was added.

### Native implementation tradeoffs

SSE now directly uses reqwest 0.13.4, already present through Tauri, with the shared async runtime. Enabling streaming gzip support retains the previous ureq capability and adds three small compression packages to the lockfile. Ordinary HTTP requests retain their existing ureq path. The SSE client preserves local configuration headers, disallows redirects/proxies and validates the parsed loopback destination. It reuses the installed ring TLS backend without changing global TLS configuration; SSE endpoints remain HTTP-only.

Normal process exit drains immediately when readers reach EOF. The one-second fallback applies when descendants retain pipes; output is suppressed after the terminal event. This is a bounded terminal-tail drain, not a claim that all descendants close inherited descriptors promptly.

## Validation

Fresh complete checks after implementation:

- `NODE_OPTIONS=--no-experimental-webstorage npm run check:web`: **3,137 tests passed, 2 opt-in tests skipped; TypeScript passed**. Log `/tmp/round2-fixes-web-check.log`.
- `CARGO_TARGET_DIR=/Users/kacperkepinski/.cache/monocode-harness-target npm run check:rust`: **452 tests passed, 4 opt-in tests ignored; formatting and Clippy passed**. Log `/tmp/round2-fixes-rust-check.log`.
- Focused results: Muse/Codex 241; ACP 229; Claude/Pi/omp/OpenCode 200; shared UI 145; native harness 42 passed / 1 ignored. These overlap with the complete check, so do not add their counts to it.
- The original five-case external UI review fixture now passes all five checks, compared with four failing behavior assertions before repair.

### Visible form correction

An isolated browser fixture imported the actual QuestionForm, ACP converter and app styles. Using real clicks: skip required Count, enter Name, submit → visible error; Back → Count 3; Continue → Name retained; submit → accepted `{count:3,name:"example"}`. Screenshots `/tmp/round2-ui-required-error.png` and `/tmp/round2-ui-required-corrected.png`. The named browser and temporary server were closed afterward. This is a component-browser check, not a full native WebView workflow test.

## Acceptance boundaries

The checks cover ownership, IO/protocol handling and visible form correction. They do not certify authenticated MCP discovery/login/tool execution/reconnect for every CLI, every account-specific model/effort combination, or live native Windows/Windows-to-WSL behavior. A release build and read-only provider smoke supplement this evidence separately.

No new end-to-end latency improvement or full CLI parity is claimed. Eliminating the blocked SSE reader is a verified resource-lifetime correction; it is not a measured whole-app CPU/RSS reduction. Provider latency, native IPC and WebView rendering remain separate measurement stages. Previous checkpoint/reducer measurements retain their original scope.

## Fresh independent review and follow-up repairs

Four new GPT-6 Astra reviewers checked the completed fixes; none implemented the code they reviewed. They confirmed the original reported triggers were addressed and found six additional issue groups. Those received focused follow-up repairs and independent rechecks:

| New finding | Follow-up correction |
| --- | --- |
| Codex stopped-turn terminal arriving during next admission | Retain bounded recent terminal identities, including successfully stopped turns, before opening another waiter |
| Muse concurrent questions | Queue visible questions and advance on local/server settlement, preserving server deadlines and clearing quietly on Stop |
| Devin/Copilot rapid Auto → Supervised | Serialize mode control and reconcile the latest desired selection after each acknowledgement |
| Grok cancelled plan output | Suppress late plan emission while preserving the provider's abandoned response |
| Claude rejected interrupt / old result completing next turn | Correlate interrupt control and retire the stopped host, preserving conversation resume |
| Native old exit closing replacement SSE | Check/remove the exiting child and close its stream atomically under the existing ownership lock |

Claude deliberately restarts/resumes its provider process on the first send after explicit Stop: an interrupt acknowledgement alone cannot attribute a late result to its old turn. This adds resume/startup cost after Stop; ordinary completed turns retain warm process reuse. Correct terminal ownership takes precedence over speculative reuse.

Independent native recheck passed the current source-extracted ownership probe and all 43 native harness tests (one authenticated smoke ignored). Full Rust check after this last native correction passed **453 tests**, with four ignored; formatting/Clippy passed. Log `/tmp/round3-final-rust-check.log`.

### Final acceptance evidence for this patch

- Final complete web check: **3,159 passed, 2 opt-in skipped**, TypeScript passed; `/tmp/round3-final-web-check.log`.
- Final complete Rust check: **453 passed, 4 opt-in ignored**, formatting and Clippy passed; `/tmp/round3-final-rust-check.log`.
- `git diff --check` passed.
- Final macOS release app built successfully with the isolated Harness Check identifier and `/tmp/monocode-harness-build.json`; `/tmp/round3-final-release-build.log`. Bundle: `/Users/kacperkepinski/.cache/monocode-harness-target/release/bundle/macos/MonoCode Harness Check.app`. The running app was not restarted by this task.
- Final live smoke on installed Muse, Codex and Devin: **9/9 consecutive read-only prompts passed**, three per provider, no adapter errors. Logs `/tmp/round3-final-{muse,codex,devin}-live.log`.
- All four fresh reviewers independently rechecked their follow-up fixes. No remaining reproduced defect was found in their bounded rechecks. See [the complete post-fix review](harness-integration-review-round3.md).

Final live samples, turns 1 / 2 / 3:

| Provider | First content | True adapter settlement |
| --- | --- | --- |
| Muse | 2.49 / 3.73 / 2.35 s | 7.67 / 13.03 / 6.51 s |
| Codex | 9.12 / 3.59 / 6.49 s | 9.42 / 3.88 / 6.78 s |
| Devin | 5.66 / 3.20 / 2.14 s | 5.67 / 3.21 / 2.15 s |

Command per provider: `NODE_OPTIONS=--no-experimental-webstorage MONOCODE_LIVE_PROVIDER=<provider> npx vitest run src/lib/harness/nativeSmoke.test.ts`. Each uses a disposable Git workspace, provider Default, supervised mode, fixed-marker requests forbidding tools and file changes, and denies any approval request. These smoke runs occurred after the final code edits; each provider ran serially after release packaging finished.

These are functional smoke samples, not a controlled before/after performance comparison. The live bridge exercises real CLI adapters/stdio, excluding Tauri IPC/WebView/checkpoints and real MCP execution. Muse settlement includes genuine provider bookkeeping after the answer. Every other provider received protocol/IO tests and fresh source review; real end-to-end acceptance is not implied.

