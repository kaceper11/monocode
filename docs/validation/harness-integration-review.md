# Harness integration review

Implementation follow-up: [fixes and validation](harness-integration-fixes.md). Findings below record the pre-fix review snapshot.

Date: 2026-09-15. Reviewed branch `perf/agent-harness-reliability`, base `348c22e07723c32cd683483eb07e58952e08e88b`, including its existing uncommitted changes. Four fresh GPT-6 Astra reviewers independently covered all 11 conversation harnesses; the coordinating reviewer checked shared process transport and consolidated their results.

## Conclusion

The integrations do not yet meet the requested CLI-like reliability. Existing improvements help specific measured stages, but cancellation, effective settings, follow-up admission, recovery and question handling still have concrete gaps. The review also found a new display regression in the recent user-message Markdown change. Most other findings concern pre-existing integrations; this is a review of current behavior, not a claim that the patch introduced every defect.

No production changes, real provider prompts, app restarts or commits were made during this review. This document records findings and a repair order. The previously launched app remains the prior implementation.

## Repair order

| Order | Problem and affected integrations | Why it comes first |
| --- | --- | --- |
| 1 | Work survives cancellation during admission (Muse/Codex); startup can outlive removal (reproduced for Pi, shared by omp) | The user can believe execution stopped while tools can still run. Fence ownership across every awaited startup/admission boundary. |
| 2 | Required permission changes are ignored (Muse) or not awaited (OpenCode) | A newly supervised/plan prompt can execute under the previous permission posture. Dispatch only after confirmation; expose failure. |
| 3 | Stale child output is routed by session alone; blocked native writes defeat RPC deadlines; Cursor has unbounded RPC waits | These cause cross-turn corruption, stuck sessions and potentially blocked native UI work. Fix the existing bridge and request boundaries. |
| 4 | Early/late followups are accepted without actual steering readiness (Claude/OpenCode/Cursor) | Accepted input can fail after its draft was cleared and falsely mark the main turn idle. Queue until a real active turn exists. |
| 5 | Model/effort rejection is hidden; Pi/omp skip initial effort; Codex steer displays the wrong model after a picker change | Selected, requested and effective settings must agree. Mid-turn changes need explicit next-turn semantics. |
| 6 | Rejected decisions lose controls; custom/numeric/concurrent questions lose answers | Repair existing question/approval state and native reply serializers; preserve recoverable pending requests. |
| 7 | Failed resume silently starts new context; ACP terminal reasons are discarded | Preserve session identity on failure and explain incomplete/refused turns. |
| 8 | Literal user tags disappear; Codex repeats final text; Muse internal reminders become transcript rows | Preserve prompt fidelity and keep internal lifecycle progress in one transient indicator. |
| 9 | Long-lived child/part indexes grow; nested Muse subscriptions exhaust their cap | Bound completed state without losing active children or late events, then measure sustained-session costs. |

Detailed triggers, exact worktree locations, minimal fixes and proposed regressions appear below. P1 denotes high-priority execution/lifecycle problems; P2 denotes other confirmed correctness/UX/retention defects. Source-proven unbounded state is not a measured memory regression.

## Coverage across all harnesses

All providers also depend on shared app dispatch and child lifecycle, although OpenCode uses HTTP/SSE for conversation traffic rather than JSON-RPC stdin.

| Harness | Principal current gaps | Settings / MCP acceptance |
| --- | --- | --- |
| Muse | Cancel-before-ack; rejected decisions disappear; nested child subscriptions; permanent reminder statuses | Rejected model/approval changes are swallowed. Actual native MCP discovery/auth unverified. |
| Codex | Cancel-before-ack; duplicate snapshots; unbounded child maps; mid-turn model attribution | Per-turn model/effort mapping exists. Complex MCP forms/sign-in explicitly unsupported; actual MCP inheritance unverified. |
| Devin | Failed resume resets context; unbounded ACP child indexes | Rejected model controls can be swallowed; numeric elicitation becomes text. Actual MCP inheritance unverified. |
| Copilot | Failed resume resets context; unbounded ACP child indexes | Model rejection checks stronger than peers; effort recycles/resumes host. Numeric elicitation becomes text; live CLI/MCP acceptance remains outstanding. |
| Cursor | Unbounded waits; false steering readiness; custom answers lost; stop reasons ignored; resume reset | Model/settings errors swallowed; native MCP inheritance unverified. |
| Grok | Resume reset; stop reasons ignored; unbounded ACP child indexes | Model/effort errors swallowed. Launch-level access changes and actual MCP behavior require live verification. |
| fx | Resume reset; stop reasons ignored; unbounded ACP child indexes | Settings errors swallowed; no question/attachment/compaction capability advertised by adapter. Actual MCP behavior unverified. |
| Claude | False early/late steering readiness; startup invalidation needs repair/verification | Launch model/effort with resume; live permission acknowledgements and MCP inheritance unverified. |
| Pi | Startup resurrection; broad resume reset; extension select/input unusable | Cold/rejected effort divergence; MCP support depends on native extensions/config and was not exercised. |
| omp | Same Pi lifecycle/effort; overlapping questions become unreachable | Native workflow questions supported individually; real extensions/MCP unverified. |
| OpenCode | Permission-tightening race; false steering readiness; retained full parts and historical scans | Per-prompt model/variant; HTTP/SSE lifecycle. Real native MCP/config/auth acceptance unverified. |

### MCP interpretation

Configured is not the same as connected. The existing Extensions UI reads native configuration; it does not prove a server launched, authenticated or supplied tools. ACP adapters pass `mcpServers: []`, meaning no app-supplied session server list. This alone does **not** establish that native CLI configuration is disabled. Existing synthetic MCP tests cover event/permission mapping, not actual inherited server behavior.

Live acceptance needs one configured server per supported provider, a successful tool call, denied approval, a disconnected/failed/auth-required server, native config change/reconnect, and supported elicitation shapes. Test the selected execution host and worktree, including Windows-to-WSL separately. Reuse the existing settings surface for concise configured/connected/reconnect information; a new MCP dashboard is unnecessary.

## Performance evidence and next measurements

No new provider latency or release CPU/RSS benchmark ran in this review. Test-suite wall time is not application latency.

Previously recorded evidence, refreshed from the existing artifacts:

- [Provider A/B](harness-before-after.md): Muse, Devin and Codex samples show no consistent first-content improvement; all paired uncertainty intervals include zero. Codex warm reliability improved from 0/10 to 10/10. This measured native provider adapters, excluding Tauri/WebView/checkpoints; it does not cover all 11 harnesses.
- [Release checkpoint stage](checkpoint-latency.md): 250 dirty files fell from 2,392 ms to 69 ms median; clean trees from 58.3 ms to 36.4 ms. This is shared pre-send work, with end-to-end savings depending on overlap and whether a checkpoint already exists.
- [Streaming reducer](streaming-latency.md): the large-history batched fixture fell from roughly 0.95 ms to 0.13 ms. That is a sub-millisecond reducer CPU saving, not seconds of model latency.

New source-backed performance candidates: off-main-thread bounded writes, retiring completed child/part state, avoiding OpenCode historical part scans, and Pi/omp waiting up to four seconds for optional post-turn stats. The stats wait is a candidate to measure before changing completion behavior; do not falsely mark a still-running provider idle.

After correctness repairs, compare direct CLI and release app under matching model, effort, permission mode, MCP configuration, cwd, prompt and account. Record separately: accepted submission, preparation/checkpoint, process/handshake, confirmed settings, provider write, first content, first rendered content, answer completion, and actual provider idle. Include cold/warm, rapid followup, tool-heavy, MCP-heavy, long-history and cancellation workloads; report failures as failures, never fast successes. Use independent timing identity for each followup. Report backend/WebView/provider CPU and RSS separately, hardware and sample variability, with no concurrent builds.

