# Harness integration review — fresh second pass

Reviewed 2026-09-15 by four fresh GPT-6 Astra reviewers and the coordinating transport review. Scope: all 11 harnesses, shared dispatch/conversation UI, performance, MCP forms, models/efforts, permissions, cancellation and recovery.

Worktree: `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`; branch `perf/agent-harness-reliability`; base `348c22e07723c32cd683483eb07e58952e08e88b` plus the existing uncommitted repairs described in [the fixes report](harness-integration-fixes.md). These findings apply to that repaired working tree. They are not a claim that all defects were introduced by those repairs.

**Result: 18 confirmed issue groups, including seven P1 groups.** Existing focused tests passed, but independent diagnostics exposed missing scenarios. This was a read-only code review: no implementation changes, application restart, provider prompts or external mutations. This report is the sole new repository artifact.

P1 means prioritize before calling the workflow reliable: a permission/Plan boundary or stop/dispatch guarantee can fail. P2 means a reproducible recovery, settings, interoperability or resource-management defect. The minimal fixes below are proposals, not completed work.

## Prioritized findings

| ID | Priority | Scope | Reproduced problem | Proposed correction |
| --- | --- | --- | --- | --- |
| MC1 | P1 | Muse, Codex | Rejected Stop settles locally while the owned provider host remains running | Reconcile interruption; retire the exact owned host on rejected/unknown stop, preserve resume identity |
| O1 | P1 | Claude | Rejected permission tightening is ignored and cached as successful | Await correlated control acknowledgement; cache confirmed mode and block unsafe continuation |
| MC2 | P1 | Muse | Rapid Auto → Supervised leaves the provider in Auto | Serialize/reconcile the latest desired permission mode |
| O2 | P1 | Pi, omp | Cancelled/expired RPC requests can later drain from the real child input queue | Pass the existing AbortSignal through PiRpc and revoke queued writes |
| O3 | P1 | OpenCode | Failed abort is treated as stopped and the potentially running session is reused | Preserve abort errors and retire uncertain live ownership |
| A1 | P1 | Cursor | Provider plans are automatically approved, including after cancellation | Preserve explicit Build approval and reject late cancelled requests |
| U1 | P1 | Shared queued messages | Manual Steer/Send now drops Plan intent | Forward stored intent and preserve the Plan fresh-turn rule |
| U2 | P2 | Shared decisions | Changing provider sends an outstanding question/approval response to the new provider | Route decisions to their original live owner |
| A2 | P2 | Devin, Copilot, Cursor, Grok | A second question hides the first unanswered form | Serialize presentation and settle queued requests on cancellation |
| U3 | P2 | Shared question UI | A rejected earlier numeric answer cannot be revisited | Add correction navigation while preserving entries |
| A3 | P2 | ACP/MCP forms | Skipping a required field sends schema-invalid accepted data | Retain required-field metadata and prevent partial invalid acceptance |
| A4 | P2 | Devin/Copilot MCP forms | Standard titled multiselect `items.anyOf` is rejected | Reuse existing choice mapping for the documented array shape |
| MC3 | P2 | Muse | A transient resume failure deletes the saved binding; retry starts empty context | Preserve binding except confirmed missing session or explicit reset |
| MC4 | P2 | Codex | Fast → Standard omits the explicit reset and retains Fast | Send the protocol's explicit tier reset for Standard |
| O4 | P2 | omp | Failed Fast disable is silently cached | Cache confirmed state and surface rejection in either direction |
| U4 | P2 | Compaction/settings | A late compaction acknowledgement overwrites the user's next model/effort | Capture in-flight settings using the existing turn snapshot seam |
| T1 | P2 | Native process transport | Exit may precede buffered terminal stdout, losing the final response | Drain readers before terminal exit delivery, with bounded ownership-aware cleanup |
| T2 | P2 | Native SSE/OpenCode | Closing an idle SSE stream cannot wake its blocking reader | Make cancellation interrupt the owned read/connection |

Detailed source anchors, trigger paths, diagnostic evidence and minimal regression cases follow in the transport section and four reviewer appendices. Provider-specific matrices collectively cover Muse, Codex, Devin, Copilot, Cursor, Grok, fx, Claude, Pi, omp and OpenCode. No additional fx-specific defect was confirmed in this bounded pass; shared UI/transport findings can still affect it.

## Validation performed in this pass

| Scope | Existing tests freshly run | Additional isolated evidence |
| --- | --- | --- |
| Muse/Codex | 227 passed / 8 files | Five expected-behavior assertions fail on current source |
| ACP five-provider scope | 216 passed / 12 files | Eight diagnostics assert and reproduce broken outcomes |
| Claude/Pi/omp/OpenCode | 187 passed / 7 files | Four diagnostics assert and reproduce broken outcomes |
| Shared UI | 139 passed / 11 files | Four expected-behavior assertions fail; one reachability check passes |
| Shared child/JSON-RPC | 17 passed / 2 files | Exit-order bridge probe plus actual Rust SSE-read cancellation probe |

Total: **786 passing existing test executions across 40 suite executions**. This is a scoped run, not a fresh full repository check. Passing defect assertions mean the defect was reproduced, not that it was fixed. Diagnostics and logs are outside the repository under `/tmp`; commands are included below. Source checksums were captured before review for 757 files under `src` and `src-tauri/src` and verified unchanged afterward.

## Performance conclusions and next measurements

This review establishes correctness failures and one reproducible blocked-reader resource issue. **It establishes no new end-to-end speed improvement or CLI parity.** No code was optimized during this pass.

- T2 shows a closed SSE reader remains blocked after cancellation until peer activity/closure or the configured read timeout. This is a resource-lifetime defect; its real app CPU/RSS cost was not measured.
- Pi/omp optional `get_session_stats` can hold settlement for up to four seconds. Measure it separately and move it after completion only if provider semantics permit; this remains an optimization candidate, not a demonstrated speedup.
- Previously measured reducer batching and checkpoint reductions remain stage-specific evidence in the existing validation reports. They do not explain all provider or WebView latency.
- Prior Muse smoke showed answer-to-ready bookkeeping can dominate perceived completion. Preserve actual terminal ownership while showing an honest transient finishing state; this pass does not authorize treating an early answer as provider completion.
- After fixes, compare matched release-build workloads for cold start, warm followup, queued followup, tool/MCP approval and cancellation-to-ready. Record submit→native write, provider first content, rendered first content and true terminal completion separately. Include p50/p95, sample counts, failures and concurrent-session CPU/RSS. Control model, effort, service tier, workspace, account and MCP configuration.

