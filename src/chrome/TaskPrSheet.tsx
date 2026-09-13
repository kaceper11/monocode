import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  basename,
  gitPrBody,
  gitPrCheck,
  gitPrCreate,
  gitPrStatus,
  gitPrUpdate,
  gitPush,
  notifyGitChanged,
  subscribeGitChanged,
  type GitPrCheck,
} from "../lib/fs";
import { prettyCwd, wslLocation } from "../lib/paths";
import { githubStatus, type GithubStatus } from "../lib/githubTasks";
import {
  AZURE_CHANGE_EVENT,
  azureConnected,
  type AzureStatus,
} from "../lib/azure";
import { ciContext } from "../lib/azurePipelines";
import {
  azurePrCreate,
  azurePrUpdate,
  azurePrUrl,
  findAzurePrs,
  parseAzurePrLocation,
  readAzurePr,
  saveAzurePrAssociation,
  type AzurePrTarget,
} from "../lib/azureRepos";
import {
  resolvePrProviders,
  type DeliveryProvider,
} from "../lib/deliveryProviders";
import { generatePrContent } from "../lib/harness";
import type { Session } from "../lib/session";
import {
  isTaskPrCreating,
  listTaskPrDrafts,
  loadTaskPrDraft,
  markTaskPrCreating,
  prCommitBody,
  prRowBlocker,
  RELATED_PRS_MARKER,
  saveTaskPrDraft,
  subscribeTaskPrs,
  taskPrRowKey,
  taskPrsSnapshot,
  withRelatedPrs,
  type RelatedPr,
} from "../lib/taskPrs";
import {
  loadTaskWorkspaces,
  projectForTask,
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskWorkspacesSnapshot,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import { watchGithubPrUrl } from "../lib/watchers";
import { repositoryDisplayName } from "../lib/projects";
import { useProjectBranchesState } from "../hooks/useProjectBranches";
import { Modal } from "./Modal";
import { Select } from "./Select";
import {
  Check,
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  Loader,
  RefreshCw,
  WandSparkles,
} from "./icons";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type ExistingPr = {
  url: string;
  title: string;
  number?: number;
  /** The PR's actual target branch (short name). */
  base?: string;
  azureTarget?: AzurePrTarget;
};

type RowRuntime = {
  probing?: boolean;
  check?: GitPrCheck;
  checkError?: string;
  remotes?: { name: string; url: string }[];
  azureTarget?: Omit<AzurePrTarget, "accountId" | "number">;
  existing?: ExistingPr;
  /** Provider `existing` was looked up under — stale hints must not render
   * under a different effective provider while a re-probe is in flight. */
  existingProvider?: DeliveryProvider;
  /** Auto's source of truth: the provider detected from the remotes, never
   * the explicit override. Effective provider = `draft.provider ?? this`. */
  provider?: DeliveryProvider;
  step?: "checking" | "drafting" | "pushing" | "creating" | "linking";
  error?: string;
  generating?: boolean;
  /** This run wrote a related-PRs section into the PR's remote body. */
  linked?: boolean;
};

type RowInfo = {
  child: TaskChild;
  cwd?: string;
  repoName: string;
  wsl?: { distribution: string } | null;
};

const rowError = (runtime: RowRuntime | undefined) =>
  runtime?.error ?? runtime?.checkError;

export function TaskPrSheet({
  taskId,
  sessions,
  onClose,
}: {
  taskId: string;
  sessions: Session[];
  onClose: () => void;
}) {
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const draftsRaw = useSyncExternalStore(subscribeTaskPrs, taskPrsSnapshot);
  // One parse per store write — not one `loadTaskPrDraft` per row per render.
  const drafts = useMemo(
    () => listTaskPrDrafts(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftsRaw],
  );
  const draftFor = useCallback(
    (childId: string) => drafts[taskPrRowKey(taskId, childId)] ?? null,
    [drafts, taskId],
  );
  const liveTask = useMemo(
    () => loadTaskWorkspaces().find((task) => task.id === taskId),
    // Store re-read on every write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskId, tasksRaw],
  );
  // Rows stay usable if the task record is edited or deleted mid-sheet.
  const snapshot = useRef<TaskWorkspace | null>(null);
  if (liveTask) snapshot.current = liveTask;
  const task = liveTask ?? snapshot.current;

  const [runtime, setRuntime] = useState<Record<string, RowRuntime>>({});
  const [creatingAll, setCreatingAll] = useState(false);
  const [statusesReady, setStatusesReady] = useState(false);
  const [gh, setGh] = useState<GithubStatus | null>(null);
  const [azure, setAzure] = useState<AzureStatus | null>(null);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const relatedRunning = useRef(false);
  const relatedPending = useRef(false);
  const probeGen = useRef<Record<string, number>>({});
  const rowsRef = useRef<RowInfo[]>([]);

  useEffect(() => {
    let live = true;
    Promise.allSettled([githubStatus(), azureConnected()]).then(
      ([ghResult, azureResult]) => {
        if (!live) return;
        if (ghResult.status === "fulfilled") setGh(ghResult.value);
        if (azureResult.status === "fulfilled") setAzure(azureResult.value);
        setStatusesReady(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const rows = useMemo<RowInfo[]>(() => {
    if (!task) return [];
    const project = projectForTask(task);
    return task.children.map((child) => {
      const repo = repositoryForChild(task, child, project);
      return {
        child,
        cwd: child.workingCopy,
        repoName: repo
          ? repositoryDisplayName(repo)
          : child.workingCopy
            ? basename(child.workingCopy)
            : "Repository",
        wsl: child.workingCopy ? wslLocation(child.workingCopy) : null,
      };
    });
  }, [task]);
  rowsRef.current = rows;

  const patchRow = useCallback((childId: string, patch: Partial<RowRuntime>) => {
    setRuntime((previous) => ({
      ...previous,
      [childId]: { ...previous[childId], ...patch },
    }));
  }, []);

  const effectiveTarget = useCallback(
    (row: RowInfo) => {
      const draft = draftFor(row.child.id);
      return (
        draft?.target ||
        row.child.mergeTarget ||
        runtime[row.child.id]?.check?.defaultBranch ||
        "main"
      );
    },
    [draftFor, runtime],
  );

  const harnessFor = useCallback(
    (row: RowInfo) => {
      const session =
        sessions.find((entry) => row.child.sessionIds.includes(entry.id)) ??
        sessions.find((entry) => task?.sessionIds?.includes(entry.id));
      return session?.harness;
    },
    [sessions, task],
  );

  const azureTargetForRemotes = useCallback(
    (
      remotes: { name: string; url: string }[],
      upstreamRemote: string | undefined,
    ): Omit<AzurePrTarget, "accountId" | "number"> | undefined => {
      const ordered = [...remotes].sort((a, b) =>
        a.name === upstreamRemote ? -1 : b.name === upstreamRemote ? 1 : 0,
      );
      for (const remote of ordered) {
        try {
          const location = parseAzurePrLocation(remote.url);
          if (azure && location.site !== azure.site) continue;
          return location;
        } catch {
          /* not an Azure remote */
        }
      }
      return undefined;
    },
    [azure],
  );

  const probeRow = useCallback(
    async (
      row: RowInfo,
      target: string,
      allowRetarget = true,
      /** Local-only recheck: skip remote/provider network calls. */
      light = false,
    ) => {
      const cwd = row.cwd;
      const id = row.child.id;
      if (!cwd) return;
      // Later probes supersede earlier ones — never apply stale results.
      const generation = (probeGen.current[id] ?? 0) + 1;
      probeGen.current[id] = generation;
      const fresh = () => probeGen.current[id] === generation;
      patchRow(id, { probing: true, checkError: undefined });
      try {
        const check = await gitPrCheck(cwd, target);
        if (!fresh()) return;
        if (light) {
          patchRow(id, { probing: false, check });
          return;
        }
        const ctx = await ciContext(cwd).catch(() => null);
        if (!fresh()) return;
        const remotes = ctx?.remotes ?? [];
        const draft = loadTaskPrDraft(taskId, id);
        // `detected` is what "Auto" resolves to — kept in runtime even when
        // an explicit provider overrides it, so the Auto label shows the
        // real detection instead of echoing the pick.
        const { detected, effective: provider } = resolvePrProviders({
          remotes,
          upstream: check.upstream,
          remote: check.remote,
          override: draft?.provider,
        });
        // A local upstream names no remote — use the default remote when
        // locating the Azure project/repository pair.
        const upstreamRemote =
          check.upstream && check.upstream.includes("/")
            ? check.upstream.split("/")[0]
            : (check.remote ?? undefined);
        let azureTarget: RowRuntime["azureTarget"];
        let existing: ExistingPr | undefined;
        if (provider === "azure") {
          azureTarget = azureTargetForRemotes(remotes, upstreamRemote);
          if (azureTarget && azure?.accountId && check.branch) {
            try {
              const page = await findAzurePrs(
                { ...azureTarget, accountId: azure.accountId, number: 0 },
                check.branch,
                0,
              );
              const pr = page.items.find((item) => item.status === "active");
              if (pr) {
                const prTarget = { ...page.target, number: pr.pullRequestId };
                existing = {
                  url: azurePrUrl(prTarget),
                  title: pr.title,
                  number: pr.pullRequestId,
                  base: pr.targetRefName.replace(/^refs\/heads\//, ""),
                  azureTarget: prTarget,
                };
              }
            } catch (error) {
              if (fresh()) patchRow(id, { checkError: message(error) });
            }
          }
        } else if (
          provider === "github" &&
          check.branch &&
          gh?.authenticated === true
        ) {
          const pr = await gitPrStatus(cwd).catch(() => null);
          if (pr?.state === "open") {
            existing = {
              url: pr.url,
              title: pr.title,
              number: pr.number,
              base: pr.base,
            };
          }
        }
        if (!fresh()) return;
        patchRow(id, {
          probing: false,
          check,
          remotes,
          azureTarget,
          existing,
          existingProvider: provider,
          provider: detected,
        });
        // No explicit choice yet: aim the row at the repo's default branch.
        if (
          allowRetarget &&
          !draft?.target &&
          !row.child.mergeTarget &&
          check.defaultBranch &&
          target !== check.defaultBranch
        ) {
          saveTaskPrDraft(taskId, id, { target: check.defaultBranch });
          void probeRow(row, check.defaultBranch, false);
        }
      } catch (error) {
        if (fresh())
          patchRow(id, { probing: false, checkError: message(error) });
      }
    },
    [taskId, azure, gh, azureTargetForRemotes, patchRow],
  );

  // Probe every row once provider statuses are in; re-probe on git changes
  // to that checkout while the sheet is open. No polling.
  const probed = useRef(new Set<string>());
  useEffect(() => {
    if (!statusesReady || !task) return;
    // Bound the fan-out — each probe runs several git/provider calls.
    const pending = rows.filter((row) => {
      if (!row.cwd || probed.current.has(row.child.id)) return false;
      probed.current.add(row.child.id);
      return !draftFor(row.child.id)?.result;
    });
    void (async () => {
      for (let start = 0; start < pending.length; start += 3) {
        await Promise.allSettled(
          pending
            .slice(start, start + 3)
            .map((row) => probeRow(row, effectiveTarget(row))),
        );
      }
    })();
  }, [statusesReady, task, rows, probeRow, effectiveTarget, draftFor]);

  // Git changes only need the local check — remote/provider lookups stay on
  // open, explicit refresh, target and provider changes.
  useEffect(() => {
    if (!task) return;
    const unsubs = rows
      .filter((row) => row.cwd)
      .map((row) =>
        subscribeGitChanged(() => {
          if (
            isTaskPrCreating(taskId, row.child.id) ||
            draftFor(row.child.id)?.result
          )
            return;
          void probeRow(row, effectiveTarget(row), false, true);
        }, row.cwd),
      );
    return () => unsubs.forEach((unsub) => unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, rows, probeRow]);

  // A reconnect/disconnect while the sheet is open invalidates Azure probing.
  useEffect(() => {
    const onChange = () => {
      void azureConnected()
        .then((status) => {
          setAzure(status);
          for (const row of rowsRef.current) {
            if (!row.cwd || draftFor(row.child.id)?.result) continue;
            void probeRow(row, effectiveTarget(row));
          }
        })
        .catch(() => {});
    };
    window.addEventListener(AZURE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(AZURE_CHANGE_EVENT, onChange);
  }, [probeRow, effectiveTarget, draftFor]);

  /** Resolved PRs per row: created results plus open PRs found by probing. */
  const resolvedRows = useCallback(() => {
    return rows
      .map((row) => {
        const draft = loadTaskPrDraft(taskId, row.child.id);
        const rt = runtimeRef.current[row.child.id];
        if (draft?.result) {
          return {
            row,
            target: draft.target || effectiveTarget(row),
            url: draft.result.url,
            title: draft.result.title,
            provider: draft.result.provider,
            azureTarget: draft.result.azureTarget,
            persisted: true,
            hadSection: draft.body.includes(RELATED_PRS_MARKER),
            writable: true,
          };
        }
        const provider = draft?.provider ?? rt?.provider;
        if (rt?.existing?.url && rt.existingProvider === provider) {
          return {
            row,
            target: rt.existing.base || effectiveTarget(row),
            url: rt.existing.url,
            title: rt.existing.title,
            provider,
            azureTarget: rt.existing.azureTarget,
            persisted: false,
            hadSection: rt.linked === true,
            writable: Boolean(
              provider === "github" || rt.existing.azureTarget,
            ),
          };
        }
        return null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [rows, taskId, effectiveTarget]);

  /** After creates settle, cross-link same-target PRs via a managed section.
   * Overlapping calls queue one follow-up pass instead of being dropped. */
  const syncRelated = useCallback(async () => {
    if (relatedRunning.current) {
      relatedPending.current = true;
      return;
    }
    relatedRunning.current = true;
    try {
      do {
        relatedPending.current = false;
        const resolved = resolvedRows();
        for (const entry of resolved) {
          const siblings: RelatedPr[] = resolved
            .filter((other) => other !== entry && other.target === entry.target)
            .map((other) => ({
              repo: other.row.repoName,
              title: other.title,
              url: other.url,
            }));
          // No siblings → skip, unless a stale managed section needs stripping.
          if (!siblings.length && !entry.hadSection) continue;
          if (!entry.writable) continue;
          const { row, url } = entry;
          const cwd = row.cwd;
          if (!cwd) continue;
          patchRow(row.child.id, { step: "linking" });
          try {
            let next: string | undefined;
            if (entry.provider === "github") {
              const current = await gitPrBody(cwd, url).catch(() => undefined);
              if (current === undefined) continue;
              next = withRelatedPrs(current, siblings);
              if (next !== current) await gitPrUpdate(cwd, url, next);
            } else if (entry.azureTarget) {
              const read = await readAzurePr(entry.azureTarget).catch(
                () => undefined,
              );
              if (!read) continue;
              const current = read.pr.description ?? "";
              next = withRelatedPrs(current, siblings);
              if (next !== current)
                await azurePrUpdate(entry.azureTarget, next);
            }
            if (next === undefined) continue;
            // Only rows created through this sheet may persist the linked body —
            // writing a detected PR's body into its draft would send the old
            // description if that row is created later.
            if (entry.persisted)
              saveTaskPrDraft(taskId, row.child.id, { body: next });
            patchRow(row.child.id, {
              linked: next.includes(RELATED_PRS_MARKER),
            });
          } catch (error) {
            patchRow(row.child.id, {
              error: `Created, but related-links update failed: ${message(error)}`,
            });
          } finally {
            patchRow(row.child.id, { step: undefined });
          }
        }
      } while (relatedPending.current);
    } finally {
      relatedRunning.current = false;
    }
  }, [resolvedRows, patchRow, taskId]);

  const createRow = useCallback(
    async (row: RowInfo) => {
      const cwd = row.cwd;
      const id = row.child.id;
      if (!cwd || isTaskPrCreating(taskId, id)) return;
      markTaskPrCreating(taskId, id, true);
      patchRow(id, { error: undefined });
      try {
        const target = effectiveTarget(row);
        patchRow(id, { step: "checking" });
        const check = await gitPrCheck(cwd, target);
        patchRow(id, { check });
        const blocker = prRowBlocker(check, target);
        if (blocker) throw new Error(blocker);
        const draft = loadTaskPrDraft(taskId, id);
        const rt = runtimeRef.current[id];
        const provider = draft?.provider ?? rt?.provider;
        if (!provider) throw new Error("Choose a PR provider.");
        const branch = check.branch!;
        const title = (draft?.title || task?.name || "").trim();
        if (!title) throw new Error("Enter a pull request title.");
        let body = draft?.body.trim() ?? "";
        if (!body) {
          patchRow(id, { step: "drafting" });
          body =
            (
              await generatePrContent(cwd, harnessFor(row), target).catch(
                () => null,
              )
            )?.body?.trim() || prCommitBody(check.commits);
        }
        if (!check.published || check.aheadOfRemote > 0) {
          patchRow(id, { step: "pushing" });
          await gitPush(cwd);
        }
        patchRow(id, { step: "creating" });
        const isDraft = draft?.draft === true;
        if (provider === "github") {
          const url = await gitPrCreate(cwd, title, body, target, branch, isDraft);
          watchGithubPrUrl(
            cwd,
            url,
            task?.sessionIds?.[0] ?? row.child.sessionIds[0],
          );
          saveTaskPrDraft(taskId, id, {
            target,
            title,
            body,
            result: {
              provider,
              url,
              title,
              number: Number(url.match(/\/pull\/(\d+)/)?.[1]) || undefined,
            },
          });
        } else {
          const rt2 = runtimeRef.current[id];
          const location =
            rt2?.azureTarget ??
            azureTargetForRemotes(
              rt2?.remotes ?? [],
              check.upstream?.split("/")[0] ?? check.remote ?? undefined,
            );
          if (!location || !azure?.accountId)
            throw new Error(
              azure?.connected
                ? "This repository's Azure remote belongs to a different organization."
                : "Connect Azure DevOps in Settings.",
            );
          const created = await azurePrCreate(
            { ...location, accountId: azure.accountId, number: 0 },
            branch,
            target,
            title,
            body,
            isDraft,
          );
          // Link the PR to every session that shares this working copy.
          const sessionIds = [
            ...(task?.sessionIds ?? []),
            ...row.child.sessionIds,
          ].slice(0, 20);
          for (const sessionId of sessionIds) {
            saveAzurePrAssociation(
              {
                target: created.target,
                pr: created.pr,
                revision: created.revision,
                account: created.account,
                projectName: created.projectName,
                repositoryName: created.repositoryName,
                cwd,
                branch,
                sourceSessionId: sessionId,
              },
              cwd,
              branch,
              sessionId,
            );
          }
          saveTaskPrDraft(taskId, id, {
            target,
            title,
            body,
            result: {
              provider,
              url: azurePrUrl(created.target),
              title: created.pr.title,
              number: created.target.number,
              existing: created.existing,
              azureTarget: created.target,
            },
          });
        }
        patchRow(id, { step: undefined });
        notifyGitChanged(cwd);
      } catch (error) {
        patchRow(id, { step: undefined, error: message(error) });
      } finally {
        markTaskPrCreating(taskId, id, false);
      }
    },
    [
      taskId,
      task,
      effectiveTarget,
      harnessFor,
      azure,
      azureTargetForRemotes,
      patchRow,
    ],
  );

  /** Rows that can create a PR right now — shared by the button and the
   * footer count so "Create N" never overpromises. */
  const rowEligible = useCallback(
    (row: RowInfo) => {
      const draft = draftFor(row.child.id);
      const rt = runtimeRef.current[row.child.id];
      if (!row.cwd || !rt?.check || draft?.result) return false;
      if (isTaskPrCreating(taskId, row.child.id)) return false;
      const provider = draft?.provider ?? rt.provider;
      if (!provider) return false;
      const target = effectiveTarget(row);
      // Azure allows a single active PR per source branch — any existing one
      // blocks. GitHub blocks only a same-target duplicate. Only an `existing`
      // probed under this provider counts.
      if (
        rt.existing &&
        rt.existingProvider === provider &&
        (provider === "azure" || rt.existing.base === target)
      )
        return false;
      return prRowBlocker(rt.check, target) === null;
    },
    [taskId, draftFor, effectiveTarget],
  );

  const createAll = useCallback(async () => {
    if (creatingAll) return;
    setCreatingAll(true);
    try {
      const eligible = rows.filter(rowEligible);
      for (let start = 0; start < eligible.length; start += 2) {
        await Promise.all(
          eligible.slice(start, start + 2).map((row) => createRow(row)),
        );
      }
      await syncRelated();
    } finally {
      setCreatingAll(false);
    }
  }, [creatingAll, rows, createRow, syncRelated, rowEligible]);

  if (!task) return null;

  const readyCount = rows.filter(rowEligible).length;

  return (
    <Modal
      onClose={onClose}
      title={`Pull requests — ${task.name}`}
      description={`${rows.length} ${rows.length === 1 ? "repository" : "repositories"} in this task`}
      size="lg"
      className="max-h-[80vh]"
    >
      <div className="flex flex-col gap-2 px-4 pb-3">
        {rows.map((row) => (
          <TaskPrRow
            key={row.child.id}
            task={task}
            row={row}
            runtime={runtime[row.child.id]}
            draft={draftFor(row.child.id)}
            creating={isTaskPrCreating(taskId, row.child.id) || creatingAll}
            ghReady={gh?.authenticated === true}
            azureReady={azure?.connected === true}
            onTarget={(target) => {
              saveTaskPrDraft(taskId, row.child.id, { target });
              void probeRow(row, target, false);
            }}
            onProvider={(provider) => {
              saveTaskPrDraft(taskId, row.child.id, {
                provider:
                  provider === "github" || provider === "azure"
                    ? provider
                    : null,
              });
              void probeRow(row, effectiveTarget(row), false);
            }}
            onTitle={(title) =>
              saveTaskPrDraft(taskId, row.child.id, { title })
            }
            onBody={(body) => saveTaskPrDraft(taskId, row.child.id, { body })}
            onDraft={(draft) =>
              saveTaskPrDraft(taskId, row.child.id, { draft })
            }
            onRefresh={() => void probeRow(row, effectiveTarget(row), false)}
            onGenerate={async () => {
              const id = row.child.id;
              patchRow(id, { generating: true, error: undefined });
              try {
                const target = effectiveTarget(row);
                const content = await generatePrContent(
                  row.cwd!,
                  harnessFor(row),
                  target,
                );
                if (content?.body) {
                  saveTaskPrDraft(taskId, id, { body: content.body });
                }
              } catch (error) {
                patchRow(id, { error: message(error) });
              } finally {
                patchRow(id, { generating: false });
              }
            }}
            onCreate={async () => {
              await createRow(row);
              void syncRelated();
            }}
          />
        ))}
        {rows.length === 0 ? (
          <p className="px-1 py-4 text-[12px] text-content/50">
            This task has no repositories yet.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-content/10 px-4 py-3">
        <button
          type="button"
          disabled={creatingAll}
          onClick={() => {
            probed.current.clear();
            for (const row of rows)
              if (row.cwd) void probeRow(row, effectiveTarget(row));
          }}
          className="flex items-center gap-1.5 rounded-md border border-content/10 px-2.5 py-1.5 text-[12px] text-content/70 hover:bg-content/5 disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
          Refresh
        </button>
        <div className="min-w-0 flex-1" />
        <button
          type="button"
          disabled={creatingAll || readyCount === 0}
          onClick={() => void createAll()}
          className="rounded-md bg-content/10 px-3 py-1.5 text-[12px] font-medium text-content hover:bg-content/15 disabled:opacity-40"
        >
          {creatingAll
            ? "Creating…"
            : `Create ${readyCount || ""} pull request${readyCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </Modal>
  );
}

function TaskPrRow({
  task,
  row,
  runtime,
  draft,
  creating,
  ghReady,
  azureReady,
  onTarget,
  onProvider,
  onTitle,
  onBody,
  onDraft,
  onRefresh,
  onGenerate,
  onCreate,
}: {
  task: TaskWorkspace;
  row: RowInfo;
  runtime?: RowRuntime;
  draft: ReturnType<typeof loadTaskPrDraft>;
  creating: boolean;
  ghReady: boolean;
  azureReady: boolean;
  onTarget: (target: string) => void;
  onProvider: (provider: string) => void;
  onTitle: (title: string) => void;
  onBody: (body: string) => void;
  onDraft: (draft: boolean) => void;
  onRefresh: () => void;
  onGenerate: () => void;
  onCreate: () => void;
}) {
  const cwd = row.cwd;
  const branches = useProjectBranchesState(cwd ?? "", Boolean(cwd));
  const check = runtime?.check;
  const target =
    draft?.target || row.child.mergeTarget || check?.defaultBranch || "main";
  const title = draft?.title || task.name;
  const body = draft?.body ?? "";
  const isDraft = draft?.draft === true;
  const blocker = check ? prRowBlocker(check, target) : null;
  const error = rowError(runtime);
  const result = draft?.result;
  const effectiveProvider = draft?.provider ?? runtime?.provider;
  // Only trust `existing` probed under the current effective provider — a
  // GitHub PR found earlier is not evidence while Azure is selected.
  const existing =
    runtime?.existing && runtime.existingProvider === effectiveProvider
      ? runtime.existing
      : undefined;
  const existingSameTarget =
    existing && existing.base === target ? existing : undefined;
  // Azure allows a single active PR per source branch — any open PR blocks.
  const existingBlocks = Boolean(
    existing && (effectiveProvider === "azure" || existing.base === target),
  );
  const existingBlocker =
    existing && !existingSameTarget && effectiveProvider === "azure"
      ? `PR ${existing.number ? `#${existing.number} ` : ""}already open — Azure allows one per branch`
      : undefined;
  const branchOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of branches.branches?.branches ?? []) {
      if (entry.name === check?.branch) continue;
      if (!names.has(entry.name)) names.set(entry.name, entry.name);
    }
    if (!names.has(target)) names.set(target, target);
    return [...names.entries()].map(([value, label]) => ({ value, label }));
  }, [branches.branches, check?.branch, target]);
  const providerOptions = useMemo(
    () => [
      {
        value: "auto",
        label: runtime?.provider
          ? `Auto (${runtime.provider === "github" ? "GitHub" : "Azure"})`
          : "Auto",
      },
      { value: "github", label: "GitHub" },
      { value: "azure", label: "Azure Repos" },
    ],
    [runtime?.provider],
  );

  const stepLabel =
    runtime?.step === "checking"
      ? "Checking…"
      : runtime?.step === "drafting"
        ? "Drafting description…"
        : runtime?.step === "pushing"
          ? "Pushing…"
          : runtime?.step === "creating"
            ? "Creating pull request…"
            : runtime?.step === "linking"
              ? "Linking related PRs…"
              : undefined;

  return (
    <section className="rounded-lg border border-content/10 p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <GitPullRequest
          className="size-3.5 shrink-0 text-content/40"
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-content">
          {row.repoName}
        </span>
        {row.wsl ? (
          <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/55">
            WSL · {row.wsl.distribution}
          </span>
        ) : null}
        {runtime?.probing ? (
          <Loader className="size-3.5 shrink-0 animate-spin text-content/40" />
        ) : (
          <button
            type="button"
            title="Refresh this repository"
            onClick={onRefresh}
            className="shrink-0 rounded p-1 text-content/40 hover:bg-content/8 hover:text-content"
          >
            <RefreshCw className="size-3" strokeWidth={1.75} />
          </button>
        )}
      </div>
      {!cwd ? (
        <p className="text-[11px] text-content/45">
          No working copy prepared for this repository.
        </p>
      ) : (
        <>
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-content/60">
            <span className="truncate font-mono" title={prettyCwd(cwd)}>
              {check
                ? (check.branch ?? "detached HEAD")
                : (row.child.branch ?? "…")}
            </span>
            <span className="text-content/35">→</span>
            <Select
              label="Target branch"
              value={target}
              options={branchOptions}
              disabled={creating || Boolean(result)}
              onChange={onTarget}
            />
            <Select
              label="Provider"
              value={draft?.provider ?? "auto"}
              options={providerOptions}
              disabled={creating || Boolean(result)}
              onChange={onProvider}
            />
            <label className="flex items-center gap-1.5 text-content/60">
              <input
                type="checkbox"
                checked={isDraft}
                disabled={creating || Boolean(result)}
                onChange={(event) => onDraft(event.target.checked)}
                className="size-3.5 accent-current"
              />
              Draft
            </label>
          </div>
          <input
            type="text"
            value={title}
            disabled={creating || Boolean(result)}
            onChange={(event) => onTitle(event.target.value)}
            placeholder="Pull request title"
            aria-label={`Title for ${row.repoName}`}
            className="mb-1.5 w-full rounded-md border border-content/10 bg-content/5 px-2 py-1.5 text-[12px] text-content outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          />
          <textarea
            value={body}
            disabled={creating || Boolean(result)}
            onChange={(event) => onBody(event.target.value)}
            placeholder="Description — generated when left empty"
            aria-label={`Description for ${row.repoName}`}
            rows={2}
            className="mb-1.5 w-full resize-y rounded-md border border-content/10 bg-content/5 px-2 py-1.5 text-[12px] text-content outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          />
          <div className="flex min-h-5 items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[11px]">
              {result && !error ? (
                <button
                  type="button"
                  onClick={() => void openUrl(result.url)}
                  className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
                >
                  <Check className="size-3" strokeWidth={2} />
                  {result.number ? `PR #${result.number}` : "PR"}{" "}
                  {result.existing ? "already open" : "created"}
                  <ExternalLink className="size-3" strokeWidth={1.75} />
                </button>
              ) : error ? (
                <span className="flex items-center gap-1 text-red-400/90">
                  <CircleAlert className="size-3 shrink-0" strokeWidth={1.75} />
                  <span className="truncate" title={error}>
                    {error}
                  </span>
                </span>
              ) : existingSameTarget ? (
                <button
                  type="button"
                  onClick={() => void openUrl(existingSameTarget.url)}
                  className="inline-flex items-center gap-1 text-content/60 hover:underline"
                >
                  Open PR{" "}
                  {existingSameTarget.number
                    ? `#${existingSameTarget.number}`
                    : ""}{" "}
                  already targets {target}
                  <ExternalLink className="size-3" strokeWidth={1.75} />
                </button>
              ) : existingBlocker ? (
                <button
                  type="button"
                  onClick={() => void openUrl(existing?.url ?? "")}
                  className="flex items-center gap-1 text-amber-300/80 hover:underline"
                  title={existingBlocker}
                >
                  <span className="truncate">{existingBlocker}</span>
                  <ExternalLink className="size-3 shrink-0" strokeWidth={1.75} />
                </button>
              ) : stepLabel ? (
                <span className="flex items-center gap-1.5 text-content/60">
                  <Loader className="size-3 animate-spin" />
                  {stepLabel}
                </span>
              ) : blocker ? (
                <span className="text-amber-300/80" title={blocker}>
                  {blocker}
                </span>
              ) : runtime?.probing ? (
                <span className="text-content/40">Checking…</span>
              ) : check ? (
                <span className="text-content/45">
                  {check.ahead} ahead · {check.behind} behind
                  {!check.published ? " · not pushed" : ""}
                  {existing
                    ? ` · open PR to ${existing.base ?? "another target"}`
                    : ""}
                </span>
              ) : null}
            </div>
            {!result && !existingBlocks ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  title="Generate description"
                  disabled={creating || runtime?.generating || !check?.branch}
                  onClick={onGenerate}
                  className="rounded p-1 text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
                >
                  {runtime?.generating ? (
                    <Loader className="size-3.5 animate-spin" />
                  ) : (
                    <WandSparkles className="size-3.5" strokeWidth={1.75} />
                  )}
                </button>
                <button
                  type="button"
                  disabled={
                    creating ||
                    Boolean(blocker) ||
                    existingBlocks ||
                    !check ||
                    runtime?.probing ||
                    (effectiveProvider === "github" && !ghReady) ||
                    (effectiveProvider === "azure" && !azureReady)
                  }
                  onClick={onCreate}
                  className="rounded-md border border-content/12 bg-content/8 px-2.5 py-1 text-[11px] font-medium text-content/75 hover:bg-content/12 hover:text-content disabled:opacity-35"
                >
                  {error ? "Retry" : "Create PR"}
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
