# Task domain model

How work is organized above repositories. The store is
`src/lib/taskWorkspaces.ts` (localStorage `monocode.taskWorkspaces.v1`);
sessions live in the Rust `session_store` and are referenced by id, never
embedded.

## Entities

- **Project** (`ProjectRecord`, `src/lib/projects.ts`) — grouping boundary.
  Owns `repositories`, saved sets, saved commands. A repository belongs to at
  most one project.
- **Repository** (`ProjectRepository`) — identity is the verified Git common
  dir, host-qualified (`//wsl.localhost/<distro>/…` never collapses with a
  native clone). `anchor` is only a re-probe path; `id` survives a Locate.
- **Task** (`TaskWorkspace`) — the user-facing unit of work: name, brief,
  linked tickets, `attempts`, `children`. Belongs to exactly one project.
- **Attempt** (`TaskAttempt`) — one candidate solution set. Every task has at
  least the primary attempt (`PRIMARY_ATTEMPT_ID`); `attempts[0]` is always
  primary. `status` records a `chosen`/`discarded` verdict; absent means
  still in play.
- **Checkout** (`TaskChild`) — "repository R's share of attempt A lives at
  path P on branch B." Carries `repositoryId` + `attemptId`, the working-copy
  binding (`workingCopy`), creation inputs (`baseRef`/`baseCommit`/`branch`),
  `mergeTarget`, `responsibility`, per-repo `sessionIds` and a `launch`
  lifecycle (`pending`/`working`/`ready`/`failed`).
- **Git worktree** — never a stored entity. It is filesystem state discovered
  through `git_repository_family` inventory and reconciled on refresh; a
  child's `workingCopy` is just a path binding that can go missing, move or
  become prunable.
- **Session** — first-class, referenced not owned. `session.cwd` equals one
  checkout's path; which list holds the id encodes scope — `task.sessionIds`
  for a conversation working across the whole task, `child.sessionIds` for a
  repo-scoped worker.

