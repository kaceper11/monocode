# Harness integration review — fresh post-fix pass

Date: 2026-09-15. Four new GPT-6 Astra agents reviewed the repaired `agent-harness-reliability` worktree. They did not implement the fixes. Base: `348c22e07723c32cd683483eb07e58952e08e88b`, with the current authorized uncommitted changes.

## Final result

**All 18 findings from the previous review are addressed.** This fresh pass found six additional issue groups. Those were repaired by the original implementers/coordinator and then independently rechecked by the fresh reviewers. **No remaining reproduced defect was found in those bounded follow-up checks.** This is not a claim of flawless behavior under every provider, MCP or platform scenario.

| Fresh finding | Repair | Independent final evidence |
| --- | --- | --- |
| Codex delayed stopped-turn completion settles a newer admission | Bounded recent terminal identities include successful Stops | Original and successive-Stop diagnostics/regressions pass |
| Muse overlapping questions hide an unanswered request | FIFO visible question ownership; local/server settlement advances once | Live/resume queue and server-settlement-before-local-ack checks pass |
| Devin/Copilot permission-mode reversal loses Supervised restoration | Serialized latest-selection reconciliation; uncertain cache invalidation | Original delayed reversal, failed acknowledgement, cancellation/replacement checks pass |
| Grok late cancelled plan appears in conversation | Cancelled/muted plan output suppressed; abandoned response preserved | Original late-plan diagnostic and live-plan regression pass |
| Claude failed interrupt reuses the running process; old result ends new work | Correlated bounded interrupt; stopped host retired with saved resume | Independent success/rejection/timeout and late-result isolation checks pass |
| Old native process exit can close replacement SSE | Atomic exiting-child removal and stream closure under ownership lock | Extracted current-method lock probe and replacement ordering tests pass |

Scope covers all 11 provider integrations through the matrices below, plus shared conversation/queue UI and native transport. The original 18-item implementation and final full checks/build/smoke are documented in [the repairs report](harness-integration-fixes-round2.md).

## What the review establishes

- Current source, protocol/IO fixtures, actual reducer/callback checks and targeted regression runs support the findings and fixes.
- The fresh reviewers used temporary external diagnostics, then reran them after repairs. Passing defect assertions before repair were not counted as fix acceptance.
- Full final coordinator checks: 3,159 web tests and 453 Rust tests passed; TypeScript, formatting and Clippy passed. Six opt-in tests remain skipped/ignored in aggregate.
- Live smoke and release packaging are supplemental coordinator evidence, not an independent proof of all control/MCP scenarios.
- No fresh reviewer edited repository source, started provider prompts, restarted the app, committed or pushed.

## Remaining acceptance limits

Actual MCP discovery, sign-in, tool execution/reconnect and account-specific model/effort transitions are not certified for all providers. Full native WebView workflows and Windows-to-WSL remain unverified. No new end-to-end speedup or whole-app CPU/RSS claim is made.

Claude's first prompt after explicit Stop now incurs process resume/startup cost to establish a safe ownership boundary. Normal completed turns reuse the process. Native terminal draining is bounded to one second for descendant-held pipes; the emission gate prevents late output but does not itself wake indefinitely blocked inherited-pipe readers. Codex terminal replay protection retains 64 recent identities. These limits are explicit; none should be confused with exhaustive provider parity.

## Independent reviewer evidence

The appendices retain the initial finding evidence and later superseding recheck verdicts. Findings labelled new/open in their historical sections are resolved by each appendix's final follow-up section and the summary above.


---

## Muse and Codex

## Round 3 independent Muse/Codex review

