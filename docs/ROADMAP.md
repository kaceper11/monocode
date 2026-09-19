# Upstream convergence and retained integrations

The owner's 2026-09-18 direction replaces the previous expansion backlog. Existing GitHub issues remain historical context; this document does not close or change them. Read AGENTS.md and PRODUCT.md before implementation.

## Current work

1. Compare exact fork and upstream revisions and inventory every changed file. Preserve uncommitted work in other checkouts.
2. Remove fork-only features outside the retained scope and adopt upstream core UI, persistence and workflows. Review mixed files at hunk level and preserve old data safely.
3. Adapt Windows-to-WSL execution to upstream filesystem, process and worktree boundaries.
4. Integrate Azure Boards/Repos/Pipelines and Jira through upstream ticket, PR and CI surfaces and minimal shared contracts. Remove dependencies on custom tasks, repairs and automation engines.
5. Preserve Confluence and Devin/Muse/Copilot through upstream context and harness extension points. Missing optional capabilities are separate follow-up work, not reasons to expand the convergence.
6. Validate the remaining differences, upstream checks, compatibility fixtures and visible interactions. Record live provider/platform acceptance separately.

These steps describe intended work, not completed acceptance. WSL and existing service behavior must remain usable as their owning slices are integrated.

## Ongoing policy

Follow upstream for core features. Retire duplicate implementations when upstream supplies them. Keep provider choices independent and make unsupported operations explicit. Do not reinstate the old custom tasks/projects, action dispatchers, repairs, schedules/watchers or extensions-manager backlog. The browser side panel, Keep Awake, saved project commands without task scope, draft-only Actions prompts, terminal resource manager and dictation remain in scope. Features supplied by upstream remain available.

Keep the existing fork identity, session/credential isolation, licences and release safeguards. No roadmap item authorizes publication or external mutations.