## Shared transport findings

### P1 — Old stdout/stderr can reach a replacement child

Locations: `src/lib/harness/child.ts:6`, `:81–95`; `src-tauri/src/harness.rs:28–31`, `:698–708`.

Line events contain only session ID and text. Replacement children reuse the session ID, and the frontend dispatches to whichever handler is currently registered. Exit events already check PID, but line events cannot. An old process reader or queued native event can therefore deliver old protocol output to the new process's client. New JSON-RPC clients reuse request IDs starting at one, adding a response-misattribution risk.

A mocked bridge regression reproduced old `turn/completed` output reaching the replacement handler after child replacement. This proves the missing isolation at the boundary; it does not establish that a specific user's live transcript was caused by this race.

Smallest fix: include process identity/generation on every child event and reject stale events at the shared receiver, preserving early output for the correct pending spawn. Verify stdout, stderr, exits and startup buffering; do not add delay-based workarounds.

### P1 — A blocked native write defeats RPC timeout and can block the native main thread

Locations: `src/lib/harness/jsonRpc.ts:103–141`; `src-tauri/src/harness.rs:641–660`.

The request creates a response timeout but awaits the native write before returning that response promise. When the write remains unresolved, timeout rejects only the internal response; the outer caller remains pending. A deterministic test held the write unresolved, advanced past its deadline, and confirmed that the request had not settled.

