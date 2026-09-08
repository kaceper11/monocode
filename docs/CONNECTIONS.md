# Connections

Use **Settings → Connections** for the current project. Tickets, **PRs and CI**, Git remote and execution host use compact rows in
**Integrations**. Select
**Change** on a role, choose its provider/account and full project identity, then
**Save**. **Cancel** leaves the saved role unchanged. **Change connection** in the
inbox opens this same surface for the selected item's project. Git remote uses
**Save changes**; changing a mapping never edits the Git remote URL.
GitHub and Linear reuse the existing provider marks and settings controls.

**Use existing settings** preserves the existing GitHub remote/CLI-account
behavior and the connected Linear account. **None** disables that project service.
PRs and CI share setup by default: **Use this connection for CI** visibly saves
GitHub Actions with the selected GitHub account/repository, or Azure Pipelines
with the selected Azure connection. Existing different CI choices are preserved
unless sharing is explicitly selected. No pipeline ID is guessed; future connectors
still need their own pipeline selection and access checks.
**CI settings** expands the independent provider/account/project controls and
additional sources, including GitHub PRs + Azure Pipelines. Clearing PRs leaves CI
unchanged: branch builds can run without PRs. CI connectors remain unavailable in
this slice; a saved mapping never implies that checks have run.
Azure DevOps uses one account selection across Boards, Repos and Pipelines; existing
role-specific Azure account entries remain readable without rewriting credentials.
Jira appears only among ticket providers.
Explicit GitHub bindings use `hostname + account + owner/repository`; issue and PR
sources can differ from each other and from the Git remote. New worktrees inherit
the opening project's bindings only when they have no saved bindings of their own.

GitHub account credentials remain in the GitHub CLI on the UI computer. Sign in or
rotate with `gh auth login --hostname HOST`, then connect the exact login and test
repository. MonoCode reads that named credential, verifies its actual account,
and never changes the CLI's active login. Writes are separately enabled per
account and still require provider-side permissions. Reads need repository access;
comments and PR creation need their corresponding write permissions.

Disconnect first shows how many projects use the account and allows cancellation.
It removes MonoCode's selection, not the CLI credential or provider grant.
Use `gh auth logout` to remove the CLI login, or revoke it in the provider's account
settings. In-flight requests may complete. Queued requests recheck their original
binding before starting; changing/disconnecting a source does not retarget an open
item or send its comment through another account. The current Linear token and
team-filter controls are reused; this slice does not add multiple Linear accounts.

Jira, Azure Boards, Azure Repos, GitHub Actions and Azure Pipelines currently store
explicit mappings only. They report unavailable capabilities and do not poll.
Mixed mappings can be prepared without disabling an available GitHub source or
local Git. CI changes do not invalidate the inbox's connection identity.
WSL is displayed as unavailable here; #22 supplies that execution connector.
Service credentials and execution-host credentials are never copied between hosts.

An explicit Git remote affects push, pull and sync, without editing Git config or
changing the branch upstream. Bound PR creation verifies that its selected GitHub
repository has the same head commit as the local branch. Review replies check that
the thread still belongs to the selected PR. There are no automatic write retries.

## Data and limits

Metadata uses a versioned, separate local settings key, with one previous-value
backup (`monocode.connections.v1.backup`). Existing session and credential storage
are untouched. Unsupported/corrupt metadata fails visibly instead of resetting or
silently selecting another account. Concurrent settings saves reject stale data;
reopen Settings to load the other window's changes.

Metadata is capped at 256 KiB, 32 accounts and 256 project mappings. Each project
has up to eight ticket and eight CI sources. GitHub requests have four active slots
and 64 waiting slots. Inbox discovery uses at most 64 checkouts, deduplicates source
identities, and retains at most 2,000 GitHub items with a visible limit message.
Details/repository caches hold 200 entries, threads 32, and PR diffs eight.

CLI capture is bounded to 16 KiB / 10 seconds for credentials, 1 KiB / 10 seconds
for account verification, and 2 MiB / 30 seconds for a data request. A bound request
can therefore spend up to 50 seconds across these stages. Processes use Unix groups
or scoped Windows jobs; timeout/overflow terminates their owned processes. An
oversized PR patch preserves its metadata with the existing truncated state.

## Verification and manual scenarios

Run `npm run check` and `npm run tauri build -- --bundles app`.
The opt-in production read uses an existing, explicitly chosen CLI account:

```sh
MONOCODE_GITHUB_LIVE_ACCOUNT=YOUR_LOGIN \
MONOCODE_GITHUB_LIVE_REPOSITORY=OWNER/REPO \
cargo test --release live_selected_github_account_read -- --ignored --nocapture
```

Use disposable Git repositories and authorized service resources:

1. Keep the Git remote local; bind GitHub tickets to a selected account/repository.
   Read an issue, its body and thread. Configure PRs independently. Verify the
   displayed account/site/repository and ask-context identity.
2. Configure two accounts with the same provider and repository/item numbers.
   Confirm separate identities; disconnect one and refresh. The other must work.
   Queue a request and disconnect before it starts: it must reject the stale binding.
3. Replace/expire a test credential and deny its scopes. Test the exact account.
   Confirm visible failures, no active-account fallback, and no secrets in errors.
4. Change only CI to Azure Pipelines. Keep tickets on GitHub or Jira and PRs on
   GitHub or Azure Repos. Confirm the other saved values and Git config are unchanged.
5. Push to a disposable second remote. Confirm only that remote changes and no
   upstream config is added. Open a worktree and verify inherited/explicit mappings.
6. Save a GitHub PR connection with **Use this connection for CI** selected and
   verify the shared account/repository. Set an Azure CI override, reopen the PR
   editor and confirm sharing is off. Cancel a changed shared connection; neither
   saved role may change. Clear PRs and confirm CI stays editable.
   Change a role, select None, then Cancel; reopen it and verify its saved value.
   Repeat with Save and confirm only that role is cleared. Add a second ticket/CI
   source, cancel it, then add and save it. Connect an account while editing, cancel
   the role, and confirm the account remains connected but the mapping is unchanged.
7. Review narrow-window layout, keyboard access and connect/test/disconnect using
   the native Mac app; repeat credential-owner checks on native Windows.

Fixtures and builds do not certify live second-account, provider-write, native
Windows credential or WSL acceptance. Record those separately from implementation.