Reviewed current working tree `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, branch `perf/agent-harness-reliability`, after MC1–MC4 fixes. Read-only review: no repository edits, commits, app restarts, live prompts or credential changes.

### New reproducible findings

#### R3-MC1 — P1: Delayed completion of a successfully stopped Codex turn completes the next admission

Anchors: `src/lib/harness/codex.ts:337` (successful cancellation), `:793` (terminal identity filtering), `:711` (new turn waiter before admission acknowledgement).

Trigger: start T1; Stop and receive successful `turn/interrupt` response; submit T2; while its `turn/start` acknowledgement is pending, receive T1's delayed `turn/completed`; acknowledge T2. Cancellation calls `finishActiveTurn` without storing T1 in `lastCompletedTurnId`. The new waiter already exists, but `activeTurnId` is null. T1's terminal therefore passes both filters and completes T2's waiter. T2's send resolves before any T2 terminal; the UI can clear busy/Stop and dispatch queued work while T2 still runs.

Reproduced in `/tmp/round3-mc-diagnostic/codexLive.test.ts`, test `R3 delayed stopped terminal cannot complete next admission`: expected completion spy to remain uncalled; observed one call. All messages include the correct parent thread identity. This is distinct from the fixed rejected/unanswered Stop issue and from replacement-host protection.

Smallest fix: record the captured successfully interrupted `turnId` in `lastCompletedTurnId` before `finishActiveTurn`, retaining the existing terminal filter. Add the reproduced admission-order regression.

#### R3-MC2 — P2: Muse concurrent questions hide the first pending request

Anchors: `src/lib/harness/muse.ts:1822` (stores every request and immediately emits every question), `:409` (settlement never presents another pending question), `src/lib/harness/apply.ts:116` (single visible question), `:138` (settlement clears that slot).

Trigger: Muse sends two distinct `userInput/requested` notifications before the first is answered, including pending requests re-issued on resume. Both are retained in the adapter map, but both emit `question.asked`. The reducer replaces question 1 with question 2. Answering/settling question 2 clears the single UI slot; question 1 remains pending in the adapter without a path to display it. A blocking request can leave the provider waiting until Stop or provider-side settlement.

Reproduced in `/tmp/round3-mc-diagnostic/museLive.test.ts`, test `R3 Muse presents all concurrent questions`: feeding both real adapter events into the real reducer leaves request 2 visible instead of request 1 (expected 1, observed 2). This extends the prior concurrent-question defect to Muse, which was not in round-2 A2's provider scope.

Smallest fix: preserve a visible question ID and store its event alongside each existing pending entry, like Codex's local queue; emit only the first and advance after local/server settlement. Clear all without advancing on cancellation. Preserve Muse's server-owned deadlines rather than inventing a new countdown.

### MC1–MC4 verdicts

| Prior issue | Verdict after fixes |
| --- | --- |
| MC1 rejected/unconfirmed Stop | Fixed for the reported cases: bounded interrupt/unqueue acknowledgement, exact live-owner retirement, retained resume binding, gating of sends, replacement survival and shared resumed start. R3-MC1 is a remaining successful-Stop ordering case. |
| MC2 rapid Muse mode reversal | Fixed: one shared reconciliation promise repeatedly applies latest desired mode, checks returned effective mode and gates next dispatch. |
| MC3 transient Muse resume failure | Fixed: non-missing errors retain provider identity; retry uses `session/resume`. Confirmed missing session has the separate fallback. |
| MC4 Codex Fast to Standard | Fixed in start/resume/turn builders: explicit Standard maps to `serviceTier: null`; unspecified remains omitted. |

### Scenario matrix

| Scenario | Source/test evidence and limit |
| --- | --- |
| Cancel during binary resolution, handshake, admission | Existing regression tests pass for both providers; no late bind/spawn in those fixtures. |
| Cancel admitted turn, rejection, timeout | Existing new MC1 tests pass; Muse queued-unqueue rejection/timeout covered. Successful Codex Stop followed by delayed terminal fails new diagnostic. |
| Follow-ups and steering | Existing serialized send/cancel-generation behavior and provider turn-ID steering inspected. Tests cover queued-send invalidation and one resumed host for concurrent sends. |
| Runtime controls | Muse mode reversal/rejection and gating pass. Codex turn-scoped policy, parked approval changes, permission decisions and Plan denials pass existing tests. |
| Model/effort/tier | Muse models and approval controls apply before turn; reasoning effort is forwarded at turn/steer. Codex collaboration-mode model/effort and explicit Standard reset inspected and protocol tests pass. Actual server application remains live acceptance. |
| Resume | Existing bind/missing fallback/transient preservation and pending-request replay tests pass. Multiple simultaneous Muse requests remain R3-MC2. |
| Questions and MCP | Codex serialized questions, optional timers, secret rejection, confirmation-only MCP allow/deny and unsupported-form cancellation tests pass. Muse normal answer/skip/rejection paths pass; concurrent requests fail R3-MC2. General Codex MCP forms/browser authentication remain explicitly unsupported. |
| Subagents | Existing Muse child backfill/subscription/nested release and Codex child routing, child approvals and questions, duplicate rows and terminal rows tests pass. Real provider fan-out remains unverified. |
| Performance bounds | Source retains caps on Muse item state, finished turns, child count/history/page walks/prose; Codex caps child mappings, unmatched notifications/bytes and streamed item count. No new timers/processes added by review. Synthetic retention tests pass; no release-build latency/CPU/native-host claim. |

### Validation

- Ran 8 existing focused files: `museLive.test.ts`, `museSubagents.test.ts`, `codexLive.test.ts`, `codexProtocol.test.ts`, `codexApprovalUi.test.ts`, `codexQuestions.test.ts`, `codexAttachments.test.ts`, `codexElicitation.test.ts`: **241/241 passed**. Log `/tmp/round3-mc-focused.log`.
- Ran new external diagnostic tests with `NODE_OPTIONS=--no-experimental-webstorage npx vitest run --config /tmp/round3-mc-diagnostic/vitest.config.mjs -t R3 --reporter=dot`: **2 expected failures**, establishing the findings above. Log `/tmp/round3-mc-diagnostic/result.log`. The external files use current adapter imports and copied fixture setup; no production files were copied or patched.
- No authenticated provider, native UI, real MCP, Windows/WSL or release performance acceptance was performed by this reviewer.

### Evidence limits

Graph-first searches and depth-one traces for `sendMuseTurn`/`sendCodexTurn`, then snippets and per-path coverage were used. Project `Users-kacperkepinski-Developer-personal-monocode` is ready but roots at the ORIGINAL checkout, generation `2026-09-13T15:07:47Z`. Coverage reported metadata-changed adapter/live-test paths and untracked Muse subagent paths. Even metadata-match helper paths do not establish worktree freshness. Current worktree source was authoritative for every finding. No index mutation or exhaustive whole-repository claim.

### Final bounded recheck after R3 repairs — 2026-09-15

**Both R3 findings are fixed in the current working tree. No remaining issue was found within this bounded recheck.** The findings above document the pre-fix evidence, not outstanding defects.

- R3-MC1: `codex.ts:338` records the captured interrupted identity before local settlement; natural terminals use the same `rememberCompletedTurn` path (`:1042`). The admission filter rejects any of 64 recent completed/stopped identities (`:795`). Independent original failing diagnostic now passes unchanged. Reviewed and ran the successive successful Stops plus delayed/duplicate terminals regression and 66-turn retention check: pass. Replay beyond the explicit 64-identity retention bound is not certified.
- R3-MC2: `muse.ts:1098` presents one pending question, `:1107` advances only after an extant request settles, and `:1079` clears without advancing on Stop. Local and server settlements share that path; queued events retain their original deadlines. Original failing diagnostic now passes unchanged. Reviewed and ran live/resume queue tests covering hidden server settlement, rejected reply retry, duplicate settlement, deadline preservation and Stop clearing: pass.
- Added an independent external race check after reviewing the fix: a local question reply remains in flight while server settlement advances the queue; its later successful acknowledgement must not advance again. This passes and the next question remains visible.

Independent commands/results:

1. `NODE_OPTIONS=--no-experimental-webstorage npx vitest run --config /tmp/round3-mc-diagnostic/vitest.config.mjs -t R3 --reporter=dot` — **3/3 passed**, the two original tests plus the late-local-ack race. Log `/tmp/round3-mc-diagnostic/rechecked-result.log`.
2. `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/harness/codexLive.test.ts src/lib/harness/museLive.test.ts -t 'delayed stopped terminal|several successfully stopped|bounds terminal identity|serializes simultaneous questions' --reporter=dot` — **5/5 passed**, 134 unrelated tests skipped. Log `/tmp/round3-mc-recheck-focused.log`.

Current source was reread because the previously checked graph belongs to the other checkout. The implementer separately reports 246/246 focused tests and TypeScript passing in `/tmp/round3-mc-fixes.md`; this reviewer independently ran the bounded checks above. No repository code edits or live/native/provider/platform acceptance was performed.

---

## Devin, Copilot, Cursor, Grok and fx

## Round 3 independent ACP review

Reviewed read-only in `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, base `348c22e07723c32cd683483eb07e58952e08e88b` plus current authorized repairs. No repository edits, commits, app restart, live prompts, or MCP mutations.

