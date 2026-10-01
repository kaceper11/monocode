# Windows UI with tools inside WSL

MonoCode keeps each WSL project, worktree and session qualified by its distro.
The guest login environment supplies Linux executables and credentials. Native
Windows CLI overrides apply to native projects; WSL settings inspect the guest
CLI discovered automatically from the selected distro.

## Automated checks

`npm run check` includes provider coverage and host-routing regressions. CI also
runs `python3 scripts/test-wsl-bridge.py` on Linux/macOS. The provider coverage
test compares the application registry with guest discovery, so a newly added
provider requires an explicit WSL implementation.

These checks do not establish real Windows/WSL acceptance. On a Windows machine
with Rust, the repository's build prerequisites, WSL2, and Python 3.9+ and Git
installed inside the chosen distro, run:

```powershell
npm run test:wsl -- -Distribution Ubuntu
```

This command fails when prerequisites are missing. It runs guest discovery
regressions and the explicitly ignored `live_wsl_acceptance` Rust test through
actual `wsl.exe`. The test creates an isolated guest repository, exercises the
production bridge and process supervisor, checks authenticated loopback HTTP
and SSE from Windows, and verifies cancellation kills the guest descendant.
It removes its own temporary repository and does not change shell profiles or
provider credentials. The HTTP server is a fixture, not a real OpenCode agent.

## App and provider acceptance

Use a Windows release build and a repository under the distro's Linux home.
Record Windows/WSL versions, distro, app revision and provider CLI versions.
Repeat the identity checks with another distro and with a task worktree.

- Open the project, browse/read/edit files, search, inspect Git status/diffs,
  create a worktree, run a saved command and open a terminal. Confirm tools run
  inside the selected distro and native projects still use Windows tools.
- Set guest `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `PI_CODING_AGENT_DIR` in the guest
  login environment. Refresh/reconnect and confirm sign-in hints, account
  identity and usage refer to that directory, including `~/` paths. An empty
  selected directory must not borrow credentials from the default account.
- Restore an older OMP session with omitted interjections or split assistant
  text. Confirm its guest transcript repairs the saved session once. A native
  session with the same provider ID must remain separate.
- Install/sign in to Antigravity in the guest. Check models, first turn,
  resume, permission denial, cancellation and cleanup. Switch projects/distro
  during model discovery and confirm catalogs stay isolated.
- Install/sign in to Devin in the guest. Check CLI model discovery and ACP
  fallback, first turn, queued follow-ups, resume, approvals/questions,
  compaction, cancellation and cleanup. Verify Supervised uses `ask`, edits
  use `accept-edits`, Auto uses `smart`, Full access uses `bypass`, and Plan
  uses `plan`. Native CLI overrides must not affect guest discovery; repeat
  with another distro and a task worktree to check cwd and catalog isolation.
- Install/sign in to OpenCode in the guest. Check models, chat and text
  generation, SSE updates, Go usage, approvals/questions, resume, worktree fork,
  same-distro file/image attachments and cancellation. Block localhost
  forwarding to verify a clear startup error before session writes. Native
  paths and another distro's files must not be silently treated as guest files.
- Install the WSL extension in native VS Code or Insiders. Open a Linux folder
  with spaces or a dotted name from MonoCode. Confirm the editor shows the
  selected WSL distro and its terminal uses the guest directory. A missing
  extension must show an installation error; other editors are unavailable
  for WSL in this integration.

No live Windows/WSL machine was available during implementation. This checklist
and the real-boundary command remain to be run; passing local tests or native
Windows CI is not live WSL acceptance.

## Reviewing upstream merges

Run the existing checks and review new file/process operations, transcript
recovery, model/authentication lookups and editor launches for effective cwd
propagation. Provider coverage detects registry additions; it cannot detect
every new upstream feature that accidentally bypasses the execution boundary.
Reuse the shared routing seams and add a regression at the boundary that owns
any newly discovered gap.