### Acceptance limits

Protocol fixtures and mounted QuestionForm checks do not establish complete browser/native WebView interaction, authenticated MCP discovery/login/tool execution/reconnect, account-specific model/effort changes, or native Windows/Windows-to-WSL behavior. None was performed in this pass. No blanket “all harnesses flawless” or performance acceptance claim is justified. UI review found focused interaction repairs; no broad UI redesign or new settings framework is needed.

Graph-first discovery used project `Users-kacperkepinski-Developer-personal-monocode`, generation `2026-09-13T15:07:47Z`, rooted in the original checkout. Coverage was checked for relied-on paths. Because this worktree differs and graph snippets were stale, current worktree source and direct diagnostics supplied verification. No graph/runtime service was modified.

## Shared native transport findings

### T1 — Native exit can overtake buffered final stdout

**Source:** `src-tauri/src/harness.rs:646–683` launches independent stdout/stderr readers, then the child wait thread emits exit without joining/draining those readers. `src/lib/harness/child.ts:127–135` dispatches matching exit immediately. Codex `:503–517` and Muse `:677–691` close their RPC clients on exit; `jsonRpc.ts:55–56` ignores subsequent frames on a closed client.

**Trigger/impact:** A CLI writes its terminal response and exits before the stdout reader emits that buffered response. Exit is delivered first, active work is failed/settled, and the later valid frame is discarded. This can lose final content or mark a successful provider result failed. The new closed-client and stale-generation guards should remain; ordering belongs at the native owner.

**Diagnostic:** `/tmp/round2-exit-probe.mjs` bundles the actual current child/JSON-RPC modules, mocking only Tauri invoke/listen. Delivering a matching exit followed by buffered terminal frames yields `{"success":false,"error":"Process exited before terminal response","notificationsAfterBufferedTail":[]}`. Result: `/tmp/round2-exit-probe.json`. Run `NODE_OPTIONS=--no-experimental-webstorage node /tmp/round2-exit-probe.mjs`.

This proves the consequence of an ordering permitted by current native source; it is not an end-to-end native scheduler reproduction. A fix regression should exercise a real child that writes a terminal frame immediately before exit and preserve late/stale host isolation. Drain readers before terminal exit, bounded if descendants retain pipe handles.

### T2 — SSE cancellation cannot interrupt a blocked read

**Source:** `src-tauri/src/harness.rs:323–340` removes the stream and sets an atomic stop flag. The HTTP read timeout is six hours at `:895`; `read_sse` checks the flag before a blocking line read at `:954–959`. An idle connection cannot observe a subsequent stop until more input, EOF or timeout.

**Trigger/impact:** Close/reconnect an idle or wedged OpenCode SSE stream. The old reader/socket/thread can survive after the app considers it closed, potentially for the configured six-hour timeout. Repeated reconnects can retain multiple readers even though generation filtering hides stale events. Actual app memory magnitude was not measured.

**Diagnostic:** `/tmp/round2-sse-probe` contains byte-current `bounded_line` and `read_sse`, the same ureq 2.12.1 read primitive, a real local chunked SSE server, and only emitter/AppHandle stubs. After headers and a heartbeat, set stop and wait 250 ms: reader remains blocked; close the peer: reader finishes. Result `/tmp/round2-sse-probe-result.json`: `{"reader_stopped_within_250ms_of_cancel":false,"reader_finished_after_peer_closed":true}`. Run `CARGO_TARGET_DIR=/Users/kacperkepinski/.cache/monocode-harness-target cargo run --offline --quiet --manifest-path /tmp/round2-sse-probe/Cargo.toml`.

Make cancellation interrupt the owned read/connection and verify bounded reader termination on an idle server. Avoid busy polling or killing healthy agent processes merely to reduce UI resource use. This probe verifies the actual blocking primitive, not the full Tauri app lifecycle.

## Independent reviewer appendices


---

## MC — Muse and Codex

## Fresh second review: Muse and Codex