### Verdict

A1–A4 are fixed for their reported triggers and covered by passing current tests. Two additional concrete findings remain: P1 runtime-mode reversal for Devin/Copilot; P2 delayed Grok plan output after Stop.

#### A1–A4 verification

- **A1 fixed:** `cursor.ts:620–632` suppresses cancelled/muted create-plan requests and rejects live implementation approval with explicit separate-Build guidance. No automatic accepted outcome. Both current regression cases pass.
- **A2 fixed:** `acp.ts:63–84` invalidates queued questions by generation on reject/close and serializes complete handlers. Devin/Copilot/Cursor/Grok use this boundary. Eight overlap/cancel tests pass, including queued unsupported schemas cancelled before parsing.
- **A3 fixed:** `acp.ts:691,746–750` retains required property identity and raises a correction error for missing required answers. Both adapter regression cases use the real reply builder, preserve the form, then successfully send a valid corrected response with optional fields omitted. Mounted Back-navigation acceptance belongs to the UI reviewer.
- **A4 fixed:** `acp.ts:647–659,751–755` parses titled array `items.anyOf` values through the existing options mapping, preserves array wire types, and checks selection bounds. Current titled-choice/bounds test passes.

### Findings

#### 1. P1 — Devin and Copilot lose an in-flight return to Supervised

**Source:** `src/lib/harness/devin.ts:257–267,675–693`; `src/lib/harness/copilot.ts:273–283,774–792`.

**Trigger:** Start an active supervised turn with provider mode `normal`. Select Auto, then select Supervised before the Auto `session/set_mode` response arrives. The setters update desired `runtimeMode` immediately but call the asynchronous mode writer independently. The second call compares `normal` against the still-old confirmed `currentModeId` and returns. The first response then caches Auto. No restoring `normal` request is sent.

**Independent reproduction:** Actual current adapters + actual AcpClient/JsonRpcClient with child IO fixture. Used the existing provider vocabulary (`smart` for Devin; `autonomous` for Copilot). Both expected-behavior checks fail: captured only `[smart]` / `[autonomous]`, expected a following `normal`. A running prompt remained active during the reversal. Original diagnostic also reproduced advertised `bypass`, but the final fixture deliberately uses the existing native test mode vocabulary.

