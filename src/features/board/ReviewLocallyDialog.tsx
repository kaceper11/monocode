import { useId, useMemo, useState } from "react";
import { Modal } from "../../shared/ui/Modal";
import { Checkbox } from "../../shared/ui/Checkbox";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import { GitPullRequest, LoaderCircle } from "../../shared/ui/icons";
import { projectName } from "../../shared/lib/paths";
import { sameProjectPath, type RecentProject } from "../projects/model/recents";
import type { InboxItem } from "../inbox/model/githubTasks";
import { linkedWorkItemFromInboxItem } from "../sessions/model/sessionWorkItem";
import type { LinkedWorkItem } from "../sessions/model/session";
import type { TaskWorkstreamSpec } from "./NewTaskDialog";
import { workstreamProjectOptions } from "./NewTaskDialog";
import {
  addTask,
  loadBoard,
  MAX_TASKS,
  newEntityId,
  placeColumnOrder,
} from "./boardStore";
import { prHeadRemoteRef } from "./taskOps";
import { createWorktree } from "../source-control/model/worktrees";
import { gitFetchBranch, gitRemotes } from "../../platform/tauri/fs";
import { LAYER } from "../../shared/lib/layers";

/** Providers that expose a fetchable PR head ref. */
const FETCHABLE = new Set(["github", "gitlab", "azuredevops"]);

/** Which local project hosts this PR's repo? The inbox item already knows
 * the project it was fetched from — fall back to a repo-name match only
 * when that's absent (e.g. a project removed from recents). */
export function defaultReviewProject(
  item: InboxItem,
  recents: RecentProject[] | readonly RecentProject[],
): string {
  if (item.projectPath) {
    const match = recents.find((entry) =>
      sameProjectPath(entry.path, item.projectPath),
    );
    if (match) return match.path;
  }
  const repoName = item.repo.split("/").filter(Boolean).pop() ?? "";
  const named = repoName
    ? recents.filter((entry) => projectName(entry.path) === repoName)
    : [];
  return named.length === 1 ? named[0].path : "";
}

/** Fetch a provider PR head into a `pr/<N>` branch, attach it to a new task
 * in Review, and optionally spawn an agent session primed for review. */
export function ReviewLocallyDialog({
  item,
  recents,
  reviewColumnIds,
  onSpawnSession,
  onSendToSession,
  onCreated,
  onClose,
}: {
  item: InboxItem;
  recents: readonly RecentProject[];
  /** Current card ids in the review column — the new task appends there. */
  reviewColumnIds: readonly string[];
  onSpawnSession: (
    spec: TaskWorkstreamSpec & {
      title: string;
      links: LinkedWorkItem[];
    },
  ) => Promise<{ sessionId: string; worktreePath: string }>;
  onSendToSession: (sessionId: string, text: string) => void;
  onCreated: (taskCardId: string) => void;
  onClose: () => void;
}) {
  const projects = useMemo(() => workstreamProjectOptions(recents), [recents]);
  const [projectPath, setProjectPath] = useState(() =>
    defaultReviewProject(item, recents),
  );
  const [spawnSession, setSpawnSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The submit button lives in the pinned footer, outside the form.
  const formId = useId();

  const supported = FETCHABLE.has(item.provider);

  const submit = async () => {
    if (!projectPath) return;
    setBusy(true);
    setError("");
    try {
      if (loadBoard().tasks.filter((task) => !task.archived).length >= MAX_TASKS)
        throw new Error("Board is full — archive some tasks first.");
      const remotes = await gitRemotes(projectPath);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!remote)
        throw new Error(
          `${projectName(projectPath)} has no git remote to fetch the PR from.`,
        );
      const branch = `pr/${item.number}`;
      // PR refs live on the base repo, so fork PRs resolve too; Azure
      // fetches the source branch (or the merge ref when it's unknown).
      await gitFetchBranch(
        projectPath,
        remote,
        prHeadRemoteRef(
          item.provider as "github" | "gitlab" | "azuredevops",
          item.number,
          item.sourceRefName,
        ),
        branch,
      );
      const base =
        item.targetRefName?.replace(/^refs\/heads\//, "") || "HEAD";
      // An empty item title would make addTask return null after the
      // worktree/session already exist — name a fallback up front.
      const title =
        `Review: ${item.title}`.trim() === "Review:"
          ? `Review PR #${item.number}`
          : `Review: ${item.title}`;
      const linked = linkedWorkItemFromInboxItem(item);
      const links = linked ? [linked] : [];
      let worktreePath: string;
      let sessionIds: string[] = [];
      if (spawnSession) {
        const spawned = await onSpawnSession({
          projectPath,
          branch,
          base,
          title,
          links,
        });
        worktreePath = spawned.worktreePath;
        sessionIds = [spawned.sessionId];
      } else {
        // The fetch just created the branch — adopt it, don't rebuild.
        worktreePath = (
          await createWorktree(projectPath, branch, base, true)
        ).path;
      }
      const taskId = addTask({
        title,
        links,
        workstreams: [
          {
            id: newEntityId("ws"),
            projectPath,
            branch,
            base,
            worktreePath,
            sessionIds,
            // Probes resolve the PR by url — `pr/<N>` never matches the
            // PR's real head branch name.
            prUrl: item.url,
          },
        ],
      });
      if (!taskId) throw new Error("Board is full — archive some tasks first.");
      // Land in Review — the card id is the task id verbatim.
      placeColumnOrder("review", [...reviewColumnIds, taskId]);
      if (sessionIds[0])
        onSendToSession(
          sessionIds[0],
          `Review PR ${item.url}: ${item.title}. The PR head is checked ` +
            `out on this branch — diff it against ${base} and look for ` +
            `correctness issues and bugs. Summarize findings.`,
        );
      onCreated(taskId);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : String(cause),
      );
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Review pull request locally"
      description={`Fetch ${item.identifier ?? `#${item.number}`} into a branch and open it as a review lane.`}
      // A mid-submit close would keep creating the worktree/task while the
      // dialog is gone — swallow close gestures until the submit settles.
      onClose={() => {
        if (!busy) onClose();
      }}
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="flex h-8 items-center rounded-md px-3 text-[12px] font-medium text-content/60 hover:bg-content/8 hover:text-content disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={busy || !projectPath || !supported}
            className="flex h-8 items-center gap-1.5 rounded-md bg-accent/20 px-3 text-[12px] font-medium text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            {busy ? (
              <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
            ) : null}
            Create review lane
          </button>
        </div>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3 px-4 pb-4 pt-1"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-1.5 rounded-md bg-content/4 px-2 py-1.5 text-[12px] text-content/75">
          <GitPullRequest
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
        </div>
        {!supported ? (
          <p className="text-[11.5px] text-amber-300">
            {item.provider} doesn't expose a fetchable PR ref — open it in the
            browser instead.
          </p>
        ) : null}
        <label className="flex flex-col gap-1 text-[12px] text-content/70">
          Project
          <SearchableSelect
            label="Project"
            value={projectPath}
            options={projects}
            placeholder="Pick the local repo…"
            searchPlaceholder="Search projects…"
            onChange={setProjectPath}
            disabled={busy}
            layer={LAYER.dialogPopover}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-content/70">
          <Checkbox
            label="Start an agent review session in the worktree"
            checked={spawnSession}
            disabled={busy}
            onChange={() => setSpawnSession((value) => !value)}
            className=""
          />
          Start an agent review session in the worktree
        </label>
        {error ? (
          <p role="alert" className="text-[11.5px] text-red-300">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
