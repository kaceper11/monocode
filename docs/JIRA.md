# Jira tickets

Connect Jira Cloud in Settings with the site, account email and API token. Credentials stay in the app profile; no credentials are copied to an agent or WSL.

Jira uses the shared Inbox list, filters, search, ticket detail, discussion, supported image attachments, Ask and Send to agent controls. The Jira adapter translates identifiers, descriptions, states and comments into the same view contracts used by GitHub. Choose the local project explicitly for agent work; a Jira project does not determine its Git, PR or CI provider.

This connector reads tickets and comments. Write actions absent from the adapter are not offered; use Open in Jira for transitions, assignments and comments. Site/account identity remains attached to linked sessions and refresh requests. Errors preserve the current context and provide a retry path.

Confluence is separate context: select its pages through the composer context picker, review the bounded excerpt and send it with the chosen agent message. It does not introduce another task or workspace engine.

Live Jira/Confluence authentication, permissions and attachment behavior still require acceptance with authorized test accounts. Local fixtures do not establish those results.