**Impact:** Provider remains in Auto during the running turn while the user has selected Supervised. The client gate can still stop permissions that the provider asks about; it cannot restore provider-side permission behavior if Auto avoids those asks. A later ordinary send repairs the selection, leaving the current turn under the wrong provider mode.

**Smallest fix:** Serialize mode writes and reconcile the latest requested runtime/planning mode against confirmed state, using the existing Live ownership. Both interactive setters and before-prompt mode application should share that sequencing. Do not cache rejected settings as applied. Add delayed Auto → Supervised and rejection/owner-replacement checks.

**fx disposition:** Its setter has a similar asynchronous shape, but `fxModeId` always returns `code` (`fxProtocol.ts:64–66`), and the live setter preserves `live.planning`. Thus this user runtime-mode reversal does not create different desired fx wire modes. Do not mechanically extend this finding to fx. Cursor changes its client permission gate synchronously. Grok uses startup flags and an explicit next-turn restart boundary, not this RPC cache pattern.

#### 2. P2 — Grok renders a cancelled plan from a delayed exit-plan request

**Source:** `src/lib/harness/grok.ts:635–642`; compare cancellation `:245–253` and guarded question handling `:738–746`.

**Trigger:** Stop a Plan turn; after cancellation settles, its delayed `_x.ai/exit_plan_mode` request arrives carrying plan text. This request branch emits `plan` without checking `cancelled` or `muteUpdates`.

**Independent reproduction:** Start/hold actual Grok adapter prompt, cancel it, then inject a delayed exit-plan request. The adapter emits `{type:"plan",text:"Old cancelled plan"}` after the stop boundary. Expected no fresh plan output, so the regression fails.

**Impact:** Cancelled content reappears as an actionable plan in the transcript. The reply still says `abandoned`; this does not grant automatic implementation approval and should not be described as the former Cursor P1.

**Smallest fix:** Preserve the required abandoned response while suppressing plan parsing/emission for cancelled or muted lives. Add post-cancel and ordinary-live exit-plan regressions.

### Provider/scenario matrix

| Provider | Positive evidence in this pass | Remaining boundary |
| --- | --- | --- |
| Devin | Cold-start sharing, queued-turn cancellation, retained failed resume identity, explicit model/config failure, numeric/required/MCP forms, serialized overlap; model reasoning selection traced through existing catalog validation | P1 mode reversal; native model/effort/account-specific controls and MCP discovery/auth/tools unverified |
| Copilot | Same lifecycle/form paths; existing model fallback, launch effort, active followup fixtures passed | P1 mode reversal; actual installed CLI effort/old-version fallback and MCP acceptance unverified |
| Cursor | A1 explicit Build boundary, A2 serialization, lifecycle/config rejection, fixed-choice correction and custom-answer fallback; existing live fixtures passed | No additional confirmed finding in bounded scope; queue-only capability remains intentional; native MCP/model toggles unverified |
| Grok | A2 serialization, model/effort control path, lifecycle/resume/stop reasons; abandoned implementation boundary retained | P2 delayed plan render; native startup-mode tightening and MCP acceptance unverified |
| fx | Lifecycle/resume/selected-setting rejection/stop reasons; ordinary runtime modes map to existing `code`, Plan maps to `ask` | No additional reproduced finding; no live provider, MCP, or native platform certification |

Cancellation tests establish local dispatch invalidation and queued-form cleanup. They do not certify remote cancellation completion under every installed provider. A candidate based only on mocking failed `writeChild` was rejected: actual `child.ts:363–385` retires the process for IPC write failures, so that mock would misrepresent current behavior. No such finding is reported.

Shared ACP prompt accounting waits for accepted followups before readiness; existing lifecycle tests pass. Current retained subagent state has a bounded regression. This review ran no release-build CPU/RSS/native WebView or end-to-end latency measurement. MCP form fixtures establish parsing and reply behavior, not connected/configured server equivalence or real authorization/tool execution.

### Validation

- **214/214 current tests passed in 10 files:** `acpReliability` (57), `devinLive` (15), `devinProtocol` (33), `copilotLive` (27), `copilotProtocol` (19), `cursorLive` (14), `grokLive` (7), `grokProtocol` (19), `fxLive` (3), `fxProtocol` (20). Log `/tmp/round3-acp-existing.log`. The invocation also named `acp.test.ts` and `cursorProtocol.test.ts`, which are absent; Vitest executed the ten actual files listed here.
- **Three expected-behavior diagnostics fail**, covering the two findings. Fixture `/tmp/monocode-round3-acp/review.test.ts` copies the existing fixture plumbing, rewrites imports to actual worktree source, and adds narrow assertions; 57 copied cases are skipped by the test filter. Log `/tmp/round3-acp-diagnostics.log`.
- Reproduce from the reviewed worktree: `NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run --config /tmp/monocode-round3-acp/vitest.config.mjs -t round3`.
- Native IO is mocked, no provider is launched. This is not authenticated/live MCP/provider/Windows/WSL acceptance. Root-reported full web/Rust counts were not independently rerun here.