There is deliberately no **Workspace** entity: a task's workspace is derived
(the set of children's working copies), and `Workspace*` already names the
tab/pane layout (`WorkspaceTab`, `workspaceSnapshot`, `sessionWorkspaceLifecycle`).

## Invariants

- A repository appears at most once per attempt — uniqueness is keyed on
  `(attemptId, repositoryId)`, so the same repo can repeat across attempts
  but never inside one. Enforced on writes (`createTask`/`reviseTask`/
  `addTaskChildren`) and re-enforced on load: sanitize drops stored
  duplicate pairs, which the dangling-attempt remap can otherwise
  manufacture.
- Git forces each attempt to its own branch per repository, so
  `(repositoryId, branch)` is also unique across a task's children — a
  duplicate would fail worktree creation permanently. Branch suggestions
  dedupe against existing refs (`suggestTaskBranch`).
- All children of one task share one execution host — `taskHostConflict`
  rejects mixed native/WSL working copies.
- `taskOwnsCheckout(child)` (`branch`+`baseRef` recorded) marks checkouts the
  task created versus borrowed existing/main copies. Removal and cleanup
  offers must use it, never path heuristics. The rail's **Delete task…**
  opens a sheet (`TaskWorktreesSheet`) that lists exactly these owned copies
  with per-row checkboxes — borrowed copies are never listed — and offers
  **Delete task** (record only) or a reviewed batch removal through the same
  `git_worktree_safety` preflight/`git_worktree_remove` pipeline as the
  worktree manager (never force, never stopping processes). The task record
  is deleted either way, even when copies are skipped or fail — leftovers
  stay listed with a **Review** handoff into the manager's single-entry
  flow. The copy containing the active context is disabled. Sessions,
  conversations and branches always stay.
- `attempts[0]` is pinned to `PRIMARY_ATTEMPT_ID` on load, so the primary
  attempt's protection holds even for hand-edited records. It cannot be
  removed; mark it `discarded` via `setTaskAttemptStatus` instead.
  `removeTaskAttempt` drops the record and its children while sessions,
  working copies and branches stay — the same policy as `removeTaskChild`.
  Both refuse to remove a task's last checkout: a childless task record is
  dropped on load anyway, so removal must go through `removeTask`.

## Lookups under multiple attempts

When a lookup must pick one child, prefer the primary attempt:

- `childForRepository(task, repositoryId, attemptId?)` — repo → child,
  primary attempt by default. Used by repository-bound project commands.
- `preferredTaskChild(task, match)` — representative picks (session host,
  open target) prefer a primary-attempt match, then any match. Explicit user
  state (`lastActiveChildId`, an exact `cwd` match) still wins.
- `attemptForChild` / `taskAttemptLabel` resolve a child's attempt and its
  display label (`label` or "Attempt N").

`taskChildRepoLabel` and `composeTaskSessionPrompt` append the attempt label
only when the same repository is checked out under more than one attempt —
the sole case where it disambiguates. Single-attempt tasks, and attempts
that touch disjoint repositories, keep today's output.

## Extension points and non-goals

- Delivery attribution (Azure PR associations, CI sources, PR drafts keyed
  `taskId:childId`) keys on the checkout's `cwd`+`branch`+session — attempts
  need no schema change there: recorded branches are enforced distinct per
  repository and task-created worktrees get distinct paths. Two attempts can
  still bind the *same borrowed* `existing` copy (same path); session ids
  remain the disambiguator and `taskChildrenForWorkingCopy` reports both.
- "Add a repo mid-task" (`addTaskChildren`, `reviseTask`) targets a chosen
  attempt via the draft's `attemptId` (default primary); whether a new repo
  should materialize into every attempt is a product decision, not a model
  constraint.
- `reviseTask`'s `keepRepositoryIds` is repository-granular: deselecting a
  repository removes its checkout from *every* attempt. Dropping just one
  attempt's checkout is `removeTaskChild` — which the edit sheet does not
  expose while the sheet only shows the primary attempt's checkout per repo.
- An in-flight `git_worktree_create` can outlive child/attempt removal —
  the copy is created on disk and the final `updateTaskChild` no-ops. The
  copy stays discoverable through repository family inventory; nothing
  records it back onto the task.
- Removing a task-owned working copy through the manager or the delete
  sheet does not rewrite `child.workingCopy` — the binding dangles and
  relaunch surfaces the failure (a retained branch blocks `worktree add
  -b`). TaskDetails keeps the row visible with its launch error; record
  rewriting on external removal is out of scope by policy.
- Task records are frontend-localStorage today. Durable execution (#21) and
  schedules (#24) will need the backend to resolve task → checkout bindings;
  keep new fields flat and id-keyed so that move stays a row mapping.
- Which attempt a task-level session works on is intentionally unsettled —
  the session is rooted at a host checkout and the prompt lists every child;
  per-attempt session UX is a later slice, not hidden in this model.

## Discovery and details surfaces

- `taskMatchesQuery` is the one rail/search filter — name, ticket fields
  (identifier/title/url, including `additionalItems`), brief, repository
  display names, working copies, branches, merge targets, responsibilities
  and attempt labels, all from already-loaded records. The Tasks rail shows
  every live and archived match while filtering (the rail cap is suspended);
  the global ⌘K search exposes the same records as `task` hits under a Tasks
  scope. Selecting a task row never retints unrelated repository rows.
- **Task details** (`src/chrome/TaskDetails.tsx`, `OPEN_TASK_DETAILS` event)
  is a read-only rollup opened from the task row's menu, the scope chip and
  ⌘K results: deduped tickets (task ticket, `additionalItems` and
  session-linked work items), per-repository working copies with launch
  state and delivery badges, saved PR links (Azure associations, the cached
  GitHub branch PR, `taskPrs` drafts/results) and CI sources, and the task's
  conversations resolved against sidebar history. It renders saved/cached
  state only — no Git or provider fetch — and external links are opened
  after an http(s) check. Each prepared working-copy row carries a manage
  chevron that closes the sheet and opens the shared worktree modal focused
  on that copy (`OPEN_WORKTREE_MANAGER`); the same event backs the rail's
  per-worktree menu and the attention queue's pre-checked cleanup.

## Verification

`npx vitest run src/lib/taskWorkspaces.test.ts` covers attempt
creation/removal, primary-attempt protection, per-attempt repository
uniqueness, legacy-record backfill, dangling attempt ids, label
disambiguation and checkout ownership. Cross-attempt worktree creation on
real repositories reuses the existing worktree launch path; no separate
acceptance is claimed here.
