import { useInboxContext } from "./InboxContextPicker";
import { InboxDetailShell } from "./InboxDetailShell";
import { ACTION_OUTLINE, ACTION_GHOST } from "./inboxActions";
import { GitCompare, LoaderCircle, ExternalLink, Zap } from "./icons";
import {
  InboxComments,
  InboxCommentForm,
  type InboxComment,
  type InboxReplyTarget,
  type InboxThread,
} from "../surfaces/InboxComments";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";
import type { SessionSummary } from "../lib/sessionStore";
import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { azureConnected } from "../lib/azure";
import {
  azurePrSubmitReview,
  azurePrThreadComment,
  findAzurePrs,
  loadAzurePrAssociation,
  readAzurePr,
  readAzurePrSection,
  saveAzurePrAssociation,
  type AzurePrTarget,
  type AzurePrThread,
} from "../lib/azureRepos";
import { unresolvedThread } from "../lib/repair";
import {
  ciContext,
  ciLookup,
  loadCiSources,
  saveCiSources,
  parsePipelineUrl,
  type CiTarget,
} from "../lib/azurePipelines";
import { saveDeliveryProvider } from "../lib/deliveryProviders";
import { openWatchSheet } from "../lib/watchers";
import type { AttentionItem } from "../lib/attention";
import type { InboxMyWork } from "../lib/inboxMyWork";
import type { InboxItem, InboxComposerCard } from "../lib/githubTasks";
import { formatRelativeTime } from "../lib/githubTasks";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { CwdPicker } from "./CwdPicker";
import { AzurePrReview } from "./AzurePrReview";
import { AzureCiReview } from "./AzureCiReview";

const button =
  "rounded-md px-2 py-1.5 text-[12px] text-content/70 hover:bg-content/10 disabled:opacity-40";