### Evidence discipline

Read current AGENTS.md, docs/PRODUCT.md, prior A1–A4 report and `/tmp/round2-acp-fixes.md`. Applied codebase-memory and Ponytail guidance. Graph-first search → trace → snippet for ACP form ownership; project `Users-kacperkepinski-Developer-personal-monocode`, ready generation `2026-09-13T15:07:47Z`, points to the original checkout. Graph snippets have stale source positions. Coverage checked every relied source/test path plus bounded harness scope; scope reports no recorded gaps, `has_more=false`; changed files and missing reliability tests resolved via current worktree source. No reindex. This is bounded task verification, not an exhaustive security/graph audit.

Memory registry `MEMORY.md:480–482` provided initial provider-seam orientation only; facts relied on here were checked against current source. Rollout ID `01a07ffd-7eb0-7083-99e7-89662a162e3f`.


### Final independent recheck after R3 repairs

**Both additional findings are fixed for their reported triggers.** Re-read current `devin.ts:682–718`, `copilot.ts:780–816`, their runtime setters/cancel boundaries, and `grok.ts:635–644`; no source edits by this reviewer.

- Devin/Copilot now serialize mode writes, read the latest desired choice after the prior write, and await changes made during turn preparation before prompting. Owner and turn-generation checks discard stale queued writes. Rejected/cancelled/obsolete writes invalidate the confirmed mode cache, so a later required selection is asserted again. The two original independent reversal diagnostics now pass.
- Grok checks cancelled/muted state before emitting plan text while retaining the `abandoned` reply. The original independent post-Stop diagnostic passes; ordinary live plan rendering and the Build approval boundary remain covered.
- Independently reran **120/120 tests across four current suites**: 71 `acpReliability`, 15 `devinLive`, 27 `copilotLive`, 7 `grokLive`. In addition to the original triggers, current regressions cover delayed preparation acknowledgements, obsolete write rejection, failed-selection retry, cancellation and stop/replacement followed by a stale old acknowledgement. Log `/tmp/round3-acp-recheck-existing.log`.
- Original external diagnostics: **3/3 passed**, with 57 inherited cases filtered out. Log `/tmp/round3-acp-recheck-diagnostics.log`. Same reproduction command and unchanged outside-repo diagnostic assertions as above.
- Rechecked graph coverage for the four changed source/test files; original-checkout graph remains changed/missing, so current worktree source remains authoritative. No graph reindex or app/provider mutations.

No remaining reproduced defect in this bounded two-finding recheck. Earlier live MCP/provider/platform/performance limitations remain unchanged. TypeScript and full web/Rust results remain root/implementation-worker evidence, not additional independently rerun checks here.

---

## Claude, Pi, omp and OpenCode

## Round 3 — Claude, Pi, omp and OpenCode after O1–O4 repairs