Reviewed 2026-09-15, read-only, in `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, HEAD `348c22e07723c32cd683483eb07e58952e08e88b` plus current uncommitted repairs. No source changes, commits, app restarts, MCP calls or real prompts. Four remaining findings below are independently reproduced against current source; the previous pre-admission cancellation and snapshot/subscription findings are not repeated.

### Findings

#### 1. P1 — Rejected Stop requests leave both providers running behind a locally completed turn

- Current anchors: `src/lib/harness/codex.ts:325-332`; `src/lib/harness/muse.ts:480-505`.
- Trigger: an established turn has a known turn ID; the user selects Stop; the live provider definitively rejects `turn/interrupt` (e.g. JSON-RPC `-32603`, `interrupt failed`). No terminal notification occurred.
- Codex swallows rejection and calls `finishActiveTurn`. Muse settles all local waits even before sending interrupt, then swallows interrupt/unqueue failures. Both leave the host alive, mute its updates, and resolve the original send. The provider can still execute tools or spend tokens after the app reports stopped. A subsequent send can overlap or queue behind that hidden work. This is distinct from the now-fixed cancellation-before-ack path, which kills the owned host.
- Reproduced separately for each provider using existing child IO mocks: start/ack active turn, reject interrupt, await cancellation and send; `killChild` count is **0** in both cases. No actual tools/model were run.
- Small fix: reconcile successful interruption, and retire the exact owned live host on rejected/unknown interruption or unqueue, preserving resume identity. Bound Codex's control RPC wait as well (it currently uses JsonRpcClient's zero-timeout default). Do not replay the cancelled input. Ensure delayed fallback cleanup cannot kill a replacement host.
- Regression: known active and queued IDs, rejected and unanswered interruption/unqueue, replacement ownership, then successful resume on the next send.

#### 2. P1 — Muse can remain Auto after the user switches back to Supervised

- Current anchor: `src/lib/harness/muse.ts:275-287`.
- Trigger: host is supervised (`appliedMode=promptUnmatched`). User selects Auto, sending `session/setApprovalMode(onRequest)`, then selects Supervised before that response arrives.
- The second call compares the new desired value against the still-old confirmed cache, sees equality, and emits no restore command. The first response then sets `appliedMode=onRequest`. UI/runtimeMode is supervised while the host uses Auto for subsequent actions in the still-running turn. The next prompt eventually repairs it; the current turn remains under the wrong mode.
- Reproduction captured only `["onRequest"]`, where the rapid round trip requires a restoring `promptUnmatched` command. Existing rejection tests pass but do not cover this in-flight reversal.
- Small fix: serialize/reconcile access-mode changes against the latest desired mode and pending change, using the same owner-bound control path from runtime updates and runTurn. Required turn dispatch must await that latest settled selection.
- Regression: supervised → auto → supervised while the first response is delayed; assert final provider mode and latest UI selection agree. Cover different response order and rejection without caching false success.

#### 3. P2 — A transient Muse resume failure silently resets context on retry

- Current anchor: `src/lib/harness/muse.ts:757-762`; subsequent new-session branch begins at 768.
- Trigger: a saved binding exists and `session/resume` fails for a reason other than missing session (temporary host/store failure, auth/service recovery, timeout).
- The adapter deletes `resumeByThread` before surfacing the error. The next send has no binding and calls `session/start`, leaving the existing displayed transcript attached to a new empty provider context. The first error does not explain that Retry discards the conversation. The intentionally supported missing-session fallback is a different case.
- Reproduced by binding `MS-original`, returning `-32603 / temporarily unavailable`, retrying: captured `["session/start"]` instead of `["session/resume"]`.
- Small fix: retain the saved binding on non-missing failures; retry the same identity. Only deliberate reset or confirmed missing-session handling should replace it.
- Regression: transient resume rejection then retry succeeds against the original provider session ID; assert no new-session request. Keep the existing missing-session case separately.

#### 4. P2 — Codex Fast → Standard leaves the provider on Fast

- Current anchors: `src/lib/harness/codexProtocol.ts:137-139`; `src/lib/harness/codexCatalog.ts:235-236` (UI value `default` means Standard).
- Trigger: a live/resumed thread has a non-default service tier, then the user chooses Standard for the next turn.
- `buildTurnStartParams` omits `serviceTier` for `default`. Codex's tier override persists across subsequent turns, so omission retains Fast rather than clearing it. The displayed selection and requested provider tier diverge; latency/billing can differ from the user's choice.
- Fresh installed `codex-cli 0.154.0` schema generated with `codex app-server generate-json-schema --experimental --out /tmp/round2-codex-schema` confirms the field overrides this and subsequent turns. Official current upstream regression `turn_start_sends_service_tier_id_to_model_request` also verifies persistence when a following override is absent: https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/turn_start.rs#L995 . The official app-server README search result documents `serviceTier: null` as the clear operation; the current README has been reorganized, so prefer installed schema/protocol verification for final implementation.
- Reproduction against the actual builder: Fast produces `fast`; Standard produces `undefined`, no clearing field.
- Small fix: emit the supported explicit tier reset (`serviceTier: null` for this protocol) for an explicit Standard selection, preserving omission only for a genuinely unspecified setting. Apply the distinction to resume/start overrides where a saved thread can retain its prior tier.
- Regression: Fast → Standard → Fast using the same thread, and resume a previously Fast thread with explicit Standard. Assert exact wire payload and validate effective tier with a local protocol fixture or live metadata acceptance.

### Scenario matrix

| Scenario | Muse | Codex |
| --- | --- | --- |
| Cold/prewarm/warm send | Shared-start ownership guards and delayed startup regressions present; scoped tests passed. | Same; scoped tests passed. |
| Cancel before admission/known turn ID | Pre-ack host recycling passes; known-ID rejection remains finding 1. | Same; unbounded interrupt acknowledgment also remains in that path. |
| Model/effort | Required model rejection prevents dispatch; effort sent per new turn; no live model transition in this review. | Per-turn model, collaboration reasoning and tier mapping traced; Standard tier reset is finding 4. |
| Runtime modes/plan | Required control failure no longer swallowed; live rapid selection reversal is finding 2. | Read-only plan and ordinary approval mapping tests passed. Broader live approval-policy transitions remain acceptance work. |
| Resume/compact | Normal saved resume and compaction tests pass; non-missing resume failure is finding 3. | Normal/missing-thread resume and compaction tests pass; no new provider-specific resume finding confirmed. |
| Approvals/questions | Existing decision rejection retains actionable pending state; successful/denied/missing-choice tests passed. | Ordinary/permissions approvals, question mapping/timeout and simple MCP confirmation tests passed. |
| MCP | Existing CLI host/config ownership remains; item/approval mapping inspected. Actual discovery/auth/tool execution was not exercised. | Boolean confirmation accepted through existing approval UI; richer MCP forms/sign-in explicitly cancelled as unsupported. Actual server connection/auth/tool execution unverified. |
| Subagents | Current nested terminal cleanup and follow-slot regression pass; bounded child/prose state inspected. | Current child ownership, pending payload budget and retained mapping tests pass. |
| Streaming/transcript | Reminder bookkeeping stays transient while terminal completion owns send settlement. | Provider-item snapshot dedupe and delayed terminal tests passed. |
| Performance/UI | No new release/RSS/native WebView measurement. Existing reported smoke shows bookkeeping can dominate answer-to-ready latency. | No new release/RSS/native WebView measurement. Passing functional tests do not establish parity with native CLI. |

### Verification

Existing tests, unmodified:

`NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/harness/museLive.test.ts src/lib/harness/museSubagents.test.ts src/lib/harness/codexLive.test.ts src/lib/harness/codexProtocol.test.ts src/lib/harness/codexApprovalUi.test.ts src/lib/harness/codexQuestions.test.ts src/lib/harness/codexAttachments.test.ts src/lib/harness/codexElicitation.test.ts`

**227 passed across 8 files.** Log `/tmp/round2-muse-codex-tests.log`.

Read-only diagnostic regressions copy existing test harnesses into `/tmp`, rewriting imports to the actual worktree source and appending narrow checks. Repository files are untouched:

`NODE_OPTIONS=--no-experimental-webstorage npx vitest run --config /tmp/round2-harness-vitest.config.mjs -t round2`

**Five expected-behavior assertions failed**, covering the four findings (Stop failure has one per provider). Log `/tmp/round2-muse-codex-repros.log`; fixtures `/tmp/round2-muse.test.ts`, `/tmp/round2-codex.test.ts`, `/tmp/round2-tier.test.ts`.

Prior 3,091 web/445 Rust and real read-only smoke results are documented in the repair report; they were not re-run or independently certified here. This review performed no real provider prompts, native Tauri/UI interaction, authenticated MCP operations, WSL/Windows acceptance, release measurement or full repository security audit. One-shot Codex title/Git text helpers were checked for adapter wiring only, not independently audited.

### Structural evidence and coverage

Read AGENTS.md/docs/PRODUCT.md and current fixes. Used Codebase Memory first: list_projects (all 139 entries paginated enough to identify exact original checkout), exact search for sendMuseTurn/sendCodexTurn, both-direction depth-1 trace, then snippets. Generation `2026-09-13T15:07:47Z` points to ORIGINAL checkout, and returned snippets differ from this worktree; graph is provisional discovery only. Current worktree source and reproducible imported modules are authoritative.

Called check_index_coverage for every principal relied-on source/test/config/doc path, plus bounded `src/lib/harness` scope. Scope had no recorded gaps, `has_more=false`; many files were metadata_changed; Muse subagent files not_tracked; new validation/nativeSmoke files missing in that graph. Direct current source reads supplied fallback. No reindex or shared daemon mutation.

Memory registry lines 480-481 used only to orient established provider seams; current source verified the relevant facts. Root-owned transport note: both provider exits close RPC immediately (Codex 503-517; Muse 677-691), so subsequent buffered terminal stdout cannot be consumed after JsonRpcClient.close; root reviews native stdout/exit ordering separately.

---

## A — ACP providers

## Round 2 ACP review — current repaired tree

Reviewed read-only on 2026-09-15 in `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, HEAD `348c22e07723c32cd683483eb07e58952e08e88b` plus current repairs. No repository edits, application restarts, real prompts, commits, or provider mutations. Findings below are reproduced on the current code, not copied from the earlier review.