function message(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function attempt<T>(load: Promise<T>) {
  try {
    return { value: await load, error: "" };
  } catch (error) {
    return { value: null, error: message(error) };
  }
}

/** Map one Azure PR thread onto the shared inbox comment row — the first
 * non-deleted comment becomes the parent, the rest its replies. Thread id
 * and resolution state survive so Reply stays revision-safe. */
function toInboxComment(thread: AzurePrThread): InboxComment | null {
  const comments = thread.comments
    .filter((comment) => !comment.isDeleted && (comment.content ?? "").trim())
    .slice(0, 50);
  if (!comments.length) return null;
  const file = thread.threadContext;
  const shared = {
    kind: file ? "review_comment" : "comment",
    url: "",
    state: "",
    path: file?.filePath ?? "",
    line: file?.rightFileStart?.line ?? null,
    resolved: !unresolvedThread(thread),
    threadId: String(thread.id),
  };
  const map = (comment: AzurePrThread["comments"][number]): InboxComment => ({
    ...shared,
    id: `${thread.id}:${comment.id}`,
    author: comment.author?.displayName ?? "Unknown",
    body: (comment.content ?? "").slice(0, 32_000),
    createdAt: comment.publishedDate ?? "",
    replies: [],
  });
  const [first, ...rest] = comments;
  return { ...map(first), replies: rest.map(map) };
}

/** Delivery uses its existing review surface, never the Boards item-content endpoint. */
export function AzureInboxDetail({
  item,
  cwd,
  projects,
  relatedSessions = [],
  myWork,
  viewingSessionId,
  onOpenSession,
  onOpenDelivery,
  onAttentionAction,
  onDiscuss,
}: {
  item: InboxItem;
  cwd: string;
  projects: { path: string; name: string }[];
  relatedSessions?: readonly SessionSummary[];
  myWork?: InboxMyWork;
  viewingSessionId?: string;
  onOpenSession?: (id: string) => void | Promise<void>;
  onOpenDelivery?: (
    sessionId: string,
    kind: "pr" | "ci",
    current: () => boolean,
    provider: "github" | "azure" | "gitlab",
    prUrl?: string,
    gitlabTarget?: { repo: string; number: number },
  ) => Promise<void>;
  onAttentionAction?: (item: AttentionItem) => void | Promise<void>;
  onDiscuss?: (card: InboxComposerCard) => void | Promise<void>;
}) {
  const delivery = item.delivery!;
  const isPr = delivery.kind === "pr";
  const context = useInboxContext(item);
  const [folder, setFolder] = useState(item.projectPath || cwd);
  const [ready, setReady] = useState<{
    cwd: string;
    branch: string;
    inboxTarget?: CiTarget;
    ciRemote?: string;
    ciDefinitionName?: string;
  }>();
  const [remotes, setRemotes] = useState<{ name: string; url: string }[]>([]);
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"summary" | "code">("summary");
  const [revision, setRevision] = useState("");
  const [description, setDescription] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [threadData, setThreadData] = useState<InboxThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [stories, setStories] = useState<string[] | undefined>();
  const [storiesError, setStoriesError] = useState("");
  const [replyTo, setReplyTo] = useState<InboxReplyTarget | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const detailLock = useLockOverscroll<HTMLDivElement>();
  const generation = useRef(0),
    pending = useRef(false),
    summaryGen = useRef(0),
    /** Code tab auto-opens the review once per folder — a failed bind shows
     * the picker instead of retry-looping. */
    autoOpened = useRef("");
  useEffect(
    () => () => {
      generation.current++;
      summaryGen.current++;
    },
    [],
  );

  const prTarget: AzurePrTarget = {
    site: item.site ?? "",
    accountId: delivery.accountId,
    project: delivery.project,
    repository: delivery.repository,
    number: item.number,
  };

  const renderThreads = (page: {
    items: AzurePrThread[];
    nextSkip: number | null;
  }) =>
    setThreadData({
      comments: page.items
        .map(toInboxComment)
        .filter((comment): comment is InboxComment => comment != null),
      truncated: page.nextSkip != null,
    });

  const loadSummary = async () => {
    const id = ++summaryGen.current;
    const current = () => id === summaryGen.current;
    setSummaryLoading(true);
    setThreadLoading(true);
    setDetailsError("");
    setThreadError("");
    setStoriesError("");
    try {
      const fresh = await readAzurePr(prTarget);
      if (!current()) return;
      setRevision(fresh.revision);
      setDescription(fresh.pr.description ?? "");
      const [threads, workitems] = await Promise.all([
        attempt(
          readAzurePrSection<AzurePrThread>(prTarget, fresh.revision, "threads"),
        ),
        attempt(
          readAzurePrSection<{ id: string }>(
            prTarget,
            fresh.revision,
            "workitems",
          ),
        ),
      ]);
      if (!current()) return;
      if (threads.value) renderThreads(threads.value);
      else setThreadError(threads.error);
      if (workitems.value)
        setStories(
          workitems.value.items
            .map((value) => value.id)
            .filter((value) => /^\d+$/.test(value))
            .slice(0, 50),
        );
      else setStoriesError(workitems.error);
    } catch (loadError) {
      if (current()) setDetailsError(message(loadError));
    } finally {
      if (current()) {
        setSummaryLoading(false);
        setThreadLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!isPr) return;
    void loadSummary();
    // Identity-keyed remount — loadSummary is stable for this item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  const refreshThreads = async () => {
    if (!revision) return;
    setThreadLoading(true);
    setThreadError("");
    try {
      renderThreads(
        await readAzurePrSection<AzurePrThread>(prTarget, revision, "threads"),
      );
    } catch (loadError) {
      setThreadError(message(loadError));
    } finally {
      setThreadLoading(false);
    }
  };

  const postComment = async (body: string) => {
    if (!revision) throw new Error("Pull request is still loading.");
    setPosting(true);
    setPostError(null);
    try {
      if (replyTo?.threadId)
        await azurePrThreadComment(
          prTarget,
          revision,
          Number(replyTo.threadId),
          body,
        );
      else
        await azurePrSubmitReview(prTarget, revision, {
          event: "comment",
          body,
          comments: [],
        });
      setReplyTo(null);
      await refreshThreads();
    } catch (postFailure) {
      setPostError(message(postFailure));
      throw postFailure;
    } finally {
      setPosting(false);
    }
  };

  const review = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const id = generation.current;
    const current = () => id === generation.current;
    try {
      const status = await azureConnected();
      if (!current()) return;
      if (
        !status.connected ||
        status.site !== item.site ||
        status.accountId !== delivery.accountId
      )
        throw new Error(
          "Azure account changed. Refresh Inbox before opening this item.",
        );
      const checkout = await ciContext(folder);
      if (!current()) return;
      let inboxTarget: CiTarget | undefined;
      let ciRemote: string | undefined;
      let ciDefinitionName: string | undefined;
      if (delivery.kind === "pr") {
        const page = await findAzurePrs(prTarget, "");
        if (!current()) return;
        const fresh = await readAzurePr({
          ...page.target,
          number: item.number,
        });
        if (!current()) return;
        saveAzurePrAssociation(
          {
            target: { ...page.target, number: item.number },
            ...fresh,
            account: status.account,
            projectName: page.projectName,
            repositoryName: page.repositoryName,
            cwd: folder,
            branch: checkout.branch,
          },
          folder,
          checkout.branch,
        );
      } else {
        const target = parsePipelineUrl(
          `${item.site}/${encodeURIComponent(delivery.project)}/_build?definitionId=${delivery.definition}`,
          delivery.accountId,
        );
        setRemotes(checkout.remotes);
        const selectedRemote =
          checkout.remotes.find((value) => value.url === remote)?.url ??
          (checkout.remotes.length === 1 ? checkout.remotes[0].url : undefined);
        if (!selectedRemote)
          throw new Error(
            "Choose the repository remote used by this pipeline below, then retry.",
          );
        const page = await ciLookup(
          target,
          { ...checkout, remote: selectedRemote },
          null,
          item.number,
        );
        if (!current()) return;
        if (
          page.target.repositoryId !== delivery.repository ||
          page.target.repositoryType !== delivery.repositoryType
        )
          throw new Error("Pipeline repository changed. Refresh Inbox.");
        const run = page.items.find((value) => value.id === item.number);
        if (!run)
          throw new Error(
            "Azure did not return this run. Refresh Inbox or open it in Azure.",
          );
        inboxTarget = page.target;
        ciRemote = selectedRemote;
        ciDefinitionName = page.definitionName;
        const source = {
          target: page.target,
          cwd: folder,
          branch: checkout.branch,
          remote: selectedRemote,
          definitionName: page.definitionName,
          projectName: page.projectName,
          last: { run, commit: checkout.commit, checkedAt: page.checkedAt },
        };
        saveCiSources(
          [
            source,
            ...loadCiSources(folder, checkout.branch).filter(
              (value) =>
                value.target.site !== page.target.site ||
                value.target.project !== page.target.project ||
                value.target.definition !== page.target.definition,
            ),
          ],
          folder,
          checkout.branch,
        );
      }
      saveDeliveryProvider(
        folder,
        checkout.branch,
        undefined,
        delivery.kind,
        "azure",
      );
      setReady({
        cwd: folder,
        branch: checkout.branch,
        inboxTarget,
        ciRemote,
        ciDefinitionName,
      });
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const openWatch = () => {
    if (!ready) return;
    if (isPr) {
      const association = loadAzurePrAssociation(ready.cwd, ready.branch);
      if (!association) return;
      openWatchSheet({
        source: {
          kind: "azure-pr",
          target: association.target,
          projectName: association.projectName,
          repositoryName: association.repositoryName,
          cwd: ready.cwd,
          branch: ready.branch,
        },
        name: `Reviews · ${association.repositoryName} !${item.number}`,
      });
    } else if (ready.inboxTarget && ready.ciRemote) {
      openWatchSheet({
        source: {
          kind: "azure-ci",
          target: ready.inboxTarget,
          definitionName: ready.ciDefinitionName ?? "",
          remote: ready.ciRemote,
          cwd: ready.cwd,
          branch: ready.branch,
        },
        name: `CI · ${ready.ciDefinitionName ?? item.title}`,
      });
    }
  };

  // The Code tab opens the review directly — the same contract as the
  // GitHub/GitLab detail, where mounting the review verifies and binds the
  // checkout. Only a failed bind falls back to the picker.
  useEffect(() => {
    if (!isPr || tab !== "code" || ready || busy) return;
    if (!folder || folder === "~" || autoOpened.current === folder) return;
    autoOpened.current = folder;
    void review();
  }, [isPr, tab, ready, busy, folder]);

  const branch = delivery.branch.replace(/^refs\/heads\//, "");
  const target = delivery.targetBranch?.replace(/^refs\/heads\//, "");
  const time = formatRelativeTime(item.updatedAt);
  const checkoutPicker = (
    <div className="flex items-center gap-2 text-[11px] text-content/60">
      <span>Review checkout</span>
      <CwdPicker
        cwd={folder}
        enabled={!busy}
        placement="below"
        recents={projects.map((project) => ({ ...project, openedAt: 0 }))}
        onCwdChange={(value) => {
          if (!pending.current) {
            generation.current++;
            setFolder(value);
            setRemotes([]);
            setRemote("");
            setError("");
          }
        }}
      />
      <span className="text-content/40">
        Opening review does not change its files.
      </span>
    </div>
  );
  return (
    <InboxDetailShell
      item={item}
      cwd={cwd}
      context={context}
      source={
        <span className="truncate">
          {item.site?.split("/").pop()} / {item.projectName} · {item.repo}
        </span>
      }
      meta={
        <>
          {item.state ? (
            <span>
              {item.state}
              {item.draft ? " · draft" : ""}
            </span>
          ) : null}
          {delivery.author ? (
            <>
              {item.state ? <span aria-hidden>·</span> : null}
              <span className="min-w-0 truncate">{delivery.author}</span>
            </>
          ) : null}
          {branch ? (
            <>
              {item.state || delivery.author ? (
                <span aria-hidden>·</span>
              ) : null}
              <span className="inline-flex min-w-0 items-center gap-1">
                <GitCompare
                  className="size-3 shrink-0"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 truncate">
                  {target ? `${target} ← ${branch}` : branch}
                </span>
              </span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span className="tabular-nums">{delivery.commit.slice(0, 8)}</span>
          {time ? (
            <>
              <span aria-hidden>·</span>
              <span>Updated {time}</span>
            </>
          ) : null}
        </>
      }
      myWork={myWork}
      viewingSessionId={viewingSessionId}
      onOpenSession={onOpenSession}
      onOpenDelivery={onOpenDelivery}
      onOpenAttention={onAttentionAction}
      onDiscuss={onDiscuss}
      actions={
        <>
          {!ready ? (
            <button
              className={ACTION_OUTLINE}
              disabled={busy || !folder || folder === "~"}
              onClick={() => {
                if (isPr) setTab("code");
                void review();
              }}
            >
              {busy ? "Opening…" : isPr ? "Review PR" : "Review CI"}
            </button>
          ) : (
            <button
              className={ACTION_OUTLINE}
              onClick={() => {
                setReady(undefined);
                if (isPr) setTab("code");
              }}
            >
              Change checkout
            </button>
          )}
          {ready ? (
            <button
              className={ACTION_GHOST}
              title={
                isPr
                  ? "Watch reviews and statuses on this PR"
                  : "Watch failures on this pipeline"
              }
              onClick={openWatch}
            >
              <Zap className="size-3.5" strokeWidth={1.75} /> Watch
            </button>
          ) : null}
          <button
            className={ACTION_GHOST}
            onClick={() =>
              void openUrl(item.url).catch((e) => setError(String(e)))
            }
          >
            <ExternalLink className="size-3.5" strokeWidth={1.75} />
            Open in Azure
          </button>
        </>
      }
      extra={
        <>
          {!myWork?.hasWork && relatedSessions.length ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-content/60">
              <span>Related conversations</span>
              {relatedSessions.map((session) => (
                <button
                  key={session.id}
                  className={button}
                  onClick={() =>
                    void Promise.resolve(onOpenSession?.(session.id)).catch(
                      (e) => setError(String(e)),
                    )
                  }
                >
                  {session.title || "Conversation"}
                </button>
              ))}
            </div>
          ) : null}
          {!isPr && !ready ? checkoutPicker : null}
          {!isPr && !ready && remotes.length > 1 ? (
            <Select
              label="Pipeline repository remote"
              value={remote}
              disabled={busy}
              options={[
                { value: "", label: "Choose remote" },
                ...remotes.map((value) => ({
                  value: value.url,
                  label: `${value.name} · ${value.url}`,
                })),
              ]}
              onChange={setRemote}
            />
          ) : null}
        </>
      }
      error={
        error ? (
          <p role="alert" className="text-[12px] text-red-400">
            {error}
          </p>
        ) : null
      }
      tabs={
        isPr
          ? {
              ariaLabel: "Pull request sections",
              items: [
                {
                  label: "Summary",
                  selected: tab === "summary",
                  onSelect: () => setTab("summary"),
                },
                {
                  label: "Code",
                  selected: tab === "code",
                  onSelect: () => setTab("code"),
                },
              ],
            }
          : undefined
      }
    >
      {isPr && tab === "summary" ? (
        <div
          ref={detailLock}
          data-inbox-detail-scroll
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-8 py-5">
            {summaryLoading && description == null ? (
              <div className="flex justify-center py-10 text-content/40">
                <LoaderCircle
                  className="size-4 animate-spin"
                  strokeWidth={1.75}
                />
              </div>
            ) : (
              <>
                {detailsError ? (
                  <p role="status" className="text-[12px] text-content/50">
                    {detailsError}{" "}
                    <button
                      type="button"
                      className={ACTION_GHOST}
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      Retry
                    </button>
                  </p>
                ) : null}
                {description == null ? null : description.trim() ? (
                  <AgentMarkdown
                    text={description}
                    cwd={folder}
                    allowRemoteMedia
                  />
                ) : (
                  <p className="text-[13px] text-content/45">No description</p>
                )}
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="text-content/45">Related stories</span>
                  {stories ? (
                    stories.length ? (
                      stories.map((id) => (
                        <button
                          key={id}
                          className={button}
                          onClick={() =>
                            void openUrl(
                              `${item.site}/${encodeURIComponent(delivery.project)}/_workitems/edit/${id}`,
                            ).catch((e) => setError(String(e)))
                          }
                        >
                          #{id} ↗
                        </button>
                      ))
                    ) : (
                      <span className="text-content/45">No linked stories</span>
                    )
                  ) : storiesError ? (
                    <span className="text-content/45">{storiesError}</span>
                  ) : (
                    <span className="text-content/45">Loading…</span>
                  )}
                </div>
                <InboxComments
                  thread={threadData}
                  loading={threadLoading}
                  error={threadError}
                  cwd={folder}
                  provider="azure"
                  replyMode="thread"
                  onReply={setReplyTo}
                />
                {threadError ? (
                  <button
                    type="button"
                    className={ACTION_GHOST}
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    Retry comments
                  </button>
                ) : null}
                <InboxCommentForm
                  replyTo={replyTo}
                  posting={posting}
                  error={postError}
                  onCancelReply={() => {
                    setReplyTo(null);
                    setPostError(null);
                  }}
                  onSubmit={postComment}
                />
              </>
            )}
          </div>
        </div>
      ) : ready ? (
        <div className="min-h-0 flex-1">
          {isPr ? (
            <AzurePrReview
              cwd={ready.cwd}
              branch={ready.branch}
              embedded
              enabled
              linkedWorkItem={
                stories?.[0]
                  ? {
                      kind: "issue",
                      provider: "azure",
                      site: item.site,
                      identifier: stories[0],
                      repo: item.repo,
                      number: Number(stories[0]),
                      url: `${item.site}/${encodeURIComponent(delivery.project)}/_workitems/edit/${stories[0]}`,
                    }
                  : undefined
              }
              onClose={() => setReady(undefined)}
            />
          ) : (
            <AzureCiReview
              inboxTarget={ready.inboxTarget}
              cwd={ready.cwd}
              branch={ready.branch}
              embedded
              enabled
              onClose={() => setReady(undefined)}
            />
          )}
        </div>
      ) : isPr ? (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2.5 px-8 py-5">
          {busy ? (
            <div className="flex justify-center py-10 text-content/40">
              <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
            </div>
          ) : (
            <>
              {checkoutPicker}
              <div>
                <button
                  className={ACTION_OUTLINE}
                  disabled={busy || !folder || folder === "~"}
                  onClick={() => void review()}
                >
                  Review PR
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </InboxDetailShell>
  );
}