Reviewed read-only worktree `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, branch `perf/agent-harness-reliability`, base `348c22e07723c32cd683483eb07e58952e08e88b`, including the authorized uncommitted repairs. Read current AGENTS.md, docs/PRODUCT.md, the round-2 report and `/tmp/round2-other-fixes.md`. No repository edits, commits, provider launches, prompts, restarts or MCP operations.

### Result

The four reported O defects and the explicitly identified Pi/omp abort sibling are addressed by the current repairs. One additional concrete P1 remains in Claude cancellation. This is bounded source/protocol verification, not four-provider native acceptance.

### New finding: P1 — Claude reuses a running process after a rejected interrupt

**Source:** `src/lib/harness/claude.ts:435–462`, especially `455–458`; response dispatch `781–789` and the earlier muted-event return. `cancelClaudeTurn` sets cancelled/muteUpdates, writes an interrupt control, then completes the current turn based solely on the successful stdin write. It does not correlate or await the interrupt response. `handleLine` ignores that response while muted; even if unmuted, only permission-control responses have a matching waiter.

**Trigger:** During a running Claude turn, press Stop. The CLI accepts the control JSON over stdin but returns `control_response` with the interrupt request ID, `subtype:"error"` and a failure message. Then send a new prompt.

**Observed:** Stop resolves; the active send settles; no session error or process retirement occurs. The next prompt uses the same process. An eventual `result` from the unsuccessfully interrupted old turn then resolves the new turn because provider results are not separated by a new process/turn identity.

**Impact:** The UI reports stopped/completed work while the provider may continue execution; subsequent explicit work overlaps that still-running conversation and can be falsely completed by its result. This is the same ownership failure class repaired for OpenCode and Pi/omp.

**Smallest fix:** Establish a confirmed stop boundary before reusing Claude. Correlate and await interrupt acknowledgement with a bounded deadline, retiring the owned process on rejection/timeout/unknown delivery and retaining resume, or conservatively retire on Stop if the protocol cannot establish that boundary. Control responses needed for shutdown must remain consumable while ordinary content is muted. Reuse the existing control/lifecycle mechanism, without adding another transport layer.

**Diagnostic:** `/tmp/monocode-round3-other/claude.test.ts` imports actual current `claude.ts` via absolute paths, retaining existing fixture setup and mocking only child IO. The appended `round3 reproduces ignored Claude interrupt rejection and reuse` test synchronously returns a definitive protocol error after the interrupt write, verifies no kill/error, sends the next prompt on the one spawned process, then supplies the old result and observes the new send settle. **1/1 diagnostic passed**, meaning the faulty behavior was reproduced. No real CLI ran. Run from the reviewed worktree:

```
NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run --config /tmp/monocode-round3-other/vitest.config.mjs -t round3
```

Log: `/tmp/round3-other-diagnostics.log`.

### O1–O4 and sibling verdicts

| Prior defect | Verdict and current evidence |
| --- | --- |
| O1: Claude permission acknowledgement | Addressed for the reported tightening/parked-approval cases. `applyClaudeRuntimeMode` serializes updates; permission requests correlate IDs and time out at 8 seconds; send/compact wait for current updates; rejection retires the owned process with resume retained. Pending approvals release after acknowledgement. New durable tests cover success delay, error, missing acknowledgement and cancellation during the control. This does not resolve the separate interrupt control above. |
| O2: PiRpc revoked queued writes | Addressed. Requests own AbortControllers passed to actual `writeChild`; timeout, explicit cancellation and close revoke writes. Closed clients drop late frames. `piQueue.test.ts` uses actual child queue plus mocked native invoke/listen and verifies all three queued cases never reach `harness_write` after a blocker drains. Definitive response handling leaves accepted transport alone. |
| O3: OpenCode failed abort and session reuse | Addressed for HTTP rejection/transport failure. Abort errors propagate from OpenCodeClient; cancellation emits an error and disposes the owned host while preserving resume. SSE closure and child kill start before yielding during disposal. Durable cases cover HTTP 500 and simulated timeout plus next-send resume. |
| Pi/omp unconfirmed-abort sibling | Addressed for the reported rejection case by the same shared `piFamily.cancelTurn` branch. Failed RPC abort retires the session, closes pending requests and retains resume. Parameterized durable tests cover both Pi and omp. |
| O4: omp failed Fast disable | Addressed. Only confirmed effective Fast state is cached; failed disabling reports retained state and rejects before prompting, leaving retry possible. Conflicting acknowledged state is emitted through configChanged. Unsupported enabling retains the prior visible fallback. Tests cover failed disable retry and differing confirmed effective state. |

### Provider/scenario matrix

| Provider | Current positive evidence | Remaining acceptance boundary |
| --- | --- | --- |
| Claude | Live process reuse; model/launch-setting changes relaunch with the same provider conversation; permission changes now acknowledged and serialized; queued-turn invalidation; plan/MCP tool gating; serialized questions; built-in compaction boundary tests | New P1 interrupt failure. Installed CLI model/effort/Fast transitions, real rejected controls, genuine stop/late-output ordering, configured MCP discovery/auth/tool use and native compaction still need live acceptance. |
| Pi | Shared request multiplexer; revoked queued RPC writes; explicit thinking acknowledgement and mismatch reporting; failed resume does not silently restart; attachment-only input; serialized extension forms; failed abort retirement/resume | Real CLI model clamping/config transitions, extension behavior, actual compaction/abort timing and MCP tool/config trust boundaries remain unverified. |
| omp | Pi-family coverage plus native command acknowledgement/result lifecycle, followups, Fast RPC effective-state/retry handling and abort-failure recovery | Actual Fast availability per installed version/model, command extensions, native plan tool restrictions and MCP/auth behavior remain unverified. |
| OpenCode | Awaited permission changes; failed abort retirement/resume; prompt/SSE fixtures; message-indexed event routing; bounded finalized replay and retired part IDs; native server configuration seam | Actual server SSE ordering across abort/new send, authenticated MCP calls/config inheritance, native summarize timing, and Windows/WSL remain unverified. Native SSE transport reviewed separately by another reviewer. |

### Performance and ease of use

No new measured performance claim. Existing Pi/omp settlement still awaits optional session statistics for up to four seconds (`piFamily.ts:951–975`); this remains a measurement candidate, not an additional defect. OpenCode replay caps and indexing are structural bounds, not measured RSS or end-to-end latency. Permission state and cancellation ownership are the concrete usability issues in this pass; no new UI or provider abstraction is needed.

### Validation and limits

- Independently reran eight current provider suites: `claudeLive`, `claudeProtocol`, `piClient`, `piQueue`, `piProtocol`, `ompLive`, `opencodeLive`, `opencodeProtocol`: **200/200 tests passed**. Log `/tmp/round3-other-tests.log`.
- New outside-repo diagnostic: **1/1 reproduced** as detailed above; copied existing tests were skipped by the `round3` filter.
- Full web 3,137 and Rust 452 passes were supplied as prior evidence by the parent, not rerun by this reviewer. No release-build performance measurements, native GUI/CLI prompts, authenticated service tests, MCP auth/tool calls, or Windows/WSL runs were performed.
- Graph first: list_projects/index_status, symbol search, applyModel caller trace and snippet, then coverage for all five provider files, child.ts and all eight test paths. Project `Users-kacperkepinski-Developer-personal-monocode` remains ready generation `2026-09-13T15:07:47Z`, rooted at the original checkout. Claude/OpenCode paths have changed metadata; new piQueue is missing there; nominal matches for Pi are still another checkout. Current worktree source was authoritative. No reindex/shared daemon changes. Graph coverage is best effort and does not prove exhaustive review.
- Memory `MEMORY.md:480–481` was used only for initial provider-seam orientation; current findings use current source. Its older global-only OpenCode discovery statement was not used as current evidence. Rollout `01a07ffd-7eb0-7083-99e7-89662a162e3f`.

---

### Final focused recheck — Claude interrupt repair

**Verdict: the round-3 P1 above is fixed in the current source.** This section supersedes the earlier open-finding status; no additional open defect was found in this focused recheck.

- `claude.ts:390–410` reuses the correlated control waiter for interrupt and permission requests, with the existing 8-second deadline and cancellable child write.
- `claude.ts:765–776` processes the matching control response before muted content is discarded. Unrelated request IDs do not confirm stopping.
- `claude.ts:436–469` surfaces rejected/timed-out interrupts, then retires the stopped host. Successful interrupt acknowledgement also retires it, so an old unidentifiable result cannot settle a later turn. The saved provider-session binding is retained and the next explicit send spawns with `--resume sess_1`.
- Conservative host retirement adds one fresh Claude startup after Stop. That is a deliberate ownership guarantee; native latency cost was not measured.

**Independent checks:** Changed the outside-repo diagnostic from asserting the broken behavior to three correct-behavior scenarios: successful acknowledgement, explicit error, and missing acknowledgement. Each first delivers an unrelated response ID and verifies Stop remains pending. Each verifies retirement, appropriate error/no-error reporting, a new host with the same resume binding, and that a late result passed directly through the retired host's captured line callback does not settle or emit completion for the resumed turn. The new host's own result completes it. **3/3 passed**, log `/tmp/round3-other-recheck-diagnostics.log`.

Independently reran the current `claudeLive.test.ts` and `claudeProtocol.test.ts`: **71/71 passed**, log `/tmp/round3-other-recheck-claude.log`. Command: `NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run src/lib/harness/claudeLive.test.ts src/lib/harness/claudeProtocol.test.ts`.

Current source and the new durable regressions were read directly. Refreshed graph coverage for Claude source and both test files again reports original-checkout metadata_changed, so source remains authoritative; no reindex. This recheck made no repository edits and did not rerun other provider/native acceptance or expand into another broad review. The installed CLI's actual stop/resume persistence and performance remain live acceptance limits.

---

## Shared UI and native transport

## Round 3 — independent shared UI and native transport review

Reviewed read-only in `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, branch `perf/agent-harness-reliability`, base `348c22e07723c32cd683483eb07e58952e08e88b`, including authorized uncommitted repairs. No repository edits, commits, restarts, live prompts or external mutations by this reviewer.

