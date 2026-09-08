# Ordered fork roadmap

The canonical backlog is [roadmap issue #1](https://github.com/kaceper11/monocode/issues/1). Read [the fork contract](FORK.md) and [agent instructions](../AGENTS.md) before implementation. Issues define outcomes and acceptance; implementing agents decide the smallest maintainable design after checking current source.

## Delivery priorities

Priority update (2026-09-08): deliver Windows UI with WSL-hosted Git/agents, Jira and Azure Boards tickets, Azure Repos PRs and Azure Pipelines CI first. One-shot and recurring scheduled tasks plus provider watchers follow before secondary UI expansion. GitHub remains supported but new GitHub enhancements must not block Jira/Azure delivery. A full durable daemon and terminal redesign are not prerequisites for the first usable WSL slice.

Issue numbers are stable; title prefixes show delivery order. Start with #2. Hard prerequisites below allow independent work once ready. A working WSL slice can land before UI-exit durability, using the existing terminal. Jira/Azure connectors can use existing views before grouping polish. Scheduled tasks can run while the app is open before background durability is accepted.

Start [#28: Windows/WSL and Jira/Azure acceptance readiness](https://github.com/kaceper11/monocode/issues/28) alongside #2. Its `[00]` prefix denotes a readiness lane, not a renumbering of the 26 feature steps. It owns test-machine/service access, safe fixture authority and reproducible handoff. Missing access blocks only the relevant live acceptance; fixtures and unrelated implementation can proceed. Readiness is not proof that a feature works.

See the [acceptance readiness matrix](ACCEPTANCE_READINESS.md) for verified resources, blocked boundaries, fixture authority and tester handoff.

## 01 - WSL-first foundations and core actions

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 01 | [#2: Isolate fork app identity, local data, and release/update configuration](https://github.com/kaceper11/monocode/issues/2) | None |
| 02 | [#3: Establish reproducible performance and compatibility baselines](https://github.com/kaceper11/monocode/issues/3) | [#2](https://github.com/kaceper11/monocode/issues/2) |
| 03 | [#4: Verify execution boundaries for WSL and durable background work](https://github.com/kaceper11/monocode/issues/4) | [#2](https://github.com/kaceper11/monocode/issues/2) |
| 04 | [#6: Make issue, Git, PR and CI bindings independent per project](https://github.com/kaceper11/monocode/issues/6) | [#2](https://github.com/kaceper11/monocode/issues/2), [#4](https://github.com/kaceper11/monocode/issues/4) |
| 05 | [#7: Make agent state and task ownership accurate and actionable](https://github.com/kaceper11/monocode/issues/7) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4) |
| 06 | [#22: Support Windows desktop with repositories, Git and agents inside WSL](https://github.com/kaceper11/monocode/issues/22) | [#4](https://github.com/kaceper11/monocode/issues/4), [#6](https://github.com/kaceper11/monocode/issues/6), [#7](https://github.com/kaceper11/monocode/issues/7) |
| 07 | [#8: Send selected context to an explicit agent without losing provenance](https://github.com/kaceper11/monocode/issues/8) | [#7](https://github.com/kaceper11/monocode/issues/7) |
| 08 | [#9: Add configurable Implement, Review, Test and custom actions](https://github.com/kaceper11/monocode/issues/9) | [#8](https://github.com/kaceper11/monocode/issues/8) |

## 02 - Jira and Azure DevOps delivery

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 09 | [#11: Add Jira issue sourcing independently of Git hosting and CI](https://github.com/kaceper11/monocode/issues/11) | [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 10 | [#12: Add Azure Boards work items as an independent issue source](https://github.com/kaceper11/monocode/issues/12) | [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 11 | [#13: Add Azure Repos pull requests, review threads and branch associations](https://github.com/kaceper11/monocode/issues/13) | [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 12 | [#14: Add Azure Pipelines CI independently of the PR provider](https://github.com/kaceper11/monocode/issues/14) | [#6](https://github.com/kaceper11/monocode/issues/6) |
| 13 | [#15: Unify local changes, staging and basic review feedback](https://github.com/kaceper11/monocode/issues/15) | [#8](https://github.com/kaceper11/monocode/issues/8) |
| 14 | [#16: Route review comments and failing CI to the owning agent](https://github.com/kaceper11/monocode/issues/16) | [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9), [#13](https://github.com/kaceper11/monocode/issues/13), [#14](https://github.com/kaceper11/monocode/issues/14), [#15](https://github.com/kaceper11/monocode/issues/15) |

## 03 - Scheduled automation and durability

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 15 | [#24: Add one-shot and recurring scheduled actions](https://github.com/kaceper11/monocode/issues/24) | [#9](https://github.com/kaceper11/monocode/issues/9) |
| 16 | [#23: Add PR, assigned-story and CI watchers with bounded actions](https://github.com/kaceper11/monocode/issues/23) | [#6](https://github.com/kaceper11/monocode/issues/6), [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9); each adapter additionally requires its connector; automatic repair requires [#16](https://github.com/kaceper11/monocode/issues/16) |
| 17 | [#21: Make agent execution durable across UI exit and reconnection](https://github.com/kaceper11/monocode/issues/21) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4), [#7](https://github.com/kaceper11/monocode/issues/7), [#22](https://github.com/kaceper11/monocode/issues/22) |

## 04 - Workspace depth and optional extensions

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 18 | [#5: Create a compact work hub with repository and issue groups](https://github.com/kaceper11/monocode/issues/5) | [#2](https://github.com/kaceper11/monocode/issues/2), [#3](https://github.com/kaceper11/monocode/issues/3) |
| 19 | [#10: Complete the GitHub issue-to-PR/checks workflow in the work hub](https://github.com/kaceper11/monocode/issues/10) | [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 20 | [#17: Add indexed conversation history search with reliable resume links](https://github.com/kaceper11/monocode/issues/17) | [#3](https://github.com/kaceper11/monocode/issues/3), [#7](https://github.com/kaceper11/monocode/issues/7) |
| 21 | [#18: Strengthen worktree terminals and explicit terminal-to-agent context](https://github.com/kaceper11/monocode/issues/18) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 22 | [#19: Add contextual browser/preview support and send-to-agent capture](https://github.com/kaceper11/monocode/issues/19) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 23 | [#20: Coordinate cross-repository tasks and shared context](https://github.com/kaceper11/monocode/issues/20) | [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9) |
| 24 | [#25: Expose a bounded local CLI/API for the same workspace actions](https://github.com/kaceper11/monocode/issues/25) | [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9), [#21](https://github.com/kaceper11/monocode/issues/21) |
| 25 | [#26: Evaluate optional SSH execution using the established host boundary](https://github.com/kaceper11/monocode/issues/26) (optional) | [#4](https://github.com/kaceper11/monocode/issues/4), [#18](https://github.com/kaceper11/monocode/issues/18), [#21](https://github.com/kaceper11/monocode/issues/21), [#22](https://github.com/kaceper11/monocode/issues/22) |

## 05 - Integrated acceptance and upstream maintenance

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 26 | [#27: Validate the integrated daily driver and rehearse upstream updates](https://github.com/kaceper11/monocode/issues/27) | [#2](https://github.com/kaceper11/monocode/issues/2), [#3](https://github.com/kaceper11/monocode/issues/3), [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#7](https://github.com/kaceper11/monocode/issues/7), [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9), [#10](https://github.com/kaceper11/monocode/issues/10), [#11](https://github.com/kaceper11/monocode/issues/11), [#12](https://github.com/kaceper11/monocode/issues/12), [#13](https://github.com/kaceper11/monocode/issues/13), [#14](https://github.com/kaceper11/monocode/issues/14), [#15](https://github.com/kaceper11/monocode/issues/15), [#16](https://github.com/kaceper11/monocode/issues/16), [#17](https://github.com/kaceper11/monocode/issues/17), [#18](https://github.com/kaceper11/monocode/issues/18), [#19](https://github.com/kaceper11/monocode/issues/19), [#20](https://github.com/kaceper11/monocode/issues/20), [#21](https://github.com/kaceper11/monocode/issues/21), [#22](https://github.com/kaceper11/monocode/issues/22), [#23](https://github.com/kaceper11/monocode/issues/23), [#24](https://github.com/kaceper11/monocode/issues/24), [#25](https://github.com/kaceper11/monocode/issues/25) |

## Acceptance and maintenance

Keep the independent provider matrix, performance requirements, source/licence guidance and upstream-merge practices in [FORK.md](FORK.md). Preserve existing GitHub/Linear capabilities while prioritizing Jira/Azure. No feature is accepted on mocks or a hosted build alone when live provider/WSL evidence is required. The final acceptance issue is a rolling checklist; useful slices can ship before the full roadmap. Optional SSH is excluded from the required gate.

Scheduled tasks must expose timezone/next run, pause/resume, run history, busy-target policy, bounded execution and missed-run behavior. Provider watchers and time-based schedules are distinct triggers sharing existing actions where practical. App-open execution must not be advertised as surviving exit until the durable runtime passes its checks.

## Readiness and shared ownership

- #2 owns isolated development build/install instructions; #3 verifies clean-checkout checks, CI and reproducible baseline artifacts with #28's environments. Production signing/publication is not required for tester handoff.
- #6 owns shared connection onboarding, read-only capability checks, account/credential lifecycle and explicit Windows/WSL credential ownership. Jira/Azure connectors reuse it and supply provider-specific scopes and behavior.
- #9 owns the minimal reusable action invocation identity, status, cancellation, authority and uncertain-delivery evidence. #24 adds time triggers; #23 adds provider-event triggers; #21 extends lifetime. Reuse existing dispatch/persistence instead of creating separate job systems.
- #22 first accepts existing local/stock capabilities on real WSL. Each later connector or feature extends that live boundary as it lands; unsupported capabilities stay explicit. Initial WSL acceptance does not wait for later review/search/terminal enhancements.
- #23 can deliver notification/draft behavior for an available source before all adapters exist. Required remaining adapter scenarios stay open; automatic repair needs #16 and explicit authority.
- #3 establishes and exercises the initial upstream checkpoint procedure without waiting for later features. #27 tracks the repeat after foundations and at each milestone, plus the final integrated rehearsal.
- #13 covers existing Azure PR inspection, association and context handoff. Branch push/draft-PR creation is not promised: document the manual delivery step until an explicit publication slice is approved.
- #19 captures a chosen browser page as an image and uses #8 to send it, with preview and optional instructions, to a fresh or existing agent session. Test actual image delivery and explicit platform fallbacks, including Windows-to-WSL attachments; do not silently drop images or substitute URLs.
- All issues follow the architecture guidance in AGENTS.md: clear ownership and testable boundaries, DRY for genuinely shared behavior, KISS implementations and YAGNI scope. Preserve required flexibility, safety and performance without speculative frameworks.

This index reflects the 2026-09-08 priority update. Keep issue dependencies and this index aligned when splitting or resequencing work. The issue bodies remain the detailed specification.