The native command is synchronous and takes a mutex, writes to child stdin and flushes. A child that stops reading can fill the pipe and block this command. Tauri documents that synchronous commands execute on the main thread unless explicitly marked otherwise: [Calling Rust from the frontend](https://v2.tauri.app/develop/calling-rust/). The UI-freeze risk is source-backed; no deliberately blocked native GUI experiment was performed.

Smallest fix: move blocking writes off the interactive thread with ordered, bounded per-child work, and ensure the request deadline covers both send and reply. Cancel/retire the owned stuck child safely. Never automatically replay a write whose delivery is uncertain. Tests must hold a write pending through timeout/cancel and check queue bounds/ordering and subsequent recovery.

### P2 — Muse reminder bookkeeping leaks into permanent transcript rows

Locations: `src/lib/harness/museProtocol.ts:499–515`; `src/lib/harness/muse.ts:1075–1100`; `src/lib/harness/apply.ts:168–169`, `:561–576`.

`reminderChild` start uses provider fallback text such as “Reminder child session” as a generic status. The reducer appends status as a permanent system block. `reportDrain` adds another generic status once the answer has finished and internal work remains. Only adjacent duplicate status text is suppressed; intervening content permits repeated reminder rows. This explains the user's quoted transcript.

This is Muse memory/recall/reconciliation work, not a user-created reminder task. The host may still be busy after the visible answer. The correctness fix that waits for real `turn/completed` must remain.

Smallest fix: show one transient finishing indicator on the existing turn activity surface, hide internal reminder child labels from ordinary history, clear it at real completion, and continue queueing followups while draining. Retain diagnostics in the existing expandable detail surface where useful. Test reminder start, answer completion, repeated reminder events, actual completion and a queued followup; no extra permanent rows and no premature readiness.

## Validation during this review

| Reviewer | Existing tests passed | Scope |
| --- | ---: | --- |
| Astra Muse/Codex | 264 across 12 file runs | Protocol, lifecycle, approvals, questions, attachments, catalogs, stream text |
| Astra ACP | 172 across 11 file runs | Devin, Copilot, Cursor, Grok, fx and child routing |
| Astra other providers | 196 across 13 file runs | Claude, Pi, omp, OpenCode and shared attachments/catalogs |
| Astra workflow/UI | 94 across 9 file runs | Composer, picker, transcript, queue, state and models |

These are **726 passing test executions**, with repeated shared suites across reviewers; they are not 726 unique tests. Tests with `Live` in their filename mock transport. The previously completed full web/Rust checks were not rerun or claimed as new review validation.

Additional diagnostics against unchanged current source:

- Two temporary invariant tests failed as intended: stale stdout reached the replacement child, and a blocked write outlived its RPC deadline. Four existing child tests passed in that diagnostic run. The temporary test files were removed afterwards.
- Actual Pi/OpenCode modules bundled with in-memory IO mocks reproduced startup after forget, skipped initial effort, cached rejected effort, and prompt dispatch before permission update confirmation.
- The installed Markdown pipeline rendered `Change <T> to <U>.` as `Change  to .`; provider input itself remained unchanged.
- The actual Codex stream helper returned the already-streamed final answer again when passed the accumulated previous and current message text, consistent with the traced adapter path.

Local evidence files (temporary, not portable repository fixtures): `/tmp/monocode-review-repros.py`, `/tmp/monocode-review-repros.log`, `/tmp/astra-other-providers-repro.mjs`, `/tmp/astra-other-providers-repro-results.jsonl`. Commands and reviewer evidence are preserved in the appendices. These diagnostics are not permanent regression coverage; implementing each repair requires adding its regression at the existing owning boundary.

Not verified in this review: authenticated provider/MCP execution, end-to-end native UI scenarios, release latency/CPU/RSS, Windows or Windows-to-WSL, remote account behavior, and every provider's native command implementation. The review concentrates on conversation integrations, not one-shot title/Git helpers or an exhaustive security audit.

## Review method

All four Astra agents started fresh with disjoint scopes. They read repository guidance, used graph-first discovery and coverage checks, and verified current worktree source. The graph project `Users-kacperkepinski-Developer-personal-monocode`, generation `2026-09-13T15:07:47Z`, belongs to the original checkout; metadata matches there are not freshness proof for this worktree. Current source superseded stale graph ranges. No shared graph service or runtime was changed. The original source-hash snapshot is `/tmp/monocode-review-source-hashes.json`. Final verification matched all 750 tracked source files against that snapshot; temporary review tests were absent. `git diff --check` passed, and the new document had no trailing whitespace.

The independent reports follow, retaining exact anchors, evidence limits and concrete regression suggestions. Their read-only statements refer to production/tests; the coordinator added this review document only.


## Fresh Astra review — Muse and Codex

Reviewed current uncommitted worktree `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, HEAD `348c22e07723c32cd683483eb07e58952e08e88b`. Read-only: no repository modifications, live prompts, app restarts, commits or external writes. All file references below are relative to this exact worktree, not the indexed original checkout.

### Confirmed findings

#### 1. P1 — Stop during turn admission does not cancel the admitted provider work (both providers)

- **Locations:** `src/lib/harness/codex.ts:300-307`, `:645-655`; `src/lib/harness/muse.ts:438-465`, `:870-891`.
- **Trigger:** after `turn/start` is sent, click Stop before its response and before `turn/started` supplies an ID.
- Both cancellation handlers only interrupt IDs already known locally. Codex clears its turn waiter; the eventual acknowledgement no longer satisfies `live.turnDone`, so its ID is discarded without an interrupt. Notifications are muted while the provider continues. Muse clears the existing waiters, then the later acknowledgement sets `activeTurnId` and registers a new waiter even though `cancelled` is true. Neither reconciles the newly admitted turn with the pending cancellation.
- **Impact:** the UI shows stopped while the agent can still execute tools or spend tokens. Muse's following send remains behind the abandoned waiter until the original provider turn ends (or its 30-minute timeout/idle host stop); Codex can send a new turn while the supposedly cancelled one still runs. `App.tsx:6812-6834` uses cancellation and marks the UI stopped; `registry.ts:236-244` does not immediately kill the provider as a fallback.
- **Small fix:** retain cancellation through admission, then interrupt/unqueue the exact returned ID before completing the cancelled send; alternatively recycle the owned host when admission cannot be reconciled safely. Do not replay input.
- **Regression:** delay the start acknowledgement, cancel, then acknowledge a started and queued turn; assert the exact admitted ID is interrupted/unqueued, the send settles, and the next prompt works. Existing normal-cancel and stop-session tests do not exercise this cancel-before-ack sequence.

#### 2. P1 — Muse silently continues after rejected model or approval-mode changes

- **Locations:** `src/lib/harness/muse.ts:826-848`, `:894-898` (also the fire-and-forget mode update at `:247-282`).
- **Trigger:** an existing/resumed host rejects `session/setModel` (unavailable model/invalid selection) or `session/setApprovalMode` with a non-transport RPC error.
- `ignoreUnsupportedControl` ignores every error whose message does not match a short transport-error regex, including explicit validation, permission, auth and unsupported-method errors. `Promise.all(controls)` therefore succeeds and submits the prompt under the host's previous settings.
- **Impact:** model selection is silently ineffective. Changing from `auto-accept-edits` to `supervised` uses the same host posture, so a rejected approval-mode change can leave provider-side auto-approval active while the UI advertises supervision. A local approval handler cannot recover approvals the host never asks it to decide.
- **Small fix:** propagate failed required setting changes and withhold `turn/start`; if an older host lacks a required control, restart/resume with a supported verified posture or report the capability limitation visibly. Do not treat arbitrary RPC failures as unsupported optional controls.
- **Regression:** reject each setting with a structured non-transport error; assert no prompt is sent and the prior effective settings are not advertised as changed. Include auto-accept-edits → supervised on a warm host.

#### 3. P2 — Codex duplicates later streamed message/reasoning snapshots

- **Locations:** `src/lib/harness/codex.ts:741-750`, `:928-944`; `src/lib/harness/streamText.ts:42-49`.
- **Trigger:** one turn contains streamed commentary A, a tool, then streamed final answer B; both messages get `item/completed` snapshots.
- The deduplication buffers span the entire turn. After B streams, `emittedAssistant` contains A+B. `snapshotRemainder(A+B, B)` does not recognize B as the already-streamed current item and emits B again. Reasoning uses the same mechanism. The completed-message event seals the UI block but never resets the provider's per-role buffer.
- **Impact:** duplicated final paragraphs and malformed-looking conversation output after ordinary tool use.
- **Small fix:** track snapshot deduplication by provider item ID (or reset correctly at item boundaries with sufficient identity protection), keeping turn completion separate.
- **Regression:** two different streamed agentMessage items in one turn with a tool between them, each followed by its completed snapshot; assert every text appears once. Repeat for reasoning.
- **Direct helper reproduction run:** `joinStreamText('I will inspect the code.', 'The bug is fixed.')` gives the combined buffer; `snapshotRemainder(combined, 'The bug is fixed.')` returns the entire final answer again. This is a helper reproduction plus source trace, not a new end-to-end adapter test.

#### 4. P2 — Rejected Muse decisions leave a blocked host with no actionable prompt

- **Locations:** `src/lib/harness/muse.ts:295-305`, `:324-362`, `:370-413`.
- **Trigger:** Muse definitively rejects `approval/decide` or `userInput/answer` while retaining the pending provider request (for example validation or temporary server rejection).
- Approval resolution is emitted before the RPC succeeds. On ordinary rejection, `decidedLocally` remains set, so future clicks and reissued requests cannot re-open it. Questions are removed from both maps before sending; rejection emits only a status line. The missing-allow/deny-choice path also removes an unresolved approval without submitting any decision.
- **Impact:** the conversation stays waiting but its approval/question controls have vanished; the user must abandon or restart the turn.
- **Small fix:** retain pending state until confirmed acceptance; restore an actionable request on a definitive rejection. For timeout/uncertain delivery reconcile with provider state rather than automatically replaying a consequential decision.
- **Regression:** return a definite RPC error from each decision command; verify the prompt can be answered again without duplicate decisions. Test a choice set without the selected allow/deny outcome.

#### 5. P2 — Nested Muse subagents never release follow slots

- **Locations:** `src/lib/harness/museSubagents.ts:140-153`, `src/lib/harness/muse.ts:1168-1172`; contrast root completion cleanup at `:1150-1151` and `:1298-1316`.
- **Trigger:** a followed child spawns a grandchild and its nested subagent item completes.
- Nested item events only produce `follow` instructions, including terminal item events. They never call `endChildSession`. Only main-session subagent item completion invokes that cleanup, and root cleanup unregisters just its own child, not descendants. Child `turn/completed` also has no cleanup path in the trail router.
- **Impact:** completed nested sessions remain subscribed and retain their maps for the live host's lifetime. After enough such children the fixed 16-follow cap is exhausted and new subagent activity silently disappears. Each retained child's `prose` map also grows with distinct message IDs despite its per-message character cap.
- **Small fix:** route nested terminal items to the existing final-drain/unsubscribe path, and tear down descendants belonging to a completed root when appropriate.
- **Regression:** sequentially spawn and complete more than 16 nested children across turns; assert unsubscribe calls and that the latest child still produces steps, without removing another active root's children.

#### 6. P2 — Codex retained subagent state is not bounded over a long live session

- **Locations:** `src/lib/harness/codex.ts:818`, `:856-859`, `:947-970`.
- **Trigger:** a long session keeps spawning new children (or receives opening events for children that are never matched to a spawn row).
- `subagentThreads` never deletes completed mappings. The 64-notification guard is per unknown child; the outer `pendingSubagent` map has no child/count/byte bound. Turn completion clears openAgentRows but neither of those retained maps.
- **Impact:** memory retained grows with historical child IDs and unmatched event payloads throughout a continuously active host. The registry's five-minute idle park limits idle retention but does not bound a long active session.
- **Small fix:** retain a bounded recent mapping set and bounded global pending-event budget, dropping/retiring settled entries at an explicit lifecycle boundary while preserving active children.
- **Regression:** feed many completed/missing-spawn child IDs over multiple turns; assert retained counts/bytes remain bounded and recent active children still route correctly.

### Coverage matrix and acceptance limits

| Scenario | Codex | Muse |
| --- | --- | --- |
| Cold/warm send and prewarm | Source: shared-start dedupe, warm host reuse, scoped tests passed. Startup identity/removal races also owned by shared reviewer. | Same; posture change intentionally respawns/resumes. |
| Cancel/remove | Normal cancel/stop-session covered by existing mocks; admission cancellation defect #1. Parent owns shared removal generation/transport race review. | Normal cancel and queued-start ordering covered; admission defect #1. |
| Follow-up during tools/final answer | Active turn readiness exposed; message completion separate from turn completion. Text defect #3. | Readiness requires real open work; final bookkeeping keeps original send pending so composer queues. Existing drain/retry/late-terminal tests passed. |
| Resume/compaction | Native thread resume with missing-thread fallback, approval requests buffered, compaction awaits terminal. No authenticated resume/compaction smoke run here. | Durable session resume and pending requests handled; compaction waits for item terminal with timeout/cancel tests. No live smoke run here. |
| Prompts/attachments | Native text/image/localImage and file-path mentions inspected; 20 attachment tests plus shared file tests passed. | Images with bytes sent natively; other attachments sent as path text. Shared file-attachment tests passed. |
| Approval/questions | Normal approvals, optional question timers, secret rejection and MCP confirmation/form limitation covered by mocks. | Server choices/tokens, user questions and stale approval retry covered; rejected-decision recovery defect #4. |
| Model/effort changes | Per-turn model/effort wire mapping, catalog parsing and Default fallback covered by mocks. No live model/effort transition executed. | Model is session control, effort is per turn/steer; silent setting failure #2. No live transition executed. |
| MCP | Native app-server startup; tool item mapping and boolean confirmation elicitation supported. Complex forms/browser sign-in explicitly cancelled with visible unsupported status. | Native serve host; MCP tools recognized and approval modes handled. |
| MCP inheritance acceptance | Adapter does not inject a separate MCP configuration; actual host/config/account inheritance and real MCP operations were not exercised. | Same limitation; no claim of successful MCP inheritance from mocks. |
| Clean/internal events and child activity | Retry/fallback diagnostics suppressed and unknown/internal types ignored. Child rows deduped. Findings #3/#6. | Reminder work becomes compact status lines, child trails nest under parent. Finding #5. |
| Performance | Warm process/catalog reuse observed in source; no release-build CPU/memory/latency benchmark run here. | Parallel setting controls and catalog throttle observed; child history paging bounded per walk; no release measurement run here. |

Choice/acceptance distinctions: Muse bookkeeping status text and read-only planning behavior are product choices, not findings by themselves. Codex deliberately rejects unsupported MCP forms rather than inventing responses; that is a documented capability limitation. Existing tests cannot establish authenticated provider behavior, host MCP inheritance, WSL/native Windows, or measured release performance. I did not audit Codex one-shot title/Git text-generation modules beyond their adapter wiring; this review concentrates on conversation hosts, protocol, catalogs and subagent trails.

### Tests actually run

1. `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/harness/codexLive.test.ts src/lib/harness/codexProtocol.test.ts src/lib/harness/codexApprovalUi.test.ts src/lib/harness/codexAttachments.test.ts src/lib/harness/codexElicitation.test.ts src/lib/harness/codexQuestions.test.ts src/lib/harness/museLive.test.ts src/lib/harness/museSubagents.test.ts` — **8 files, 201 tests passed**, 2.17s wall duration reported by Vitest.
2. `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/harness/catalogContext.test.ts src/lib/harness/fileAttachments.test.ts src/lib/harness/streamText.test.ts src/lib/models.test.ts` — **4 files, 63 tests passed**, 337ms reported by Vitest.
3. Node strip-types invocation of current `joinStreamText`/`snapshotRemainder` reproduced finding #3's repeated final snapshot. No repo test added.

### Evidence provenance

Read AGENTS.md and docs/PRODUCT.md; used Codebase Memory and Ponytail review guidance. Graph project `Users-kacperkepinski-Developer-personal-monocode`, generation `2026-09-13T15:07:47Z`, points to the ORIGINAL checkout. Initial graph search found Muse/Codex symbols; `trace_path` ran both directions at depth 1 for sendMuseTurn/sendCodexTurn, then snippets were retrieved. Graph discovery results were provisional; all findings rely on current worktree source.

`check_index_coverage` was run on every cited/reviewed principal path, tests and relevant `src/lib/harness` scope. No recorded parse gaps; many provider paths are metadata_changed; Muse subagent files are not_tracked in the original graph metadata. Scope response has_more=false. The broad initial symbol search was capped (100 of 176); no exhaustive graph claim is made. Exact provider source inventory and direct current source reads supply the bounded review evidence. No reindex or graph service mutation performed.

Minimal memory pass used `MEMORY.md:480-481` for existing-provider seam orientation only; findings were independently verified in the current worktree.

SHA-256 source hashes at handoff:

```
97a117720c564b27474257b629263737652bc6e3bb37e89aa65428fb11425669  src/lib/harness/codex.ts
368361c336a8cb6982d87a19f8416dda8e444d87d668cc3cad11f3caedc2d63b  src/lib/harness/muse.ts
492e333b103de6266171aa51aa464ae58a18d02e5f953cbe7d1ce7ba0b418923  src/lib/harness/codexProtocol.ts
766fdf56a52dc06fbe0a69dc5afbd41a4a4b9481b3181e4ec882dc7be5eb7592  src/lib/harness/museProtocol.ts
03e280f516ceac7fae96acd0622165088db6f6ad733d64b5f77498e4f7f713b1  src/lib/harness/museSubagents.ts
```

## Fresh Astra review: Devin, Copilot, Cursor, Grok, fx and ACP

Worktree: `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, HEAD `348c22e07723c32cd683483eb07e58952e08e88b` plus existing working changes. Read-only review; no application restart, provider prompt, repository edit or commit. Read AGENTS.md and PRODUCT.md. Findings below describe current code, including unchanged problems, rather than assigning regressions to the current diff.

### Findings

#### 1. P1 — Cursor startup can wait forever, and cancelling during startup does not release it

`src/lib/harness/cursor.ts:367-374` sends initialize and authenticate without a timeout; load/new, settings and prompt do likewise (`383`, `400`, `489`, `514`). `src/lib/harness/acp.ts:73` defaults timeout to zero. Until setup finishes, no Live is installed. `cursor.ts:223-227` therefore handles Cancel by recording a marker and returning, without cancelling the actual ACP request.

Trigger: Cursor process stays alive but never answers initialize or authenticate (network/auth/service hang); click Cancel. The original send remains unresolved indefinitely. Warm settings and prompt hangs are also unbounded. This is independent of the parent's shared JSON-RPC pending-write finding.

Smallest fix/check: add the same bounded handshake/control/prompt timeouts used by Devin/Copilot and make startup cancellation reject its owned client. Add an existing-style mocked lifecycle check withholding initialize, cancelling, and verifying the send settles and the owned child is retired.

#### 2. P2 — Four providers silently run on the previous model/effort after an explicit selection fails

`devin.ts:657-661` catches set_config_option rejection; `ignoreUnsupportedControl` only rethrows transport-looking text. `cursor.ts:463-477` swallows both model controls and settings failures. `grok.ts:493-518` does the same for model/effort; `fx.ts:429-443` for model/settings.

Trigger: select a different model or reasoning value, then have the provider reject it with an ordinary error such as "model unavailable" or "invalid setting". Each adapter proceeds to session/prompt with no visible selection failure, using the prior provider selection. Devin/fx also do not reject a successful response whose refreshed currentValue still contradicts the requested value.

Smallest fix/check: copy the established Copilot failure behavior at the existing selection boundary: distinguish unsupported-method fallback from real rejection, stop before prompt on unhonoured explicit choices, and validate returned currentValue when available. Parameterize one rejection/no-prompt regression across these providers. Copilot's existing tests already cover rejection, missing controls and ignored config writes.

#### 3. P2 — Failed resume silently starts a context-empty conversation in the existing chat

Devin `devin.ts:544-578`, Copilot `copilot.ts:553-587`, Cursor `cursor.ts:380-404`, Grok `grok.ts:385-440`, fx `fx.ts:323-372` fall through from rejected resume/load to session/new. Devin/Copilot also skip loading when capability is absent. They overwrite resume state and emit providerBound/started, without a session error or an explicit context-reset event.

Trigger: restore/park a conversation, make its stored provider session unavailable (or reject load after a temporary auth/service failure), then send "continue the previous plan". Only the new prompt is sent to a new session; the displayed old chat is not replayed. Copilot effort changes exercise this path because they recycle the child.

Smallest fix/check: when a stored binding exists, surface resume failure and preserve it for retry; only create a new conversation through an explicit fresh-start action, or clearly signal/recover the reset. Existing tests cover successful resume, not rejection preserving history.

#### 4. P2 — Cursor drops the user's typed answer when a question offers Other/custom

`cursor.ts:704-711` serializes only selectedOptionIds, removes CUSTOM_OPTION_ID and never uses reply.custom. Shared `userQuestion.ts:202-211` enables custom input for explicit custom/allowCustom or an option labelled Other. UI reviewer independently confirmed QuestionForm renders the input and buildQuestionReply includes its text.

Trigger: cursor/ask_question with `allowCustom:true` or an Other option; type an answer and submit. The UI resolves the question, but the provider receives an empty selection or the bare Other id without the text.

Smallest fix/check: encode custom text in the native Cursor response if supported; otherwise do not offer a text input the wire contract cannot transmit. Add one request/reply test for an Other answer. This is conditional on those payloads, not every Cursor question.

#### 5. P2 — Cursor, Grok and fx discard non-success ACP stop reasons

Cursor `cursor.ts:514-528`, Grok `grok.ts:525-535`, fx `fx.ts:507-517` discard the result of session/prompt and emit completion for any resolved response. Devin/Copilot already inspect stopReason via `acpStopReasonMessage` and expose refusals, max_tokens and max_turn_requests.

Trigger: session/prompt responds `{stopReason:"max_tokens"}` with a truncated answer, or `{stopReason:"refusal"}`. These three adapters close the turn without explaining why work stopped; Cursor additionally marks background agents completed.

Smallest fix/check: use the existing shared stop-reason mapper before completion and avoid claiming successful child completion on failure reasons. Add a single non-end_turn response check per affected adapter. No live assertion about provider frequency is made.

#### 6. P2 — ACP numeric elicitation answers are returned as strings

`acp.ts:594-652` records schema type only to choose array/boolean UI, then fields retain no numeric type. `acp.ts:670-678` returns free text directly. Devin aliases this parser/serializer (`devinProtocol.ts:8-9`); Copilot uses it directly.

Trigger: an MCP form requests `{properties:{count:{type:"integer"}}}`; user types `3`. The accepted result contains `{count:"3"}`, violating the requested numeric type; a validating server rejects it or asks again. Enum numbers and booleans are preserved correctly, so this concerns free numeric fields.

Smallest fix/check: retain the requested primitive type, parse finite numeric input and validate integer/min/max constraints before accepting; alternatively reject unsupported forms visibly. Add one numeric-form round-trip check.

#### 7. P2 — Long-lived ACP sessions retain unbounded tool ownership/prose indexes

`acpSubagents.ts:13-26`, `39`, `49`, `78`: tools grows for every top-level tool id; owners grows for child tool ids; prose retains the last 2,000-character child block per parent. None is retired on parent completion or turn completion. The same AcpSubagents instance survives all warm turns in all five adapters. aliases and pending are bounded, but these three collections are not. Cursor also retains enrichedTools/toolStatuses across turns (`cursor.ts:423-426`, `507-512` does not clear them).

Trigger: repeatedly run tool/subagent-heavy turns in one warm session. These adapter indexes grow with lifetime history even if UI history is bounded/compacted. This is source-proven unbounded retention; no measured memory or latency regression magnitude is claimed.

Smallest fix/check: prune completed ownership state after the provider's late-event window, or cap retained completed entries without dropping active children. Check repeated synthetic completed turns keep index sizes bounded and preserve late child routing.

### Additional compatibility checks, not demonstrated live failures

- ACP permission parsing reduces options to their ids and ignores `kind`; auto/allow resolution assumes ids contain allow/reject (`acp.ts:491-513`, `511-570`; Cursor has its own similarly literal mapping). A valid option `{optionId:"choice-1",kind:"allow_once"}` cannot be approved correctly. The official [ACP PermissionOption schema](https://docs.rs/agent-client-protocol-schema/latest/agent_client_protocol_schema/v1/struct.PermissionOption.html) defines option_id as an identifier separate from kind. Treat this as a protocol compatibility gap until an installed provider emits opaque ids; preserve advertised semantics in the existing parser rather than inventing ids.
- Cursor/Grok/fx call ensureLive directly without the shared starting-promise map. Concurrent direct cold sends can install competing watchers/spawn attempts. Parent owns application dispatch reachability and child ownership, so this is a handoff rather than a duplicate top-level finding.
- Grok's live access-mode tightening remains effective only on the next turn for launch-level yolo/auto flags (documented at grok.ts:154 onward); real provider enforcement and UI communication require live acceptance.
- Cursor/Grok/fx startup spawn calls sit outside their handshake try/finally; failed spawn can leave adapter watchers until later teardown. Parent owns transport lifecycle confirmation.

### Provider/scenario matrix

| Provider | Initial/warm/follow-up | Completion/recovery | Model and effort | Approvals/questions/attachments/commands | Transcript and performance |
| --- | --- | --- | --- | --- | --- |
| Devin | Shared cold prewarm/send start; warm turns reuse ACP; steer sends second prompt and waits for all accepted prompts | Bounded requests; stop/cancel settle asks; successful session/load tested; failed resume resets silently | Reasoning variant uid validated against selected model's catalog; runtime writes; failure swallowed | ACP approvals, form elicitation, image/resource blocks; dynamic command update + raw slash; compact uses /compact | Child attribution and text deltas tested; early config/command updates buffered; unbounded ownership indexes |
| Copilot | Shared cold start; warm reuse; effort change recycles/reloads; folded prompt steering | Bounded requests; stop/cancel settle asks; effort-rejection fallback warning; failed resume resets silently | Strongest model rejection checks and live catalog publishing; launch --effort; fallback visible | ACP approvals/forms/image-resource blocks; dynamic/raw slash; compact uses /compact | Good child routing, string request ids, stale config handling; unbounded ownership indexes |
| Cursor | Warm ACP reuse; no cold-start dedupe in adapter; steer function exists but adapter does not advertise canSteer | Requests unbounded; startup cancel marker insufficient; load fallback resets silently; stop reasons ignored | Runtime config/model fallback and parameter settings; failures swallowed | Approvals, ask_question; conditional custom text loss; images/resource blocks; no native-command provider/compactContext advertised | Child metadata and native-store enrichment tested; active subagent polling 1s plus 3 final polls; enrichment up to 20 attempts per batch; stale maps retained |
| Grok | Warm reuse; mode/planning changes recycle; no steer | Bounded requests; native compact extension; resume/load/new fallback; stop reasons ignored | Model via set_model; effort set_mode each send, even unchanged; failures swallowed | Approvals, native questions, images; plan exit returns abandoned; no native-command provider | Structured child routing; no periodic adapter polling; unbounded ownership indexes |
| fx | Warm reuse; no steer/prewarm | Bounded requests; resume/load/new fallback; stop reasons ignored | Launch --model plus runtime config; failures swallowed | Approval support; no questions/attachments/compact/native command adapter advertised | Structured child routing; no periodic adapter polling; unbounded ownership indexes |

### MCP assessment

All five ACP adapters send `mcpServers: []` in new/load calls. They do not inject a MonoCode-managed server list. Native CLI inheritance therefore depends on the actual executable's home/project configuration and shared child environment/cwd. Parent owns verification of backend host/environment handling.

Adapters classify MCP calls and expose approval requests; auto-accept-edits keeps MCP calls gated, auto/full-access allow according to shared logic. Devin/Copilot advertise form elicitation; Cursor/Grok use native question requests; fx lacks question support. The existing tests inject synthetic MCP tool/permission events: they do not prove configured servers are discovered, authenticated, reused, or their launch failures shown. ACP session-level MCP errors have no dedicated handling in these adapters; provider-returned RPC errors and recognized auth stderr are visible, arbitrary MCP stderr generally is not. No claim that an empty ACP list disables the provider's native MCP configuration.

### Validation

Ran existing tests only:

`NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/harness/devinLive.test.ts src/lib/harness/devinProtocol.test.ts src/lib/harness/copilotLive.test.ts src/lib/harness/copilotProtocol.test.ts src/lib/harness/cursorLive.test.ts src/lib/harness/cursorSubagents.test.ts src/lib/harness/grokLive.test.ts src/lib/harness/grokProtocol.test.ts src/lib/harness/fxLive.test.ts src/lib/harness/fxProtocol.test.ts src/lib/harness/acpSubagents.test.ts`

Result: **11 files, 172 tests passed**, 1.08s wall duration. Despite the `Live.test.ts` names, these mock child transport and never contact providers. Existing coverage is useful for happy paths, permission settlement, protocol parsing and child display, but does not cover the reported negative scenarios. No production or test changes made.

Not verified: authenticated live providers, actual configured MCP inventory/transport failures, native provider model/effort acceptance, app interactions/keyboard behavior, Windows/WSL execution, release CPU/RSS/input latency, remote account differences. No performance acceptance is inferred from passing unit tests.

### Graph/source evidence scope

Graph project `Users-kacperkepinski-Developer-personal-monocode`, generation `2026-09-13T15:07:47Z`, belongs to the original checkout. list_projects pagination completed; graph sendDevinTurn trace and ACP symbol discovery/elicitation trace used first. Exact-path coverage checked for all 42 provider/ACP files plus userQuestion.ts/liveStart.ts, and harness scope checked; no recorded gaps, but many metadata_changed. Graph snippet for ACP request demonstrates stale ranges. Current worktree source was therefore authoritative for every finding, and no index or runtime was modified. Deep reads focused on five lifecycle adapters, shared ACP/subagents, catalogs and relevant protocol/test paths; this is not an exhaustive read of every native text/title/git helper.

Memory used only as orientation to catalog/provider seams (MEMORY.md:480-482); every reported implementation claim was freshly checked from source.

## Astra independent provider review

Reviewed `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, HEAD `348c22e07723c32cd683483eb07e58952e08e88b` plus the existing uncommitted patch. Read-only: no production/test edits, real prompts, app restarts, commits, or network writes. Diagnostic bundling replaces IO in memory and does not execute provider binaries.

### Verified defects, ranked

#### 1. P1 — Forgetting a Pi/omp session during startup still launches it and sends the prompt

- Primary anchor: `src/lib/harness/piFamily.ts:443` (async binary resolution), `:518` (unconditional spawn), `:529` (publishes live). Cleanup at `:350–381` has no startup invalidation; `sendTurn :221–235` proceeds after startup.
- Trigger: begin a cold send, remove/forget the session before binary resolution completes, then let resolution complete.
- Impact: work the user removed still executes; the forgotten provider binding/live child can reappear. Both Pi and omp share this function.
- Reproduced with the actual Pi adapter bundled in memory: defer binary resolver, await `forgetPiSession`, release resolver. Result: **1 spawn and 1 prompt after forget**.
- Smallest fix: fence startup ownership with a generation/token invalidated by stop/forget, check after awaits and before publishing/sending; clean up only the child belonging to that start. A cancellation tombstone must survive initialization, not be deleted by internal stop calls.
- Regression: delayed resolve and delayed spawn, stop/forget before each completion, assert no prompt/providerBound/live resurrection; run for both flavors.
- Related static evidence: Claude `ensureLive` awaits resolver at `claude.ts:457` then spawns at `:535` while `stopClaudeSession :384` does not invalidate the pending start; OpenCode awaits resolver/version at `opencode.ts:376–377` before unguarded startup. Root confirms registry has no generation fencing. Only Pi was dynamically reproduced in this review; do not label the other two dynamically verified.

#### 2. P1 — OpenCode dispatches a plan/supervised prompt before stricter permissions are applied

- Primary anchor: `src/lib/harness/opencode.ts:248–257`; caller `:146–153` does not await it before `runTurn`, whose prompt is `:600`.
- Trigger: reuse a full-access session, switch to supervised or Plan, immediately send. The permission PATCH is pending, slow, or rejected.
- Impact: the server can process the new prompt with the previous wildcard-allow rules. Client-side plan denial only handles permission events; an already-allowed operation never reaches that gate. Failed PATCH is only console-debugged, and the prompt proceeds.
- Reproduced against unchanged adapter with a deferred `updateSession`: observed **update-start, prompt**, with update still pending when the turn completed.
- Smallest fix: make permission application awaitable and await confirmed restrictive rules before dispatch; propagate failure to the turn. Serialize rule changes so an older in-flight update cannot overwrite a newer mode. Preserve asynchronous UI updates through the same confirmed-state path.
- Regression: delayed/rejected tighten from full-access and full-access→plan; assert prompt is blocked until confirmation, no prompt on failure; out-of-order changes converge to latest requested mode.

#### 3. P2 — Pi/omp reasoning setting is not applied on cold/resumed turns, and rejected changes are cached as successful

- Primary anchor: `src/lib/harness/piFamily.ts:463` initializes `live.thinking` with the requested UI value; `:1013–1018` sends only if it differs and swallows rejection before caching it.
- Supporting: `piProtocol.ts:136–163` spawn args have model but no thinking; `piFamily.ts:1056–1083` bindState does not read actual `thinkingLevel`.
- Trigger: select high reasoning when provider config/resumed session is low; or change to a level which the provider rejects.
- Impact: displayed/saved choice and actual provider effort diverge. Cold request never writes the chosen level; rejected warm changes still permit prompt dispatch and suppress later retries.
- Reproduced: cold high with get_state low yielded `get_state,prompt,get_session_stats`, no `set_thinking_level`; spawn args had no thinking. Rejected medium followed by another medium send yielded only one failed set request and two prompts.
- Smallest fix: initialize actual state from get_state (or unknown), apply desired level before first prompt, and cache only an acknowledged/returned level. Surface failure or update UI to provider-confirmed state instead of pretending success.
- Regression: cold+resume differing saved settings; acknowledged warm change; rejected change does not silently dispatch with a false UI value or permanently deduplicate the retry. Both flavors.

#### 4. P2 — Simultaneous omp workflow questions make the first question unreachable

- Primary anchor: `src/lib/harness/piFamily.ts:915–942` stores and emits every question immediately; after answer `:943–968` does not restore another pending question.
- Shared evidence: `src/lib/harness/apply.ts:109–119` replaces the singleton pendingQuestion; `:131–134` clears only the matching one. UI reviewer independently confirmed one QuestionForm.
- Trigger: two extensions/tasks emit select/input/editor requests before the first is answered.
- Impact: second overwrites first, and answering second leaves the first RPC parked with no visible way to answer. Stop/cancel remains the escape.
- Smallest fix: reuse the existing Claude/OpenCode visible-question queue pattern within piFamily, serializing visibility while retaining each provider request.
- Regression: two requests, answer second-visible then next, server-side cancel of visible/nonvisible requests, stop closes all. No new UI component needed.

#### 5. P2 — Pi extension selects and text prompts cannot return the user's actual answer

- Primary anchor: `src/lib/harness/piFamily.ts:909–914` enables real questions only for omp; Pi falls into approval UI at `:971–985`.
- Wire anchor: `src/lib/harness/piProtocol.ts:294–308`: Allow for select sends `options[0]`; Allow for input/editor returns cancelled. `piAdapter.ts:17–32` has no question responder.
- Trigger: installed Pi extension asks for a selection with two options or an input/editor value.
- Impact: user cannot select a non-first option, and input/editor flow cannot proceed; Allow silently fabricates a first-option selection rather than collecting it.
- Smallest fix: use the already implemented question mapping for Pi too and wire its responder; keep confirm as an approval.
- Regression: Pi selects option 2 preserving original value; Pi input/editor submits typed content; skip/cancel behavior remains explicit.

#### 6. P2 — OpenCode retains complete event parts indefinitely and scans all of them for child metadata

- Primary anchor: `src/lib/harness/opencode.ts:726` and `:1050` append partById; `:908` appends emittedTextByPartId; `:1034–1035` scans all retained parts for each subagent message metadata event.
- Trigger: a long-lived active OpenCode conversation, especially repeated subagents/tool output, without idle disposal.
- Impact: full text/tool payloads remain in process-owned maps even after UI/persisted transcript trimming and compaction; metadata handling becomes proportional to all prior parts. `message.removed :698–701` only deletes role metadata. No clear/delete/size bound exists for those maps in this file. Pending-subagent limits at `:1074–1078` do not cap partById or emittedTextByPartId.
- Evidence: complete source-symbol occurrence search for these maps plus lifecycle reads; source-level retention/complexity defect, **no measured CPU/RSS claim**.
- Smallest fix: retire finalized parts/message-role state at a safe turn boundary, preserve active child and stream dedup state, and bound any retained replay cache. Handle removed-message/part events consistently. Avoid a new cache abstraction.
- Regression: many completed turns and subagent metadata events, assert retained state remains bounded while late/deduplicated parts and active child trails still work.

#### 7. P2 — Pi/omp silently replace a saved conversation after any resume startup failure

- Primary anchor: `src/lib/harness/piFamily.ts:428–432` catches every startLive error when canResume, deletes the resume binding, then starts a fresh session.
- Trigger: resuming an existing conversation when startup get_state or set_model fails transiently; retrying fresh succeeds.
- Impact: the visible conversation is retained but provider context starts anew, without a user-visible restart decision. This is not restricted to an explicit missing-session response.
- Evidence: direct source flow, not live-provider reproduction. Particularly clear for a successful resumed get_state followed by set_model rejection: the catch treats settings failure as lost session.
- Smallest fix: retain the binding and surface generic startup errors; only offer explicit fresh-start recovery when the provider confirms the session cannot be resumed.
- Regression: bound session plus transient get_state/set_model failure does not start an unbound session or delete identity; explicit recovery remains user-visible.

### Provider/scenario matrix

| Provider | Startup/follow-up/lifecycle | Models and reasoning | Transcript/compaction | MCP and dialogs |
| --- | --- | --- | --- | --- |
| Claude | Shared-start prewarm dedup and warm reuse; same-session model-change restart is tested. Stop-during-start still needs fencing. Early startup steer is a shared UI review finding. | Model/launch-setting change restarts with resume; effort is a spawn flag and ultrathink modifies prompt. Confirmed runtime-mode write does not await protocol acknowledgement; live setting acceptance unverified. | Tested parent/child separation, child tools/narration, background task completion, concurrent question queue; manual compact requires boundary. | Interactive launch inherits setting sources; isolated catalog/helper launch disables MCP. Mock MCP approval and child-exit cases pass. Real config inheritance, auth failures, MCP startup failures and elicitation need live acceptance. |
| Pi | Warm process and RPC requests; no prewarm hook. Stop/forget resurrection reproduced; broad fresh-start fallback loses resume identity. | Cold and rejected warm thinking defects above; set_model acknowledgement otherwise awaited. | Retry/settle flow and compaction stats tested; per-turn tool maps cleared. settleTurn waits up to 4s for optional stats before completing, an efficiency follow-up requiring measurement. | Live args retain extensions; actual inherited MCP support is CLI/extension dependent. Select/input/editor mapping defective. Plan tool whitelist does not itself establish extension/MCP behavior. |
| omp | Same lifecycle as Pi, adds local slash-command results, nonterminal end handling, command inventory push and steering. | Same cold/rejected-thinking issues. Fast RPC/config updates and unsupported-fast fallback covered by tests. | Normal and non-agent commands, late command results, output and retry behavior tested. | Actual select/input/editor values supported, but concurrent questions overwrite. Live extension/MCP config and errors unverified. |
| OpenCode | Per-session server, HTTP+SSE; clean stream end triggers next-turn reconnect; server-exit parked asks tested. Permission-tightening race reproduced. | Model+variant sent per prompt; catalog is now cwd-scoped in current source. | Child ancestry/filtering and queued questions tested; hidden agents suppressed when metadata known. Part maps grow for live lifetime. Compact uses dedicated summarize response. | CLI serve inherits config; mock MCP permissions and child ancestry tested. Auth/config inheritance and real MCP errors not established. |

### Validation performed

- Command (from reviewed worktree): `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/harness/claudeLive.test.ts src/lib/harness/claudeProtocol.test.ts src/lib/harness/piLive.test.ts src/lib/harness/piProtocol.test.ts src/lib/harness/piClient.test.ts src/lib/harness/piSkills.test.ts src/lib/harness/piSubagents.test.ts src/lib/harness/ompLive.test.ts src/lib/harness/opencodeLive.test.ts src/lib/harness/opencodeProtocol.test.ts src/lib/harness/opencodeClient.test.ts src/lib/harness/catalogContext.test.ts src/lib/harness/fileAttachments.test.ts`
- Result: **13 files / 196 tests passed**, Vitest 3.2.7, 1.73s. These are simulated transports; filenames containing Live do not mean real provider acceptance.
- Repro command (from worktree): `node /tmp/astra-other-providers-repro.mjs`.
- Saved source-only diagnostic: `/tmp/astra-other-providers-repro.mjs`.
- Captured output: `/tmp/astra-other-providers-repro-results.jsonl`.
- No release workload benchmark, UI interaction, authenticated provider call, native Windows or Windows-to-WSL run. No full build/typecheck/Rust check by this reviewer; no code edits to validate.

### Evidence bounds

- Read AGENTS.md, PRODUCT.md and CONTRIBUTING.md. Codebase Memory used for initial structural discovery: selected project `Users-kacperkepinski-Developer-personal-monocode`; graph generation `2026-09-13T15:07:47Z` points at original checkout. Search sendClaudeTurn/sendTurn/sendOpenCodeTurn, depth-2 both-direction traces (not truncated), Pi snippet. All relied-on adapter/protocol/client/catalog/test paths were checked with check_index_coverage; broad harness scope reported no recorded gaps.
- Graph metadata was changed for Claude/OpenCode paths; even metadata_match described original checkout, so findings use current worktree source lines. No reindex or shared service change. Coverage is best-effort, not completeness proof. Review focuses on traced send/lifecycle/protocol scenarios, not exhaustive security or all command implementations.
- All primary provider finding files are unchanged in the uncommitted patch (git diff --numstat empty for claude.ts, piFamily.ts, opencode.ts). These are current integration defects, not claims that this patch introduced them.
- Memory registry was used only as seam orientation (`MEMORY.md:480–481`); current source supersedes the old OpenCode global-catalog note.

### Design preferences / acceptance gaps, not additional defects

- Pi/omp optional stats delay is a measurable performance candidate; prefer completing the turn then refreshing meter if safe, but measure before prioritizing.
- Lack of prewarm for Pi/OpenCode is an optimization choice, not proof of slowness.
- Mock MCP tool classification/approval passing does not certify real inherited servers, resources/prompts, credential scope, disconnected servers or provider-specific elicitation.
- Full release-scale transcript retention/latency acceptance is still required. Existing correctness tests give no RSS/CPU/native-platform assurance.

## Astra shared workflow / UI review

Reviewed read-only: /Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability, HEAD 348c22e07723c32cd683483eb07e58952e08e88b plus current uncommitted changes.
No source/test edits, app restarts, live agent prompts, or commits.

### Confirmed findings

#### P2 — New regression: ordinary coding prompts lose literal HTML/generic syntax in the transcript
- Anchor: src/surfaces/AgentTranscript.tsx:1104 (changed line); supporting renderer src/surfaces/AgentMarkdown.tsx:67 and :521.
- Trigger: send ordinary text such as "Change <T> to <U>." or "Compare Array<T> with Array<U>." without a Markdown code fence.
- Before this patch, ordinary user text used a literal React text node. The patch sends every user message through AgentMarkdown. That renderer enables raw HTML parsing followed by sanitization. The resulting visible messages become "Change  to ." and "Compare Array with Array." Script-like examples can disappear with their whole body.
- Scope: confirmed DISPLAY corruption; submitted block.text / provider payload are unchanged. Users cannot reliably inspect what they asked by reading the conversation.
- Reproduction: a read-only Node command rendered the installed Streamdown with the same raw + sanitize + harden pipeline, controls:false and isAnimating:false. Exact output:
  - input "Change <T> to <U>." -> <p>Change  to .</p>
  - input "Keep <script>alert(1)</script> as literal example." -> <p>Keep  as literal example.</p>
  - input "Compare Array<T> with Array<U>." -> <p>Compare Array with Array.</p>
- Minimal safe fix: keep the prior literal-text path for plain user prompts, or give user Markdown a pipeline that preserves literal HTML text while retaining safe formatted/fenced content. Do not loosen the sanitizer to render arbitrary user HTML.
- Regression check needed: render real AgentTranscript for these plain coding prompts and assert their literal tag text remains visible, alongside existing fenced-code test. Current new test only verifies a fenced example.

#### P2 — Fast followups still fail for providers missing a runtime steering predicate
- Anchor: src/lib/harness/registry.ts:223 (new helper's permissive fallback), called at src/App.tsx:4885 and :4957.
- Concrete providers verified: Claude, OpenCode, Cursor. Their adapters wire steerTurn but omit canSteerSession: claudeAdapter.ts:24–44, opencodeAdapter.ts:23 onward, cursorAdapter.ts:22 onward.
- Trigger: set followup behavior to Steer; send a first prompt into a cold session; immediately send a second while the first awaits checkpoint/prompt preparation/provider initialization. App marks busy immediately, yet registry reports steering readiness true solely because the provider supports steering.
- App appends the second message, returns true, and Composer clears its draft. Actual steerClaudeTurn throws "No active turn to steer" at claude.ts:269; OpenCode does the same at opencode.ts:198; cold Cursor throws "No active Cursor session" at cursor.ts:166. The followup is not queued and has not reached the provider.
- A followup whose preparation crosses the previous turn's end also misses the new fallback for these providers, because the second readiness check still always returns true.
- Further impact: App:4979 treats this followup delivery failure as session.error; apply.ts:147 invokes failStreaming/stopStreaming, falsely making the still-starting/running primary turn idle.
- Classification: pre-existing reliability gap left unresolved by the patch; the new per-session readiness integration only covers a subset of providers.
- Minimal fix: provide truthful canSteerSession for every steer-capable adapter (or conservatively queue without a proven active turn), and retain delivery failures separately from primary-turn terminal failure when the primary is still running.
- Regression check needed: delayed first-turn checkpoint/start, rapid second submit, verify one active turn plus one retained queue item, no false idle; repeat completion-during-followup-preparation for Claude/OpenCode. Existing Composer/useSessionState tests do not exercise App orchestration.

#### P2 — Switching model then steering records a model that did not execute the followup
- Anchor: src/lib/harness/apply.ts:403; supporting src/App.tsx:4682 and :4952, src/lib/harness/codex.ts:191–204.
- Trigger: start a Codex turn on model A, choose model B in the still-enabled picker, then send a mid-turn steer while A remains active.
- onModelChange updates session.model immediately. appendSteerUser stamps the new user row with turnModelFields(session), hence B. Codex steering sends only threadId, expectedTurnId and prompt/attachments; it cannot change the active turn's model or effort through that request. The active A handles this steer.
- AgentTranscript groups every user row as a turn and displays the immutable stamped model in its work line (transcriptActivity.ts:177, AgentTranscript.tsx:382–430). It therefore attributes the followup to B despite execution by A.
- Classification: existing model-provenance defect / unsupported mid-turn-switch semantics, not introduced by current diff.
- Minimal fix: preserve the active turn's model provenance for steers; clearly indicate changed picker settings apply to the next new turn, or queue the followup when the selected model differs from the active one. Do not imply that effort changes in the picker affect Codex's current turn.
- Regression check needed: begin A, select B, steer; assert provider request remains steer-on-A and transcript identifies A; next queued/new turn should identify/use B.

### Cross-review confirmations sent to parent

- OMP overlapping questions: confirmed shared pendingQuestion is a single slot. apply.ts:109 replaces it on each question.asked; :131 only clears the matching current ID. SessionPane:400 passes only this slot and Composer:1339 renders one QuestionForm. piFamily.ts:917 stores multiple waiting requests but immediately emits all. Answering the second clears the UI and never restores the first. Provider reviewer owns final finding/fix.
- Cursor custom answers: conditionally reachable in UI. userQuestion.ts customAllowed accepts explicit custom/allowCustom true and options labelled Other before its Cursor-style default-false branch. QuestionForm.tsx:261 renders the Other input; buildQuestionReply preserves custom text. cursorAskQuestionResponse at cursor.ts:704–713 ignores reply.custom and strips __custom__. Ordinary Cursor stable-id options without Other do not expose custom input by default. Provider reviewer owns protocol conclusions.

### Scenario coverage and limits

- Composer accepted/rejected/asynchronous submission and subsequent draft retention: current code read and existing tests pass.
- Queue head checks/editing/deletion/pause/resume: source inspected; helper tests pass. No end-to-end App queue/native transport test ran.
- Stop during ordinary prompt/checkpoint preparation: new generation recheck after preparation is present. No live cancellation timing claim.
- Model/effort picker: supported settings come from model catalog; settings normalization and placeholder-native-ID tests pass. Midturn provenance issue above remains.
- Native commands: reserved /plan, /compact and /add-to-folder escapes and raw-command path inspected; skills tests pass. No live native command invocation.
- MCP settings: ExtensionsPage inventories provider-native config and exposes toggles/removal with backup messaging. It does not establish runtime server connection, auth, or tool availability. A compact "applies after reconnect/next session" note and distinguishing configured from connected would help, but these are UX suggestions rather than confirmed runtime defects from this review.
- Transcript: hidden panes use the memo comparator to defer transcript rendering; mounted turns are initially paged; closed work folds release content. Scroll and error-disclosure tests pass. No release-build latency/CPU/memory measurement was performed; no performance acceptance claim.
- Repeated "Reminder child session" text: no confirmed shared rendering cause found; provider/event-normalization reviewers own origin investigation.

### Validation performed

NODE_OPTIONS=--no-experimental-webstorage npx vitest run
  src/chrome/Composer.test.ts
  src/chrome/ModelPicker.test.ts
  src/surfaces/AgentTranscript.test.ts
  src/surfaces/AgentTranscriptScroll.test.ts
  src/surfaces/AgentTranscriptErrorDisclosure.test.ts
  src/lib/messageQueue.test.ts
  src/hooks/useSessionState.test.ts
  src/lib/models.test.ts
  src/lib/skills.test.ts

Result: 9 files, 94 tests passed; Vitest reported 1.27s wall duration. This is test-run duration, not app performance.
Read-only installed Streamdown rendering probe reproduced all three literal-text losses listed above.

### Evidence method

Read AGENTS.md and docs/PRODUCT.md. Graph-first discovery used project Users-kacperkepinski-Developer-personal-monocode, ready generation 2026-09-13T15:07:47Z. That graph belongs to the ORIGINAL checkout, not this worktree. Positive Composer/ModelPicker/AgentTranscript graph lookups and bounded traces were used only for orientation; traces were truncated at 12 rows and no complete-callgraph claim is made. Every relied-on path was coverage-checked. App/Composer/models/registry/provider paths reported metadata_changed; new useSessionState paths missing; ExtensionsPage/agentConfig not_tracked. Other metadata matches concern the original checkout only. Current worktree source was read for all conclusions. No graph service reindex/restart was performed.