### Verdict

| Item | Result | Evidence |
| --- | --- | --- |
| U1 — queued Plan intent | PASS for repaired trigger | Automatic/manual callbacks share `queuedMessageOptions`; busy Plan is blocked in queue guard and button; idle manual send retains Plan. |
| U2 — pending decision owner | PASS for repaired trigger | All three callbacks use `sessionDecisionHarness`, preferring active ownership and armed handoff source. |
| U3 — earlier question correction | PASS for repaired trigger | Back retains answers; mounted numeric/required-field correction tests exercise actual ACP conversion. |
| U4 — compaction settings acknowledgement | PASS for repaired trigger | `startSessionActivity` captures settings before IO; current reducer preserves newer selection; completion uses `stopStreaming`. |
| T1 — terminal output precedes exit | PASS for repaired ordering | stdout/stderr completion channels plus shared emission gate; real-child terminal-tail regression passes. |
| T2 — idle SSE cancellation | PASS for repaired cancellation | abortable Tauri task, stop-before-install guard, current local-socket termination test passes. |
| T3 — exit cleanup versus replacement SSE | PASS after coordinator follow-up | Atomic `remove_exited_child` holds admission lock through stream stop; independent lock-boundary probe and new regression pass. |

### Resolved P2 — old native exit could silently abort a replacement stream

**Source before coordinator follow-up:** `src-tauri/src/harness.rs:703–704`: `remove_if_pid` releases `inner`, followed by unconditional `stop_sse` for the same session. `replace_client_sse` itself correctly serializes generation admission with the same `inner` lock, but the exit path does not preserve that boundary.