### Ranked findings

#### 1. P1 — Cursor approves a provider plan without a user decision, including after cancellation

**Current source:** `src/lib/harness/cursor.ts:620-625` (main anchor 624). `handleRequest` unconditionally emits the plan and responds `{outcome:{outcome:"accepted"}}`. It checks neither `live.planning` nor cancellation/muting and does not park an approval. Compare `src/lib/harness/grok.ts:634-644`, which deliberately abandons its provider plan to preserve MonoCode's separate Build decision.

**Trigger:** A Cursor Plan turn receives `cursor/create_plan`; alternatively, a delayed create-plan request arrives after the user presses Stop. Both responses are automatically accepted with no `approval.requested` or `question.asked`. The post-cancel case also emits fresh plan content after cancellation.

**Impact:** MonoCode represents explicit provider approval as granted when the user has not granted it, including after Stop. Current [official Cursor ACP docs](https://prod.cursor.com/docs/cli/acp) define this as a blocking request for explicit plan approval. This proves the erroneous approval RPC, not actual downstream file writes: the separate tool-permission gate can still deny later operations.

**Minimal fix:** Reply cancelled to cancelled/muted requests before rendering. For live requests, preserve the app's Build boundary by rejecting/deferring provider implementation approval, or use the existing approval card and respond accepted only after a concrete user decision.

**Regression:** Exercise create-plan during a Plan turn and immediately after cancel; assert no automatic accepted outcome, no late plan event after cancel, and acceptance only through the chosen explicit decision path. Two diagnostic tests reproduce the current defect.

#### 2. P2 — Overlapping ACP questions lose the first actionable form and hang the turn

**Current source:** `src/lib/harness/devin.ts:944-980`; `copilot.ts:1071-1107`; `cursor.ts:704-751`; `grok.ts:738-767`. Each handler emits `question.asked` immediately and parks its own resolver in a Map. Shared `src/lib/harness/apply.ts:116-127` unconditionally overwrites `pendingQuestion`; lines 138-141 clear only the currently visible request.

**Trigger:** Two provider/MCP questions arrive before either is answered, e.g. parallel tools request separate forms. Only request 102 is visible. Answer 102; its form clears, request 101 remains unanswered, and nothing makes its form visible again.

**Impact:** A provider waiting for both answers remains blocked until cancellation/timeout. This is not fixed by the Pi/omp question serialization, which does not cover these ACP adapters.

**Minimal fix:** Serialize presentation of ACP question requests at the existing owning boundary (as Pi/omp now do), and settle queued requests on cancel/stop. Do not overwrite an active question.

**Regression:** Send two real-shaped inbound requests to each of the four actual adapters, run events through the actual reducer, answer each in order, and verify both wire replies and no hidden resolver. Four /tmp diagnostics currently prove the lost-first-question behavior. The UI reviewer independently confirmed the singleton rendering contract.

#### 3. P2 — Skipping one required MCP field sends an invalid successful response

**Current source:** `src/lib/harness/acp.ts:605-619` reads properties but loses `schema.required`; `:727-731` omits empty fields then returns accept whenever anything was answered. Callers `devin.ts:968-980` / `copilot.ts:1095-1106` close the form and send that result.

**Concrete UI trigger:** Schema requires both `host` and integer `port`. Answer host, Continue, then click Skip on port. `src/chrome/QuestionForm.tsx:57-73` deletes only the current field and calls finish on the last page; `:53-54` calls `buildQuestionReply`. `src/lib/userQuestion.ts:92-107` returns kind answered when any earlier question was answered. The actual ACP serializer then produces `{action:"accept",content:{host:"example.com"}}`, missing port.

**Impact:** The adapter tells the MCP server that schema-invalid data was accepted and discards the actionable form; a validating server rejects the tool workflow instead of allowing correction. [MCP elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) defines accepted form data as matching the requested schema. This is reachable through the existing Skip button, not only a malformed programmatic reply.

**Minimal fix:** Preserve the required property set and prevent partial invalid accept. The smallest coherent fallback is to cancel the form when a required field is skipped, keeping optional-field omission valid; a correction UI instead needs navigation back to the omitted field. Avoid globally treating every optional MCP field as required.

**Regression:** Exercise the host → Continue → required-port Skip path using the real reply builder and serializer; expect a valid cancel/correction path, never accept without port. Also prove optional port can be omitted. Current diagnostic reproduces the invalid result.

#### 4. P2 interoperability — Standard titled MCP multiselects are misclassified as unsupported free-form arrays

**Current source:** `src/lib/harness/acp.ts:638` parses only `oneOf`, while `:675` throws when an array has no parsed options. Devin and Copilot advertise form elicitation and route it here.

**Trigger:** A valid titled multiselect uses `type:"array", items:{anyOf:[{const:"red",title:"Red"},...]}`. This is the titled multiselect shape in the current official MCP specification linked above. The parser collects no options and throws `Unsupported free-form array question`, so no usable question appears.

**Impact:** An ordinary documented form variant fails even though the existing question component can display multiselect choices. The explicit unsupported-form fallback avoids silent malformed data, but it does not make this supported schema interoperable.

**Minimal fix:** Parse array `items.anyOf` const/title entries through the existing choice mapping; preserve array values. Keep rejecting actual nested-object/free-form-array forms. Regression: the standard titled multiselect example renders its choices and returns selected strings as an array. One diagnostic confirms current rejection.

### Provider/scenario matrix

| Provider | Current repaired boundaries checked | Remaining result / live acceptance |
| --- | --- | --- |
| Devin | Cold-start sharing, cancellation/removal, saved resume preservation, selected-model failure, stop reasons; native model catalog path and shared ACP form mapping | Question overlap + required/multiselect form findings. Current-session model/effort and actual MCP tool/auth operations still need provider acceptance. Prior report's Devin smoke is not rerun here. |
| Copilot | Same lifecycle checks; effort bound to child launch and model/config fallback; protocol/adapter tests | Question overlap + required/multiselect form findings. Old-CLI effort fallback still uses child exit as a heuristic (suggestion below); actual account-specific effort behavior not exercised. |
| Cursor | Lifecycle, config rejection, timeout/cancel, resume, fixed-choice reply fallback, subagent/enrichment tests | Unapproved create-plan response and question overlap. Adapter `canSteer:false` correctly advertises the queue-only compatibility choice. Typed custom replies are outside the documented question response shape; the visible skip/followup fallback is coherent. Live model toggles/efforts and MCP calls remain unverified. |
| Grok | Lifecycle, selected-model failure, stop reasons, effort application, protocol/adapter tests | Question overlap. Provider plan exit deliberately preserves the separate Build boundary. Live mode/effort/model transitions remain unverified. |
| fx | Lifecycle, selected-setting failure, stop reasons, protocol/adapter tests; text-only prompt and CLI catalog mapping | No additional confirmed fx defect in this bounded pass. No mounted/native GUI, live provider model transition, or MCP execution acceptance performed. |

Cursor project/user MCP configurations are explicitly supported by its official ACP documentation; dashboard team MCP servers are excluded. Passing `mcpServers:[]` is not evidence that native Cursor MCP configuration is unsupported. None of this review verifies a configured server's actual runtime connection.

### Suggestions / unverified areas (not promoted to defects)

- Copilot's unsupported-effort fallback treats any child exit during startup with a requested effort as evidence the flag is unsupported (`copilot.ts:658-675`). A crash/auth exit could be mislabeled and downgrade the thread to default effort. Tighten this heuristic using definitive CLI diagnostics or capability evidence; a real CLI failure trace was not collected here.
- Cursor catalog fallback, boolean/string setting encoding, account-specific model/effort controls and return-to-default semantics need live provider-specific checks. Do not infer support or rejection only from sparse public docs or mocks.
- ACP completed ownership/prose cleanup and Cursor completed-tool pruning now provide logical retention limits. This review does not certify RSS, CPU, worst-case orphan event retention, native IPC, or end-to-end response latency. No new performance improvement is claimed.
- Unsupported URL elicitation/nested-object forms, live MCP login/reconnect/failure behavior, native Windows and Windows-to-WSL remain acceptance boundaries, not proven by protocol tests.

### Checks and evidence limitations

- Fresh current-tree run: **216 tests passed in 12 ACP/provider suites**, including all **44 acpReliability regressions**; no real prompts were sent. Command used `NODE_OPTIONS=--no-experimental-webstorage node node_modules/vitest/vitest.mjs run` with the five provider Live/Protocol suites, Cursor subagents, ACP subagents and ACP reliability.
- **8 additional /tmp diagnostic checks passed** by asserting the observed broken outcomes: four overlapping questions, two Cursor plan-approval cases, missing required data, and titled multiselect rejection. These are defect reproductions, not passing regressions that certify a fix. Artifacts: `/tmp/round2-acp-diagnostic.test.ts`, `/tmp/round2-acp-config.mjs`. Run with the same NODE_OPTIONS and `--config /tmp/round2-acp-config.mjs` from the reviewed worktree.
- Graph project `Users-kacperkepinski-Developer-personal-monocode` was ready at generation `2026-09-13T15:07:47Z`, rooted in the ORIGINAL checkout. Initial search → trace → snippet identified the ACP form seam, but the snippet was visibly offset from current source. Coverage checked for all cited/relevant source paths: repaired adapters/acp were metadata_changed; new reliability/report paths absent; no reported parser ranges. Current reviewed-worktree source and direct adapter/reducer execution were authoritative. No reindex/restart was performed.
- Parent owns native/child/JSON-RPC transport and another reviewer owns App/shared UI state; no duplicate transport conclusions are made here. Shared UI source was read only to close the concrete question-flow evidence.
- Memory quick pass supplied navigation context only; provider behavior and all findings were verified from current source. Memory reference: MEMORY.md:480-482, rollout 01a07ffd-7eb0-7083-99e7-89662a162e3f.

---

## O — Claude, Pi, omp and OpenCode

## Round 2 independent review: Claude, Pi, omp, OpenCode

Reviewed current source in `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, HEAD `348c22e07723c32cd683483eb07e58952e08e88b` plus existing uncommitted fixes. Read-only review; no repository edits, provider prompts, app restart, commits, or external writes. Temporary diagnostic copies live in `/tmp/monocode-round2-other`.

### Ranked confirmed findings

#### 1. P1 — Claude permission tightening ignores a rejected provider response

**Trigger:** Start or finish a turn with `full-access`, then select supervised and send another turn; the CLI returns an error for `set_permission_mode` (or fails to acknowledge it). The process remains in its previous permission mode.

**Current code:** `src/lib/harness/claude.ts:350-363` changes local mode immediately and records `pushedMode` when stdin writing succeeds. It does not await the provider control response. `claude.ts:741-743` treats every `control_response`, including an error, as initialization and discards it. Both the next-send path and the runtime mode picker call this function. A future supervised send sees the rejected mode cached and does not try again.

**Impact:** The UI can say supervised while the retained CLI still has bypass permissions. Adapter-side approval checks cannot protect operations for which that CLI no longer sends approval requests. The app neither reports the rejected tightening nor stops the process.

**Diagnostic:** Copied existing Claude live fixture to /tmp; started full-access, completed it, injected an explicit error control response for tightening, and observed both the next and third user prompts sent without any `session.error`; third send did not retry the control. The test passes as an assertion of the defect.

**Smallest fix:** Correlate and await the required control acknowledgement, cache only confirmed mode, serialize changes before subsequent prompts, and retire or stop the owned live process if tightening during active work cannot be confirmed. Keep failed or unknown updates visible. Existing JSON-RPC transport does not directly fit Claude's different control envelope; avoid inventing another generic protocol abstraction.

**Regression:** Explicit rejected and withheld tightening acknowledgements must block the next prompt and prevent the UI from claiming the tighter effective mode. Successful ack should retain process reuse.

#### 2. P1 — Pi/omp cancelled or expired RPC writes remain in the real child input queue

**Trigger:** A prior write blocks, a Pi/omp prompt or control is queued behind it, then its request is cancelled/closed or times out before it reaches native IPC. The earlier write subsequently drains.

**Current code:** `src/lib/harness/piClient.ts:53-56,69-74,79-90` only removes/rejects the pending response. It calls `writeChild` without the available AbortSignal. `src/lib/harness/child.ts:321-326,354-374` supports revoking queued writes, but PiRpc does not use it. `piFamily.ts:691-695` calls `cancelRequest(promptId)` during turn cleanup, so this is relevant to the live adapter, not an unused helper.

**Impact:** A request the adapter has already abandoned can still reach the CLI later. The frontend-only cancellation regression in the shared JSON-RPC client does not cover the separate PiRpc transport. This undermines stopped/failed turn ownership and makes user retry risky.

**Diagnostic:** Imported actual current PiRpc and child.ts; mocked only Tauri invoke/listen. Held the first native write, queued a prompt, cancelled its request, verified its promise rejected, released the blocker, and observed the cancelled prompt passed to actual child's `harness_write` invocation. No provider process ran.

**Smallest fix:** Give each PiRpc request a controller and pass its signal to `writeChild`. Abort on timeout, cancelRequest and close, including before pending deletion; preserve existing unknown-delivery retirement if IPC had begun. Add a closed guard to `pushLine` while touching the lifecycle, so closed clients cannot dispatch late unsolicited frames.

**Regression:** Real child queue plus mocked native write: cancelled/expired/closed queued requests never invoke `harness_write` after an earlier blocker releases. Already-delivered requests must retain unknown-delivery handling rather than claim they were unsent.

#### 3. P1 — OpenCode treats failed cancellation as successful and reuses the potentially running session

**Trigger:** User presses Stop while OpenCode is running; `/session/{id}/abort` returns HTTP 500 or rejects at transport. The server process itself remains available.

**Current code:** `src/lib/harness/opencodeClient.ts:81-84` swallows every abort failure. `opencode.ts:365-377` mutes events and emits completion after that call. The Live remains available and a following send reuses it. The same swallowed error also affects emergency abort after failed runtime permission changes. Pi/omp has a similar unconfirmed-abort pattern at `piFamily.ts:371`, but the independent reproduction here is OpenCode.

**Impact:** The user sees a stopped turn while provider work may continue, hidden by muted events. A new prompt can share the still-running provider session; old completion can also be mistaken for the new turn's completion. Stop has not established a safe ownership boundary.

**Diagnostic:** Used existing OpenCode live fixture with real current OpenCodeClient; made abort return 500, observed cancel resolve and active turn settle without error or `killChild`, then sent a new prompt using the same one spawned process. Four-provider native execution was not involved.

**Smallest fix:** Preserve abort errors and retire/stop the owned process on failed or uncertain cancellation, retaining the saved resume binding. Explicit disposal may still perform best-effort abort followed by unconditional cleanup. Do not reuse a live session whose stop was not established.

**Regression:** Aborted HTTP rejection and timeout must not leave a reusable Live or report confirmed stopping; following explicit send must use a fresh owned host/resume path.

#### 4. P2 — omp silently ignores a rejected Fast-mode disable and caches it as applied

**Trigger:** `get_state` reports `fastModeEnabled:true`; the user requests `fast:false`; `set_fast_mode` rejects.

**Current code:** `src/lib/harness/piFamily.ts:1123-1154` sets `fastModeRequested` before acknowledgement, catches the failure, and reports a fallback only when enabling. Failure when disabling is completely silent. The false requested value suppresses subsequent retries while effective Fast remains true.

**Impact:** Subsequent prompts run with an unexpected model execution setting; the UI and user's expected performance behavior disagree with the provider. Explicit effective-state replies that contradict an enable/disable request also are not reflected back consistently.

**Diagnostic:** Current omp live fixture initialized Fast true, rejected disable, observed the prompt sent with no status/config/error event, then another turn skipped `set_fast_mode` entirely.

**Smallest fix:** Cache confirmed effective state only and handle both enable and disable failures. For unsupported enabling, retain the existing visible fallback; on failed disabling report the retained true state or fail that turn rather than silently proceed.

**Regression:** Failed disable must be surfaced and remain retryable; response `enabled` differing from requested must update visible effective selection.

### Provider/scenario matrix

| Provider | Current positive evidence | Remaining failure/acceptance boundary |
| --- | --- | --- |
| Claude | Live process reuse; model-setting relaunch resumes bound conversation; queued-start invalidation; plan permission gating and actionable MCP approvals; attachment and structured tool/subagent paths exercised by existing tests | P1 permission acknowledgement gap; native installed CLI model/effort transitions, rejected control handling, cancel/late-output and real MCP auth/tool calls still need live acceptance |
| Pi | Shared RPC adapter applies requested thinking after provider state, preserves resume failure, supports attachment-only input and serialized extension select/input/editor questions; plan exposes configured read tools | P1 separate PiRpc queued-write gap; unconfirmed abort has a similar code pattern to OpenCode. Native extensions/MCP tooling, trust/config ownership and model transitions need live acceptance |
| omp | Same corrected Pi-family thinking/resume/question paths; native command and asynchronous prompt-result handling; Fast settings RPC and config updates; native command inventory | P1 PiRpc queue gap plus P2 Fast-disable gap; real command extensions, Fast support per selected model, plan tools and MCP need live acceptance |
| OpenCode | Mode updates serialized and awaited before prompts; message-indexed part routing; finalized replay bounded to 256 parts/1 MiB and retired IDs bounded to 2,048; native config inherited by local server; prompt + SSE lifecycle exercised by tests | P1 abort failure/reuse. Real server auth/MCP calls, permission rejection on installed version, SSE timing around stop/new send, compaction and native Windows/WSL are unverified |

The protocol fixture evidence supports transport and event mapping, not claims that configured MCP servers are connected or usable. Native user/project configuration is left to the CLI/server; actual discovery/authentication/tool calls and failures need provider-specific smoke acceptance. OpenCode discovery now uses the project cwd in `opencodeCatalog.ts`, so the older memory note describing global-only discovery does not describe this reviewed checkout.

### Performance and ease-of-use observations (not additional defects)

- Pi/omp settlement still waits for optional `get_session_stats` up to 4 seconds (`piFamily.ts:943-970`). Measure provider settlement semantics before moving the stats update after completion; this is the previously documented optimization candidate, not a new finding.
- OpenCode indexing reduces repeated whole-history scans and caps finalized replay; active streams remain deliberately retained. These are logical bounds, not measured RSS or latency guarantees.
- The existing shared question/approval surfaces now cover extension forms without a separate UI. Clear confirmed-versus-requested mode state is more valuable than another settings surface; P1/P2 above are concrete disagreements to fix.
- No new release-build performance measurements were run in this read-only pass. Previously reported reducer benchmark does not establish provider parity or end-to-end latency.

### Verification and limits

- Ran seven existing targeted suites: `claudeLive`, `claudeProtocol`, `ompLive`, `piProtocol`, `piClient`, `opencodeLive`, `opencodeProtocol`: **187/187 tests passed**.
- `/tmp/monocode-round2-other` adds four independent diagnostic assertions of current bugs: **4/4 passed**. Execute from reviewed worktree with `NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run --config /tmp/monocode-round2-other/vitest.config.mjs -t round2`. The copied fixture suites are skipped by the filter. These are local IO/protocol diagnostics, not production patches or live-provider tests.
- Current checkout remained unchanged by this reviewer. Full prior web/Rust validation in `docs/validation/harness-integration-fixes.md` was read as prior evidence, not rerun or claimed as new evidence.
- Graph-first discovery used project `Users-kacperkepinski-Developer-personal-monocode`, ready generation `2026-09-13T15:07:47Z`, original-checkout root. Followed symbol search, Pi runTurn trace, applyModel snippet and coverage on every relied-on provider/transport path. Original graph differs from this worktree and marked several Claude/OpenCode paths metadata-changed; current worktree source was authoritative throughout. No reindex or shared service changes. This was a bounded correctness/product review, not an exhaustive graph or security audit.
- Memory lookup used `MEMORY.md:480-481` as initial provider-seam/discovery guidance; current source corrected its stale OpenCode-discovery note. Associated rollout ID `01a07ffd-7eb0-7083-99e7-89662a162e3f`.

---

## U — Shared workflow and UI

## Round 2: shared workflow and UI review

Reviewed current uncommitted work in `/Users/kacperkepinski/Developer/personal/monocode-worktrees/agent-harness-reliability`, base `348c22e07723c32cd683483eb07e58952e08e88b`, read-only. Four remaining defects reproduced; existing focused suite still passes. These are current integration defects, not all newly introduced lines.

### Ranked findings

#### 1. P1 — Preserve Plan intent for manual queued delivery

**Location:** `src/App.tsx:6333-6338`; UI action `src/chrome/Composer.tsx:397-405`.

**Trigger:** While a turn is running, enable Plan and submit an implementation request. It queues as intended. Click the queue row's **Steer**, or stop the current turn and click **Send now**.

**Defect/impact:** `onSteerQueuedMessage` forwards the text/cards/action but omits `message.intent`. `onSubmit` defaults missing intent to `default` (4810), so the existing plan-only queue restriction (4884) and `planTurnPrompt` no-edit instructions (5243) are bypassed. The request may be steered into an executing turn or sent as ordinary execution despite the user's Plan selection. Automatic queue dispatch correctly forwards intent (6258), so behavior changes depending on which visible action is used.

**Minimal fix:** Pass `intent: message.intent` through the manual queued action; disable/describe busy Plan steering because plan requests must start a fresh turn. Add the same scenario to the actual App callback/mounted flow tests.

**Evidence:** Current-source callback extracted via TypeScript AST and executed with real `queuedMessageForSubmit`: expected `intent: plan`, received undefined. `/tmp/round2-ui-regressions.log`.

#### 2. P2 — Route pending approvals/questions to their owning provider after picker changes

**Location:** `src/App.tsx:6895-6917`; switch state at `src/App.tsx:4694-4715`.

**Trigger:** Muse asks a question or waits for approval. Select Codex in the model picker for subsequent work, then answer the still-visible Muse card (or interact with its optional-question deadline).

**Defect/impact:** The picker changes `session.harness` while retaining the current request and `pendingSwitch.from`. Approval, answer and keep-open handlers all address `session.harness`, so they send to Codex instead of the active Muse process. The decision is generally ignored and Muse stays blocked; the UI does not explain why. Switching back is an accidental workaround.

**Reachability:** `Composer.tsx:1351-1357` renders the question above the ordinary composer. `Composer.tsx:1786-1798` keeps ModelPicker enabled, without busy/question restrictions. `onModelChange` only refuses during an actual preparing handoff, not an outstanding question; setting `pendingSwitch` does not perform a handoff until submit. Current-source model-change callback check confirms new harness + old pendingQuestion.

**Minimal fix:** Resolve approval/question/deadline destination from the request/running provider (active ownership or armed switch's source), preserving current-provider fallback for existing idle cases. Regression: change provider while a question/approval is visible, then answer and keep open; only the original owner receives it.

**Evidence:** Actual `onQuestionReply` callback executed against switched current state: expected Muse, received Codex. The same owner lookup is used by the other two handlers. No provider requests were sent.

#### 3. P2 — Earlier invalid question answers cannot be corrected

**Location:** `src/chrome/QuestionForm.tsx:37-41,57-81,175-182`; numeric boundary `src/lib/harness/acp.ts:701-713`.

**Trigger:** An ACP/MCP form contains a numeric first field and another field. Enter a non-number (or out-of-range number), continue, answer the final field, and submit.

**Defect/impact:** Numeric validation correctly rejects the answer and preserves the request. The form remains on its last step, because only a changed request ID resets navigation. There is no Back control. Continue resubmits the invalid earlier answer; Skip deletes only the last answer and also resubmits the invalid earlier value. The user cannot correct or fully skip the request without stopping the turn.

**Minimal fix:** Keep answer state and provide Back navigation, or return to an invalid/first field on an error while preserving entries. Regression: two-field numeric form with invalid first answer; navigate back, correct it, then deliver valid typed result.

**Evidence:** Mounted actual QuestionForm in happy-dom, entered `NaN` in field 1, answered field 2, rerendered same request with error. Remains `2 of 2`, no Back. Expected recovery-navigation assertion fails.

#### 4. P2 — Compaction can overwrite a next-turn model/effort choice

**Location:** `src/App.tsx:6757-6762`; `src/lib/harness/apply.ts:166-183`.

**Trigger:** Start compaction with omp, then change the model/effort while the provider's settings update/acknowledgement is still pending. Queue a followup if desired.

**Defect/impact:** Ordinary turns record `activeTurnModel`, which lets `session.configChanged` distinguish confirmed running settings from a newer picker choice. Compaction marks only `busy`, without an ownership/settings snapshot. Therefore a late old `configChanged` is treated as the selected choice and overwrites the user's newer model/effort; the queued turn runs with the older selection. The Next turn hint also requires the missing snapshot.

**Provider path:** `piFamily.compactContext` invokes `applyModel` at 282. omp `config_update` emits `session.configChanged` at 744-774; supported setting clamping/fast fallback also emits config changes. This does not require an invented event type.

**Minimal fix:** Give compaction the same in-flight settings snapshot/cleanup as a turn, or otherwise gate acknowledgements against the compaction's captured selection. Avoid adding a separate model-state framework. Regression: pause compaction's setting acknowledgement, pick new model/effort, deliver old acknowledgement, verify selection and queued dispatch stay new.

**Evidence:** Actual current `onCompactContext` callback + actual reducer: expected `omp:new`, received `omp:old` after config acknowledgement.

### Scenario matrix / positive evidence

| Scenario | Current assessment |
| --- | --- |
| Synchronous back-to-back state updates and event batches | New shared hook prevents stale render snapshot replacement; existing regression passed |
| Rejected Composer callback / next draft typed during async preflight | Existing mounted Composer regressions passed; draft retained and subsequent text preserved |
| New model/effort selected during ordinary turn | Active snapshot and matcher queue followups; reducer tests passed |
| Model/effort selected during compaction | Finding 4 |
| Queued Plan automatic dispatch | Preserves intent; manual delivery has finding 1 |
| Provider picker changed during pending decision | Finding 2 |
| Single-field invalid numeric reply | Error stays visible/actionable; earlier field in multi-step form has finding 3 |
| Overlapping independent questions | Shared reducer still has singleton pendingQuestion; ACP reviewer owns provider-specific finding. Second question overwrites first with no shared recovery queue |
| Unconfirmed steer | Retained transcript plus paused queue warning; readiness predicate defaults false; no automatic uncertain resend |
| Stop/removal during startup/steer preparation | Generation gates prevent dispatch after invalidation; complete mounted App/native cancellation race still unverified |
| Hidden transcript pane | Custom memo comparator skips parent-driven transcript updates while both props hidden; timers/observers depend on visibility. Descendant/context-driven render cost not measured |
| Muse finishing status | Transient activity clears on content/completion and avoids permanent reminder rows; existing apply/transcript tests passed |
| User Markdown/literal HTML | Existing actual render regressions passed; no new defect found in inspected path |
| MCP inventory | Explicitly says configured, not connected; changes require reconnect/new provider session. Actual discovery/auth/tools not validated by this UI copy |

### Validation and limits

- Read current AGENTS.md, PRODUCT.md, and harness-integration-fixes.md; reviewed the repairs against current source instead of assuming report claims prove acceptance.
- Graph-first registry discovery, trace and snippet performed. Project points to original checkout, generation `2026-09-13T15:07:47Z`; coverage checked for relied-on paths. Changed/missing/untracked metadata and worktree mismatch resolved by reading authoritative worktree source. No shared graph reindex.
- Focused existing suite: **11 files / 139 tests passed**. Command: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/chrome/Composer.test.ts src/chrome/QuestionForm.test.ts src/surfaces/AgentTranscript.test.ts src/hooks/useSessionState.test.ts src/lib/harness/apply.test.ts src/lib/harness/applyBatch.test.ts src/lib/harness/registry.test.ts src/lib/messageQueue.test.ts src/lib/models.test.ts src/lib/turnTiming.test.ts src/lib/userQuestion.test.ts`. Log `/tmp/round2-ui-existing-tests.log`.
- Independent outside-repo regression fixture: **4 failing expected-behavior assertions, 1 passing reachability check**. `/tmp/round2-ui-fixture/review.test.ts`, run from that directory with `NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run --config vitest.config.ts`. Log `/tmp/round2-ui-regressions.log`.
- Callback checks extract actual callback bodies via TypeScript AST, with native/provider collaborators stubbed; QuestionForm is mounted in happy-dom. This is stronger than copied logic but is **not a full mounted-App, browser, native WebView, or authenticated-provider acceptance test**.
- No repository edits, commits, app restart, live prompts, native controls or MCP writes performed.
- No new performance measurement was run: reducer benchmarks in existing report do not establish native end-to-end speed, WebView/RSS, background concurrent session cost or model generation speed. Real provider model/effort/MCP transitions and full native race checks remain acceptance gaps, not newly proven regressions.

### Optional polish (not blockers)

- The configured-versus-connected MCP explanation is useful but sits below the inventory; a short note beside the MCP title would be easier to discover in a long list.
- Timing is debug-stage evidence. The immediate approval/question reducer path drains queued content without calling markTurnContentApplied (App1196-1217), so a first content event immediately followed by a decision request may not receive an accurate first-content-rendered mark until a later batch. This is telemetry precision, not lost transcript content.
- No new abstraction or broad UI redesign is needed for the findings.
