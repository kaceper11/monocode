# Acceptance readiness (#28)

Snapshot: 2026-09-08. **Readiness remains incomplete.** An available toolchain,
passing CI or a connected account is not acceptance of a feature. Use this matrix
alongside [roadmap #1](https://github.com/kaceper11/monocode/issues/1) and
[local isolated-build instructions](LOCAL_DEVELOPMENT.md).

## Available evidence and missing inputs

| Boundary | Status and evidence | Owner / smallest missing input | Relevant issues |
| --- | --- | --- | --- |
| macOS development | Available: macOS 26.6.2 (25G83), arm64 M5 Pro, 15 cores, 24 GB RAM; Node 22.23.2, npm 10.9.8, Rust/Cargo 1.98.1, Apple Git 2.50.1, gh 2.98.0. Clean main `1ddb6e6` checks/build passed. | Current workstation; this agent can run local checks. Requester owns retained profiles/artifacts. | #2/#3/#4/#27 |
| Isolated macOS UI | Partial verification in [PR #34](https://github.com/kaceper11/monocode/pull/34): release bundle with fresh benchmark identity/profile launched, loaded synthetic history, preserved unsent input across tabs and quit while stock remained running. | Designated tester still needed for terminal input/load, full coexistence and measured interaction. UI automation did not deliver terminal keystrokes; no command ran. | #2/#3/#28 |
| Native Windows desktop | Blocked: no named machine/access method supplied. Hosted Windows CI is separate. `wsl.exe`, PowerShell/pwsh are absent from this Mac's PATH; this is not an inventory of the user's other machines. | Requester designates Windows tester, machine, access method and separate disposable native checkout. | #2/#3/#4/#27 |
| Windows → WSL2 | Blocked: no two authorized distributions or Linux test checkout/agent identity supplied. | Windows tester supplies distro names/versions, Linux Git/agent versions, safe paths and account/profile references. | #4/#22 and later integrations |
| GitHub fork | Verified repository-scoped reads, fork branch pushes/PR creation and hosted CI inspection through `gh ... -R kaceper11/monocode`; [PR #30](https://github.com/kaceper11/monocode/pull/30) has successful three-platform checks. | Task authority covers selected fork branches, PRs and evidence comments only. No application-driven publication/repair or second test account has been designated. | #6/#10/#16/#27 |
| Jira Cloud | Blocked: available Atlassian connector's resource-list request returned `USER_NOT_LOGGED_IN` (not connected). No site/project/fixture has been read. | Requester supplies an authorized existing connection/site, fixture owner and assigned/custom-status issue IDs. Do not put credentials here. | #6/#11/#16/#23/#24/#27 |
| Azure Boards | Blocked: no organization/project, account or work-item test target supplied; local `az` CLI is absent. This does not prove no account exists elsewhere. | Requester supplies owner, existing account reference and approved work-item IDs/statuses. | #6/#12/#23/#24/#27 |
| Azure Repos | Blocked: no authorized repository/PR/thread fixture or credential reference supplied. | Requester supplies org/project/repository IDs, existing PR/review-thread IDs, reader identity and any separately allowed fixture writes. | #6/#13/#16/#27 |
| Azure Pipelines | Blocked: no authorized pipeline/build/log fixture supplied. | Requester supplies success/failure build IDs, source commit/repository linkage, log access, cost ceiling and cleanup owner. | #6/#14/#16/#23/#24/#27 |
| Agent-account smoke | Blocked for live acceptance: installed Codex CLI is discoverable; no test-account identity, model-usage limit or second account/provider test allocation supplied. No model call was made in this run. | Requester designates existing agent profile/account per host and maximum allowed smoke usage. No credential acquisition or profile swapping. | #3/#4/#6/#7/#22/#27/#33 |

The pending access question in the implementation conversation asks for the
Windows/WSL machine and authorized Jira/Azure resources, owners and allowed actions.
Missing access gates only the corresponding live acceptance. Fixture tests and
independent implementation can continue; #6 still needs its merged #4 prerequisite.
Do not mark readiness complete while these rows are blocked.

## Build and handoff without production publication

Start from a fresh checkout of the selected fork commit. Follow LOCAL_DEVELOPMENT.md
for native prerequisites and install/uninstall instructions. Record `git rev-parse
HEAD`, `git status --short`, OS, architecture and tool versions with the artifact.

```sh
npm ci
npm run check
npm run build
# macOS unsigned/ad-hoc local release bundle; no release upload:
npm run tauri build -- --bundles app
```

Windows: use the documented MSVC/WebView2 prerequisites and `npm run build:windows`
from the intended native shell. Verify the displayed **MonoCode Fork** identity
and actual data path before testing. A Windows CI binary is not WSL evidence.

If a normal fork profile already exists, give this smoke a fresh test-only Tauri
identifier/product-name override before launch, as in PR #34; do not reset or
overwrite that existing profile. Keep overrides, logs, database and workload data
outside the repository. Share the exact override and artifact hash privately with
the tester; tokens or personal session databases are not test artifacts. Retain
data by default after quitting; only remove explicitly owned disposable fixtures.

On this Mac, the PR #34 bundle was retained at
`/Users/kacperkepinski/Developer/personal/monocode-worktrees/issue-3-baseline/target/release/bundle/macos/MonoCode Benchmark.app`,
with override `/tmp/monocode-3-isolated.conf.json` and test profile identifier
`com.kaceper11.monocode.benchmarkc42a59b1`. That PR is unmerged and is an evidence
reference, not an implementation dependency of this readiness document. Rebuild
from the selected commit rather than assuming temporary artifacts still exist.

Smoke: open a disposable repository, type an unsent draft, open/switch histories,
verify exact repository/path, quit and reopen, then inspect profile ownership and
unchanged stock data. Only run an authenticated agent after recording its allowed
profile/host and usage budget. Record a failure at the step where it occurs.

## Minimal service fixtures and read checks

Before any service call, record privately: owner, account reference, exact service
origin, organization/project/resource IDs, execution host, permitted reads,
separately approved writes, cost ceiling and cleanup owner. Limit checks to those
targets. A successful read does not confer write authority. Do not enumerate a
whole organization merely to find convenient fixtures.

| Service | Smallest fixture / read-only check | Required access reference |
| --- | --- | --- |
| Jira | Read one assigned issue and one custom-status issue with selected summary/status/assignee fields; include a colliding key in another authorized site/project later. `GET /rest/api/3/issue/{issueIdOrKey}`. | Issue Browse/issue-security access plus the documented endpoint scopes; use the existing approved connection. [Jira issue API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/). |
| Boards | Read an approved item ID and selected state/assignment fields. `GET .../_apis/wit/workitems/{id}?api-version=7.1`. | Work item read permission; endpoint scope `vso.work` where that auth mechanism applies. [Get work item](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-item?view=azure-devops-rest-7.1). |
| Repos | Read a named PR, exact source/target refs and commit, then approved review threads. `GET .../_apis/git/repositories/{repositoryId}/pullrequests/{pullRequestId}?api-version=7.1`. | Code read permission; endpoint scope `vso.code` where applicable. [Get PR](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1). |
| Pipelines | Read one known succeeded and one failed build, verify source commit and obtain only the named sanitized failure log. `GET .../_apis/build/builds/{buildId}?api-version=7.1`. | Build/log read permission; endpoint scope `vso.build` where applicable. [Get build](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/get?view=azure-devops-rest-7.1). |

Azure endpoint prefixes are the **chosen** `https://dev.azure.com/{organization}/{project}`;
the account/auth mechanism must be verified for that origin. These API references
were checked on 2026-09-08, but no Azure/Jira fixture request succeeded in this run.
Use an approved connector/client that obtains credentials from its existing local
credential mechanism; do not print Authorization headers, place tokens in URLs,
track secrets in config or ask the tester to paste tokens into an issue. Windows
service access and Linux Git/agent credentials must remain separately provisioned.
Local disconnect does not prove provider-side revocation.

No external fixture-changing action is approved here. Existing successful/failed
builds and review threads are preferred. If missing, obtain separate authority for
the exact test commit/PR/comment/build and its cleanup/costs; no subscription,
production resource change, automatic repair, release or merge is implied.

## Required mappings as connectors land

| Ticket source | Code / PRs | CI | Current acceptance |
| --- | --- | --- | --- |
| GitHub Issues | GitHub | Actions | CLI access only; in-app end-to-end flow unverified |
| GitHub Issues | Azure Repos | Azure Pipelines | Blocked on named Azure fixtures |
| Jira | Azure Repos | Azure Pipelines | Blocked on Jira connection and Azure fixtures |
| Jira | GitHub | Azure Pipelines | Blocked on Jira connection and Azure build-to-GitHub-commit mapping |
| Azure Boards | Azure Repos | Azure Pipelines | Blocked on all three designated fixture identities |

Repeat relevant cases with two authorized accounts on the same provider, colliding
short names/IDs, denied scopes, expiry and disconnect. Never choose issue tracker
from Git remote or CI from PR provider. Record each binding explicitly; one failed
connection must not silently substitute another account/host.

For WSL, have the designated tester run `wsl.exe --list --verbose`, then explicit
`--distribution <name> --exec` probes for `uname`, Linux user, Git and agent CLI in
both distributions. Use the exact Linux cwd; do not feed it to Windows Git. The
blocked experiment and complete lifecycle scenarios are in
[PR #35](https://github.com/kaceper11/monocode/pull/35). Its bounded local ownership
test is not production WSL or app-exit acceptance.

## Evidence record and completion gate

Keep one short record per boundary: tested full commit/artifact hash, timestamp,
platform/distro, account reference and target IDs, exact commands/interactions,
expected/actual result, sanitized screenshot/log link, limitation, owner and next
input. Record app/WebView and agent/build performance separately. Unknown is a
valid result; a screenshot or compilation alone is not functional verification.

This document was prepared from current main, the live issue/PR state and local
tool checks. Baseline full web/Rust checks and web build passed. No product code,
schema, credential store or release workflow changes are needed for readiness.
A second designated tester has not yet independently reproduced the handoff.
Keep #28 open/draft until the required live resources and separate platform checks
are verified; later features retain their own live acceptance gates.