**Trigger:** The old CLI exits. Its wait thread removes the old child, then is descheduled. A concurrent replacement startup installs the new child and a newer SSE generation. The old wait thread resumes and stops the session's new SSE. New child remains live; new stream is aborted. New async stop suppresses the end event for an explicitly closed stream, so the replacement can lose its completion channel without an SSE-end notification. This race existed in the pre-T1/T2 source; it is a remaining current ownership defect, not claimed as newly introduced by the repair.

**Deterministic evidence:** `/tmp/round3-native-owner-probe.rs` extracts the byte-current production ownership methods (`lock_inner`, `remove_if_pid`, `replace_client_sse`, `insert_sse`, `stop_sse`) and `LiveSse`; minimal inert process/task types isolate the map/stop boundary. It interleaves old removal → replacement insertion/open → old stop. Expected new stream survives; actual failure is `old exit stopped replacement SSE`. Result `/tmp/round3-native-owner-probe.log`; run `rustc --test /tmp/round3-native-owner-probe.rs -o /tmp/round3-native-owner-probe && /tmp/round3-native-owner-probe --nocapture`.

**Minimal fix:** Add one owning exit-cleanup method that checks/removes the current child and stops its SSE under the same `inner` lock, preserving established `inner → sse` lock order. Use it at this exit callsite. Keep unrelated removal behavior unchanged. Verify replacement-before-cleanup and cleanup-before-replacement outcomes. Coordinator implemented `remove_exited_child` and changed the exit callsite; see independent follow-up below.

### Fresh checks

- Focused UI: **5 files / 66 tests passed**, `/tmp/round3-ui-focused.log`. `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/chrome/Composer.test.ts src/chrome/QuestionForm.test.ts src/lib/harness/apply.test.ts src/lib/messageQueue.test.ts src/lib/session.test.ts`.
- Prior independent actual-callback/component regressions freshly rerun against current code: **5/5 passed**, `/tmp/round3-ui-existing-regressions.log`, fixture `/tmp/round2-ui-fixture/review.test.ts`.
- Native harness suite: **42 passed, 1 authenticated Muse smoke ignored**, `/tmp/round3-native-focused.log`. `CARGO_TARGET_DIR=/Users/kacperkepinski/.cache/monocode-harness-target cargo test --offline harness::tests:: -- --test-threads=4`.
- New independent deterministic owner probe: **1 expected-behavior assertion fails**, establishing T3 above.
- Full Rust/web results reported by the coordinator were not independently rerun; the numbers above are this reviewer's fresh checks.

### Evidence and limits

Read worktree AGENTS.md and docs/PRODUCT.md plus exact U1–U4/T1–T2 findings. Used Codebase Memory and Ponytail review guidance. Graph project `Users-kacperkepinski-Developer-personal-monocode` is the original checkout, generation `2026-09-13T15:07:47Z`; graph search → QuestionForm trace → snippet established the original boundary, and coverage was checked for every relied-on code/test/config path. Metadata changed/missing/not tracked for relevant files and graph belongs to a different checkout; current worktree source is authoritative throughout. No reindex or repository graph artifacts.

Native ordering test uses a real child plus production drain helper, not a mounted Tauri event loop. SSE test exercises real loopback socket cancellation, not authenticated OpenCode or Windows/WSL. UI tests cover actual callbacks and mounted component recovery, not a full native App/provider run; prior browser correction evidence was supplied but not rerun. No release performance measurement was added. The emission gate adds a small mutex per stdout/stderr line; cost is unmeasured. The 1-second bound limits exit waiting/emissions but does not wake a reader blocked forever in a descendant-held pipe; that pre-existing resource lifetime remains an explicit limit. No extra framework or UI surface is needed.

### Independent follow-up after atomic exit cleanup

**Final bounded verdict: no remaining confirmed blockers in U1–U4/T1–T2 plus the discovered T3 ownership race.**

Current `src-tauri/src/harness.rs:285` checks the PID, removes that child and stops its stream while retaining `inner`. Current wait callback at `:713` calls only this method. All source paths acquiring both locks keep `inner → sse`; the repair adds no reverse lock order and leaves other `remove_if_pid` callers unchanged.

A second outside-repository fixture, `/tmp/round3-native-owner-fixed-probe.rs`, re-extracts the current production methods. Its task-abort hook tries to acquire `inner` during stream stop and verifies admission is still locked, directly checking that the original interleaving is impossible. It then installs a replacement and replays old cleanup, verifying new PID and stream survive. **1/1 passed**, `/tmp/round3-native-owner-fixed-probe.log`. Task abort is stubbed for lock observation; native socket abortion remains covered by the real local socket test.

Fresh final native harness rerun: **43 passed, 1 authenticated smoke ignored**, `/tmp/round3-native-final.log`, including `exited_child_cleanup_never_stops_a_replacement_stream`, idle SSE cancellation, stop-before-install, stale stream generations and terminal-output drain. Previous UI 66 + 5 checks remain applicable because this follow-up changes only native exit cleanup/tests. No additional frontend edits, native UI run, provider prompts or performance measurements were performed.
