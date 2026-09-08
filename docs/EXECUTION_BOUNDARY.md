# Execution boundary decision (#4)

Reviewed fork main `1ddb6e6ad1183497a6b753cae566f50826d414a3` on 2026-09-08.
**Keep the existing app-owned backend for initial WSL work.** Add explicit host
identity at the existing spawn, Git/filesystem and attachment boundaries in #22.
Do not require a durable daemon before WSL. True app-exit durability (#21) needs
protocol/approval ownership outside the WebView, not merely detached children.
This report and experiment add no production runtime, schema or provider changes.

## Current ownership and call paths

| Responsibility | Current owner and source evidence | Consequence |
| --- | --- | --- |
| Dispatch | `App.tsx` → `harness/registry.ts::sendHarnessTurn` → `codexAdapter.ts`/`claudeAdapter.ts` → provider implementation | Reuse registry and provider semantics; ticket/Git/CI identity is not agent identity. |
| Agent process | `harness/child.ts::spawnChild` → `harness.rs::harness_spawn`; Rust `HarnessHost` stores stdin, PID and per-session spawn epochs | The selected cwd is currently expanded/validated on the native host. Spawn/cancel generation checks prevent late registration; preserve them when adding a host. |
| Protocol and approval | `harness/codex.ts::ensureLive`, `cancelCodexTurn`, `respondCodexApproval`; equivalent Claude paths in `harness/claude.ts`; `jsonRpc.ts` holds pending requests | These are WebView maps/promises. A process surviving its UI does not preserve this state. Cancellation is provider-specific: Codex turn interrupt versus Claude control interrupt. |
| Events | Rust emits stdout/stderr/exit and SSE; `harness/child.ts` routes to callbacks; `App.tsx` batches transcript updates using animation frames or a 32 ms hidden-window timer | Exit routing checks PID. stdout/stderr payloads carry session ID without a durable sequence/generation. This is not an acknowledged reconnect log. |
| PTYs | `pty.rs::PtyHost`, native Unix PTYs/Windows ConPTY; `lib/pty.ts` sends write/resize/kill and owns frontend subscriptions | Backend coalesces at 8 ms/32 KiB. Frontend replay retains up to 256 KiB/200 chunks, except an oversized newest chunk. Hiding a view is different from losing the backend. |
| Persistence | `session_store.rs` SQLite stores transcripts, provider-session IDs, in-flight references and workspace snapshot; `App.tsx` schedules transcript saves at 650 ms and snapshots at 250 ms | Stored history can recover a UI and seed provider resume; it does not record every protocol exchange or approval promise. Several lifecycle save failures are swallowed, so recovery is best effort. |
| Timers | `harness/registry.ts` parks settled children after five minutes; persistence and render scheduling live in the WebView | Timers disappear with the UI. Do not describe app-open schedules as durable. |
| Git/files | `fs.rs::git_cmd` runs native `git`; `git_checked` supplies native `-C`; `expand_home` uses the native home and `PathBuf`; harness spawn sets native `current_dir` | Linux paths cannot simply be passed to these native operations on Windows. Route Git, file operations and agent cwd consistently. |
| Quit | `appLifecycle.ts` → Rust `window.rs::confirm_quit` → both hosts' `kill_all`; `lib.rs` repeats cleanup on Exit/last-window destruction | Quit is intentionally destructive to live execution, while preserving recoverable chat state. Do not remove this safeguard to simulate durability. |

These are verified source paths, not an exhaustive audit of every provider or IO
call. The parent graph was dated 2026-09-06 and reported these files `not_tracked`;
graph searches found no current MonoCode symbols. Fresh indexing was blocked by
an active unverified generation, so direct source reads supplied the evidence.

## Lifecycle outcomes

| Event | Current behavior / limit |
| --- | --- |
| Busy window close, macOS | `App.tsx::onCloseRequested` persists live transcripts and hides the window. Its WebView/backend remain alive; this is app-open execution. |
| Busy window close, Windows | `appLifecycle.ts::closeBusyWindow` asks to stop that window's chats, persists state, reaps its runtime and destroys it. Other windows are intended to stay open. Native Windows interaction remains unverified. |
| Idle window close | Saves state and destroys the window. Last-window destruction reaps backend children; macOS can remain in the Dock. Dock presence is not active execution. |
| App quit | Confirms when work is in flight, marks interrupted state, saves and kills managed agent/PTY children before exiting. |
| WebView unload/reload | `pagehide`/`beforeunload` perform best-effort persistence and `reapWindowRuntime`; protocol maps and callbacks disappear. A reload is not a reconnect to independently owned work. |
| Backend crash | Normal Rust Drop is not guaranteed on abrupt failure. Windows `windows.rs` uses an app-owned kill-on-job-close job and suspended enrollment. Unix fork-marked orphans may survive until cleanup on a later launch; survival does not establish controllable/resumable execution. |
| Provider exits | Rust waits, removes the matching PID and emits exit. The frontend filters stale PID exits; Codex/Claude reject pending turns and emit session-ended. Exit code alone is not task acceptance. |
| Connection loss | Current stdio/IPC/SSE callbacks have no cross-process durable replay acknowledgement. UI or transport loss must be treated as uncertain state, not successful completion or permission to resend. |
| Restart | `appLifecycle.ts::loadResumedWorkspaceOnce` restores snapshots/transcripts, marks in-flight sessions interrupted, restores checkout and seeds provider resume through `bindResumedSessions`. Codex starts an app-server and tries provider thread resume; this is a new process, not preservation of the old turn. |

## Minimum implementation seams

For #22, carry an explicit native or WSL-distribution identity with the existing
repository/worktree/session association. A WSL target includes its distro and
Linux path; a native target includes its native path. Display the effective host
and refuse mismatches. Do not use a string prefix or Git remote to infer it.
Start with Codex, preserve native operation and test one other existing provider
where shared lifecycle changes apply.

Route spawn, binary resolution, Git, file listing/reading/writing and attachments
through the chosen host. Prefer argument arrays to interpolated shell commands.
Do not run Windows Git against WSL metadata or silently translate Linux paths
into Windows paths. Cancellation must stop/read back the exact Linux process
tree; killing `wsl.exe` alone is not evidence that it stopped. Keep Windows service
credentials separate from Linux Git/agent credentials, and expose unsupported
capabilities instead of substituting a host/account. No credential copying.

For #21, first move only the state that must survive exit: provider transport and
pending approvals, process ownership, authoritative run status, bounded events
with sequence/generation, and cancellation/reattach handling. Keep presentation
in React and reuse provider protocol translations. Require a snapshot plus replay
cursor/gap reporting, stale-owner rejection and idempotent request identity before
reconnecting a UI. Pending approvals stay pending or fail explicitly on recovery;
never grant them because the UI disconnected. Preserve existing app-owned cleanup
until a tested runtime explicitly owns a session. No general RPC/plugin framework
is selected by this spike.

Count/byte boundaries matter: frontend harness buffers cap 1,000 **lines**, not
bytes; Rust reads whole lines. They are not a hard bound on a malformed giant line.
PTY replay is already byte-oriented. Audit/truncate or reject oversized protocol
records at the owning transport, preserve explicit overflow/gap evidence, and
measure busy output before claiming durable bounded replay. This report does not
change those existing limits or claim a performance fix.

## Executed bounded ownership experiment

```sh
node --test scripts/execution-boundary-spike.mjs
```

Uses only installed Node and an exclusive temporary directory. A short-lived
launcher starts a detached local worker and exits. The observer reads ordered
records, detaches for 150 ms, reconnects with its cursor, rejects a wrong run ID,
requests cancellation twice and verifies a terminal acknowledgement/no later
records. Output is capped at 100 small JSON records (<32 KiB), with a natural
nominal 2.5-second producer duration (plus scheduling/IO overhead). It never opens a network listener, provider, user
repository or credential. Failures retain only their disposable directory; no
PID-based cleanup can affect unrelated work.

On macOS 26.6.2 arm64 / M5 Pro / Node 22.23.2: passed, launcher exited, cursor 2,
nine ordered events, stale cancellation rejected and cancellation acknowledged,
approximately 363 ms test time.
This establishes the **local OS primitive** and replay/cancellation assertions.
The observer is a command-line test, not the MonoCode UI; file replay is a trial
mechanism, not the chosen production transport. It does not establish provider
approval recovery, true MonoCode durability, Windows job behavior or WSL support.
The test's duration is not a release-app performance measurement.

## Reproducible blocked Windows-to-WSL check

Missing input: a designated Windows tester/machine with two named WSL2 distros,
an authorized disposable Linux Git checkout and existing Linux agent credentials
under #28. No such machine or service authority was supplied in this run. Do not
create accounts, install distros, copy credentials or use production fixtures to
make the check pass.

In PowerShell, select an existing distro and exact Linux test path explicitly:

```powershell
$Distro = 'REPLACE_WITH_AUTHORIZED_DISTRO'
$LinuxRepo = '/REPLACE/WITH/DISPOSABLE/REPOSITORY'
wsl.exe --list --verbose
wsl.exe --distribution $Distro --exec uname -sr
wsl.exe --distribution $Distro --exec id -un
wsl.exe --distribution $Distro --exec git --version
wsl.exe --distribution $Distro --exec git -C $LinuxRepo rev-parse --show-toplevel
wsl.exe --distribution $Distro --exec git -C $LinuxRepo status --porcelain
wsl.exe --distribution $Distro --cd $LinuxRepo --exec codex --version
```

Check `$LASTEXITCODE` after each invocation; stop on nonzero. Record distro/version,
Linux user, resolved checkout and CLI versions without credentials. Repeat on the
second distro and a separate native Windows checkout with colliding project names.
No Windows Git invocation may receive `$LinuxRepo`.

Then, with #28's explicit model-usage authority, run a one-turn read-only agent
smoke **inside the selected distro** using its installed CLI's supported command.
Use the prompt “Reply only MONOCODE_WSL_OK; do not run tools or change files.”
Record the chosen account/profile, working directory, completion and empty Git
status. Do not infer account identity from a successful version probe. The first
app-integrated #22 trial must additionally exercise real dispatch/events,
approval/denial, cancel while spawning, duplicate clicks, provider failure,
wrong-distro/path rejection and exact Linux process readback after cancellation.
These remain blocked/live checks; the commands above have not run on this Mac.

For #21, rerun the bounded ownership experiment on Windows, then replace its
synthetic observer with the isolated app and its worker with the selected actual
runtime/provider. Test UI close, quit, crash, reconnect, pending approval, replay
gap and runtime loss separately. Do not advertise survival until that integration
passes; an explicit blocked experiment satisfies this spike's decision evidence,
not #21/#22 acceptance.

## Validation and upstream overlap

Untouched main baseline: `npm run check` (1,396 web tests, 215 Rust tests, TypeScript,
formatting and Clippy) and `npm run build` passed. Vite chunk/mixed-import warnings
are unchanged. The final full checks and web build also passed. The standalone spike is added
to the existing three-platform CI workflow; hosted results belong in the PR.
This is a self-review, not an independent review. No UI or runtime behavior changed,
no migration/import is needed, and no release performance claim is made.

Upstream through `464e95e` was reviewed: the two commits beyond fork main alter
code-block theme/split-chat background only. Existing cleanup, idle parking,
resume and PTY coalescing were reused as evidence; no unrelated upstream merge
or copied external reference code is included. #22 owns real WSL implementation;
#21 owns durability and #27 owns integrated acceptance. This report should be
linked from those work items after review without changing their completion state.
