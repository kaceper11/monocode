# MonoCode fork scope

This repository follows [upstream MonoCode](https://github.com/hardbeat920/monocode). Upstream owns the core application, visual language, workflows and architecture. The fork adds a small integration layer, preserving the MIT licence, notices and full Git history.

## Retained integrations

- Windows UI with repositories, Git, terminals and agents running inside WSL.
- Azure Boards tickets, Azure Repos pull requests and Azure Pipelines CI.
- Jira tickets and Confluence context.
- Devin, Muse and GitHub Copilot through upstream's harness registry.
- Browser side panel, Keep Awake, saved project commands without task scope, draft-only Actions prompts, terminal resource manager and dictation.

Keep upstream features and providers. Prefer upstream implementations when capabilities overlap. Remove fork-only features outside this list except changes required for data compatibility, security or installation isolation. This direction supersedes the earlier broad fork-expansion roadmap; it does not assert that convergence is already complete.

## Shared provider workflows

Use upstream GitHub's components and interaction patterns for corresponding Azure and Jira capabilities. Reuse upstream contracts first; add the smallest ticket, pull-request or CI interface justified by actual adapters. Keep API calls, authentication, identifiers, pagination and status translation provider-specific. Unsupported capabilities must be visible; do not pretend services are identical or reduce GitHub functionality to match a smaller provider.

Ticket source, Git remote, PR source, CI source, account and execution host remain independent choices. Support Jira with Azure Repos/Pipelines, GitHub issues with Azure Repos/Pipelines, and GitHub PRs with Azure Pipelines. Do not infer these mappings from one another. Bind consequential operations and displayed evidence to the selected account, host, repository and revision.

Future upstream GitHub improvements should require bounded adapter changes. Do not duplicate screens, freeze upstream interfaces behind wrappers, or build a universal integration framework. Retain upstream Linear and GitLab behavior.

## WSL and agent boundaries

Keep host and guest identities explicit. Run Linux Git and agents on the selected distribution; never reinterpret Linux paths as host paths or copy credentials across hosts. Preserve cancellation, approvals, session recovery and attachments. Integrate at existing process/filesystem boundaries and adapt to upstream worktree lifecycle rather than retaining a parallel workspace engine.

Agent adapters retain their actual provider semantics. Unsupported operations and unknown state remain explicit. Shared changes must preserve upstream harnesses as well as the retained agents.

## Compatibility and maintenance

Use focused branches and review fork differences file by file, including individual hunks in mixed files. Every remaining difference needs a retained-scope or safety reason. Recheck upstream before adding functionality. Minimize touched upstream files and divergence; future conflict-free merges cannot be guaranteed.

Preserve the distinct fork application/data identity and release safeguards. Never overwrite another installation's sessions or credentials. Removing UI does not authorize deleting stored records, downloaded assets, repositories or worktrees. Any necessary migration must be recoverable and covered by old-data checks.

Run relevant upstream checks, regression tests and visible-interaction checks. Report performance evidence and limitations honestly. Local tests and macOS builds do not establish live Windows/WSL or authenticated service acceptance. Disabled integrations must not create recurring background work.

`origin` is `kaceper11/monocode`; `upstream` is `hardbeat920/monocode`. Use `gh ... -R kaceper11/monocode`. Publication, commits, pushes, PRs, releases and external service writes require the authority given in the active task. Respect upstream CONTRIBUTING.md for upstream submissions.
