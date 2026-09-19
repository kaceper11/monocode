# Azure DevOps

Connect one Azure DevOps Services organization/account in Settings. Boards, Repos and Pipelines use this connection, but selecting a ticket never selects a Git repository or CI source. Credentials remain in the app profile and are not copied into WSL.

The shared Inbox lists Boards work items, Repos pull requests and Pipeline runs. Its usual search, source filters, status, discussion, Ask and Send to agent controls are reused. Choose the local project explicitly when sending a ticket to an agent. Boards descriptions, comments and supported attachments are read-only.

Pull requests use the shared summary and code views. Checks show paginated policies and statuses. Discussion comments and replies are bound to the account, repository and displayed PR revision. Changes uses the normal PR status/create controls, with an explicit Azure account and Git remote destination. A changed destination or account fails instead of falling back to GitHub. Advanced review, merge and checkout actions remain available through the provider link; the removed custom PR workspace and automatic repair engine are not used.

Failed and partially successful pipeline runs use the same Inbox detail surface. Checks load jobs on demand; log reads are bounded and bound to the selected run revision, job, attempt and log ID. CI remains independent of the issue tracker and PR host, including Azure Pipelines for GitHub repositories. No rerun, cancellation or background watcher is scheduled by this integration.

Use a token with the capabilities needed for the chosen operations: Boards reads, repository reads and writes for PR creation/comments, and build reads for Pipelines. Missing permissions produce local errors. URLs and response identities are validated; unexpected account/repository changes require a refresh. Lists and media are bounded, so use the provider link for omitted content.

Authenticated Azure and live Windows/WSL acceptance must be recorded separately. Unit tests and macOS builds do not establish service permissions or Windows behavior.
