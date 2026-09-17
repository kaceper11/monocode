import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AttentionItem } from "../lib/attention";
import type { InboxItem } from "../lib/githubTasks";
import type {
  InboxMyWork,
  InboxMyWorkCi,
  InboxMyWorkPr,
  InboxMyWorkSession,
} from "../lib/inboxMyWork";
import { sessionDisplayTitle } from "../lib/session";
import { peekProjectDiffStats } from "../hooks/useProjectDiffStats";
import { cachedBranchPr } from "../hooks/useBranchPr";
import { useDeliveryStores } from "../hooks/useDeliveryStores";
import {
  deliveryFromLinks,
  sessionDeliveryLinks,
} from "../lib/taskDelivery";
import { pathKey, projectName } from "../lib/paths";
import { OPEN_TASK_DETAILS } from "../lib/taskWorkspaces";
import { InboxProviderMark } from "./InboxProviderMark";
import { Popover } from "./Popover";
import { Select } from "./Select";
import { DeliveryBadges } from "./TaskScopeChip";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  GitPullRequest,
  LoaderCircle,
  Task,
  Zap,
} from "./icons";

const http = (url: string | undefined) =>
  url && /^https?:\/\//i.test(url) ? url : null;

const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-50";

const SESSION_STATE_LABEL: Record<InboxMyWorkSession["state"], string> = {
  waiting: "Waiting on you",
  working: "Working",
  archived: "Archived",
  idle: "Idle",
};

const SESSION_STATE_DOT: Partial<
  Record<InboxMyWorkSession["state"], string>
> = {
  waiting: "bg-amber-400",
  working: "bg-emerald-400",
};

type DeliveryProvider = "github" | "azure" | "gitlab";
type DeliveryKind = "pr" | "ci";
type OpenDelivery = (
  sessionId: string,
  kind: DeliveryKind,
  current: () => boolean,
  provider: DeliveryProvider,
  prUrl?: string,
  gitlabTarget?: { repo: string; number: number },
) => Promise<void>;

function loadDeliveryProviders(): Record<string, DeliveryProvider> {
  try {
    const saved = JSON.parse(
      localStorage.getItem("monocode.inboxDeliveryProviders.v2") || "{}",
    );
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? (Object.fromEntries(
          Object.entries(saved)
            .filter(
              ([, value]) =>
                value === "github" || value === "azure" || value === "gitlab",
            )
            .slice(-100),
        ) as Record<string, DeliveryProvider>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The task-first body of an inbox item: one row per attached task (opening
 * `TaskDetails`, which owns the item's tickets, conversations, PRs and CI),
 * then the related conversations no attached task owns — each still carrying
 * its checkout's delivery actions — then queue rows waiting on the user.
 * Pure presentation over the `inboxMyWorkForItems` join plus saved delivery
 * links; nothing here fetches.
 */
export function InboxTasksSection({
  item,
  work,
  viewingSessionId,
  onOpenSession,
  onOpenDelivery,
  onOpenAttention,
}: {
  item: InboxItem;
  work: InboxMyWork;
  /** Session the user is currently reading — it hosts its checkout's
   * delivery cluster when several conversations share a working copy. */
  viewingSessionId?: string;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: OpenDelivery;
  onOpenAttention?: (item: AttentionItem) => void | Promise<void>;
}) {
  // Delivery is branch-scoped: a provider choice belongs to the working copy
  // (normalized), not to one conversation or ticket that happened to send it.
  const [deliveryProviders, setDeliveryProviders] =
    useState<Record<string, DeliveryProvider>>(loadDeliveryProviders);
  const [choosing, setChoosing] = useState<{ key: string; cwd: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const providerKey = (scope: string, kind: DeliveryKind) =>
    JSON.stringify([scope, kind]);
  const deliveryProvider = (
    scope: string,
    kind: DeliveryKind,
    inferred?: DeliveryProvider,
  ) => {
    const saved = deliveryProviders[providerKey(scope, kind)] ?? inferred;
    const provider =
      saved === "github" || saved === "azure" || saved === "gitlab"
        ? saved
        : item.provider === "github" ||
            item.provider === "azure" ||
            item.provider === "gitlab"
          ? item.provider
          : undefined;
    // GitLab pipelines ride the MR surface — never a standalone CI delivery.
    return provider === "gitlab" && kind === "ci" ? undefined : provider;
  };
  const saveProvider = (
    scope: string,
    kind: DeliveryKind,
    provider: string,
  ) => {
    if (
      provider !== "" &&
      provider !== "github" &&
      provider !== "azure" &&
      provider !== "gitlab"
    )
      return;
    const key = providerKey(scope, kind);
    const next = Object.fromEntries(
      [
        ...Object.entries(deliveryProviders).filter(([entry]) => entry !== key),
        ...(provider ? [[key, provider]] : []),
      ].slice(-100),
    );
    try {
      localStorage.setItem(
        "monocode.inboxDeliveryProviders.v2",
        JSON.stringify(next),
      );
      setDeliveryProviders(next);
    } catch {
      setError("Could not save delivery providers. Try again.");
    }
  };
  const openDelivery = async (
    sessionId: string,
    scope: string,
    kind: DeliveryKind,
    inferred: DeliveryProvider | undefined,
    cwd: string,
    prUrl?: string,
  ) => {
    if (!onOpenDelivery || pending.current) return;
    const provider = deliveryProvider(scope, kind, inferred);
    if (!provider) {
      setChoosing({ key: scope, cwd });
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onOpenDelivery(
        sessionId,
        kind,
        () => mounted.current,
        provider,
        prUrl ??
          (item.provider === "github" && item.kind === "pr"
            ? item.url
            : undefined),
        item.provider === "gitlab" && item.kind === "pr"
          ? { repo: item.repo, number: item.number }
          : undefined,
      );
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const stores = useDeliveryStores();

  // Sessions an attached task covers at their checkout fold into the task
  // row — every other related conversation gets its own row.
  const loose = work.sessions.filter((session) => !session.coveredByTask);
  const scopeOf = (session: InboxMyWorkSession) =>
    session.cwd && session.cwd !== "~" && !session.ask
      ? pathKey(session.cwd)
      : "";
  // Delivery belongs to the working copy — one cluster per checkout, hosted
  // on the viewed conversation when it shares the copy, else the first row.
  const hosts = new Map<string, string>();
  for (const session of loose) {
    const scope = scopeOf(session);
    if (scope && !hosts.has(scope)) hosts.set(scope, session.sessionId);
  }
  const viewed = loose.find(
    (session) => session.sessionId === viewingSessionId,
  );
  const viewedScope = viewed ? scopeOf(viewed) : "";
  if (viewed && viewedScope) hosts.set(viewedScope, viewed.sessionId);

  // Joined delivery nothing rendered — folded into a task, a capped-out
  // conversation, or a link scoped to a sibling that didn't host its
  // checkout — still gets an open path rather than silently hiding.
  const hostIds = new Set(hosts.values());
  const orphan = (row: { sessionId?: string; coveredByTask?: boolean }) =>
    !row.coveredByTask &&
    !(row.sessionId && hostIds.has(row.sessionId));
  const orphanPrs = work.prs.filter(orphan);
  const orphanCi = work.ci.filter(orphan);
  const openOrphanPr = (pr: InboxMyWorkPr) => {
    if (pr.sessionId && pr.cwd && onOpenDelivery) {
      void openDelivery(
        pr.sessionId,
        pathKey(pr.cwd),
        "pr",
        pr.provider,
        pr.cwd,
        pr.url,
      );
      return;
    }
    const url = http(pr.url);
    if (url) void openUrl(url);
  };
  const openOrphanCi = (row: InboxMyWorkCi) => {
    if (row.sessionId && onOpenDelivery) {
      void openDelivery(
        row.sessionId,
        pathKey(row.cwd),
        "ci",
        row.provider,
        row.cwd,
      );
      return;
    }
    const url = http(row.url);
    if (url) void openUrl(url);
  };

  return (
    <section aria-label="Work on this item" className="space-y-1">
      {work.tasks.length ? (
        <div>
          <p className="px-1 pb-0.5 text-[11px] font-medium text-content/45">
            {work.tasks.length === 1 ? "Task" : "Tasks"}
          </p>
          {work.tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              title={`Open task details: ${task.name}`}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent(OPEN_TASK_DETAILS, { detail: task.id }),
                )
              }
              className={ROW}
            >
              <Task
                className="size-3.5 shrink-0 text-content/50"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                {task.name}
              </span>
              <DeliveryBadges delivery={task.delivery} />
              {task.status.length ? (
                <span
                  className={`min-w-0 truncate text-[11px] ${
                    /needs? (input|review)|failing|failed/i.test(
                      task.status[0],
                    )
                      ? "text-amber-400/90"
                      : "text-content/45"
                  }`}
                >
                  {task.status.join(" · ")}
                </span>
              ) : null}
              {task.sessions ? (
                <span className="shrink-0 text-[11px] text-content/40">
                  {task.sessions}{" "}
                  {task.sessions === 1 ? "conversation" : "conversations"}
                </span>
              ) : null}
              <ChevronRight
                className="size-3.5 shrink-0 text-content/30"
                strokeWidth={1.75}
              />
            </button>
          ))}
        </div>
      ) : null}
      {loose.length ? (
        <div>
          <p className="px-1 pb-0.5 text-[11px] font-medium text-content/45">
            Conversations
          </p>
          {loose.map((session) => (
            <ConversationRow
              key={session.sessionId}
              session={session}
              stores={stores}
              busy={busy}
              deliveryEnabled={!!onOpenDelivery}
              deliveryHost={
                hosts.get(scopeOf(session)) === session.sessionId
              }
              providerFor={(scope, kind, inferred) =>
                deliveryProvider(scope, kind, inferred)
              }
              onOpenSession={onOpenSession}
              onOpenDelivery={(scope, kind, inferred, cwd) =>
                void openDelivery(
                  session.sessionId,
                  scope,
                  kind,
                  inferred,
                  cwd,
                )
              }
              onChooseProviders={(key, cwd) => setChoosing({ key, cwd })}
            />
          ))}
        </div>
      ) : null}
      {orphanPrs.length || orphanCi.length ? (
        <div>
          <p className="px-1 pb-0.5 text-[11px] font-medium text-content/45">
            Delivery
          </p>
          {orphanPrs.map((pr) => {
            const openable = Boolean(
              (pr.sessionId && pr.cwd && onOpenDelivery) || http(pr.url),
            );
            return (
              <button
                key={pr.key}
                type="button"
                disabled={!openable || busy}
                title={
                  pr.sessionId && pr.cwd && onOpenDelivery
                    ? `Open ${pr.provider === "github" ? "GitHub" : "Azure"} PR review`
                    : `Open ${pr.url}`
                }
                onClick={() => openOrphanPr(pr)}
                className={ROW}
              >
                <InboxProviderMark
                  provider={pr.provider}
                  className="size-3.5 shrink-0"
                />
                <span className="shrink-0 tabular-nums text-[12px] text-content/55">
                  {pr.number !== undefined ? `#${pr.number}` : "PR"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                  {pr.title || pr.url}
                </span>
                <span className="shrink-0 truncate text-[11px] text-content/40">
                  {pr.repo}
                </span>
                {pr.ci?.failing || pr.checksFailing ? (
                  <span className="shrink-0 text-[11px] text-rose-400/90">
                    {pr.ci?.label || "Checks failing"}
                  </span>
                ) : pr.ci?.running ? (
                  <span className="shrink-0 text-[11px] text-content/50">
                    {pr.ci.label}
                  </span>
                ) : null}
                {pr.needsAttention ? (
                  <span className="shrink-0 text-[11px] text-amber-400">
                    Changes requested
                  </span>
                ) : null}
              </button>
            );
          })}
          {orphanCi.map((row) => {
            const openable = Boolean(
              (row.sessionId && onOpenDelivery) || http(row.url),
            );
            return (
              <button
                key={row.key}
                type="button"
                disabled={!openable || busy}
                title={
                  row.sessionId && onOpenDelivery
                    ? "Open pipeline"
                    : row.url
                      ? `Open ${row.url}`
                      : row.name
                }
                onClick={() => openOrphanCi(row)}
                className={ROW}
              >
                <CircleDot
                  className={`size-3.5 shrink-0 ${row.failing ? "text-rose-400" : row.running ? "text-amber-400" : "text-content/50"}`}
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                  {row.name}
                </span>
                <span className="shrink-0 truncate text-[11px] text-content/40">
                  {row.projectName}
                </span>
                <span
                  className={`shrink-0 text-[11px] ${row.failing ? "text-rose-400/90" : "text-content/45"}`}
                >
                  {row.state}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {work.attention.length ? (
        <div>
          <p className="px-1 pb-0.5 text-[11px] font-medium text-content/45">
            Waiting on you
          </p>
          {work.attention.map((row) => (
            <button
              key={row.key}
              type="button"
              disabled={!row.action || !onOpenAttention}
              title={row.detail || row.title}
              onClick={() => void onOpenAttention?.(row)}
              className={ROW}
            >
              <CircleAlert
                className="size-3.5 shrink-0 text-amber-400"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                {row.title}
              </span>
              {row.detail ? (
                <span className="shrink-0 truncate text-[11px] text-content/40">
                  {row.detail}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {choosing ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-content/10 p-2">
          {(
            [
              ["pr", "PR provider"],
              ["ci", "CI provider"],
            ] as const
          ).map(([kind, label]) => {
            const title =
              peekProjectDiffStats(choosing.cwd)?.branch?.trim() ||
              projectName(choosing.cwd);
            return (
              <span key={kind} className="text-[11px] text-content/60">
                {label}
                <Select
                  label={`${label} for ${title}`}
                  value={deliveryProviders[providerKey(choosing.key, kind)] ?? ""}
                  options={[
                    {
                      value: "",
                      label:
                        item.provider === "github" ||
                        item.provider === "azure" ||
                        item.provider === "gitlab"
                          ? "Use ticket provider"
                          : "Choose provider",
                    },
                    {
                      value: "github",
                      label: kind === "pr" ? "GitHub" : "GitHub checks",
                    },
                    {
                      value: "azure",
                      label: kind === "pr" ? "Azure Repos" : "Azure Pipelines",
                    },
                    ...(kind === "pr"
                      ? [{ value: "gitlab", label: "GitLab" }]
                      : []),
                  ]}
                  onChange={(value) =>
                    saveProvider(choosing.key, kind, value)
                  }
                />
              </span>
            );
          })}
          <button
            type="button"
            className="px-2 py-1 text-[11px]"
            onClick={() => setChoosing(null)}
          >
            Done
          </button>
        </div>
      ) : null}
      {busy ? (
        <p
          role="status"
          className="flex items-center gap-2 px-1 py-0.5 text-[11px] text-content/50"
        >
          <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
          Opening review…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-1 py-0.5 text-[12px] text-rose-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** A related conversation not owned by an attached task — click opens the
 * session; the chevron carries the checkout's saved PR/CI actions when the
 * conversation can host them (a delivery tab needs a real workspace). */
function ConversationRow({
  session,
  stores,
  busy,
  deliveryEnabled,
  deliveryHost,
  providerFor,
  onOpenSession,
  onOpenDelivery,
  onChooseProviders,
}: {
  session: InboxMyWorkSession;
  stores: ReturnType<typeof useDeliveryStores>;
  busy: boolean;
  /** No delivery handler → no pills — they'd open nothing anyway. */
  deliveryEnabled: boolean;
  /** One checkout gets one delivery cluster — only the host row renders it. */
  deliveryHost: boolean;
  providerFor: (
    scope: string,
    kind: DeliveryKind,
    inferred?: DeliveryProvider,
  ) => DeliveryProvider | undefined;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery: (
    scope: string,
    kind: DeliveryKind,
    inferred: DeliveryProvider | undefined,
    cwd: string,
  ) => void;
  onChooseProviders: (scope: string, cwd: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const cwd = session.cwd;
  const scope = cwd ? pathKey(cwd) : "";
  // Ask threads and cwd-less rows have no checkout to resolve against.
  const deliverable =
    deliveryEnabled && !!scope && cwd !== "~" && !session.ask;
  const branch = deliverable
    ? peekProjectDiffStats(cwd)?.branch?.trim()
    : undefined;
  const links = deliverable
    ? sessionDeliveryLinks({
        cwd,
        branches: [branch, session.branch],
        sessionIds: [session.sessionId],
        githubPr: cachedBranchPr(cwd, branch),
        stores,
      })
    : null;
  const delivery = links ? deliveryFromLinks(links) : null;
  // Saved pick → the provider that actually has links → ticket provider.
  const inferred = (kind: DeliveryKind): DeliveryProvider | undefined =>
    !links
      ? undefined
      : kind === "pr"
        ? links.prs.length
          ? "azure"
          : links.githubPr
            ? "github"
            : undefined
        : links.ci.length
          ? "azure"
          : links.githubPr
            ? "github"
            : undefined;
  const providerName = (kind: DeliveryKind) => {
    const provider = providerFor(scope, kind, inferred(kind));
    return provider === "github"
      ? "GitHub"
      : provider === "azure"
        ? "Azure"
        : provider === "gitlab"
          ? "GitLab"
          : undefined;
  };
  const open = (kind: DeliveryKind) =>
    providerFor(scope, kind, inferred(kind))
      ? onOpenDelivery(scope, kind, inferred(kind), cwd)
      : onChooseProviders(scope, cwd);
  const title = sessionDisplayTitle(session.title, session.harness);
  const itemClass =
    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5 disabled:opacity-50";
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={!onOpenSession}
        title={`Open conversation: ${title}`}
        onClick={() => void onOpenSession?.(session.sessionId)}
        className={ROW}
      >
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${SESSION_STATE_DOT[session.state] ?? "bg-content/25"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
          {title}
        </span>
        <span className="shrink-0 text-[11px] text-content/45">
          {SESSION_STATE_LABEL[session.state]}
        </span>
      </button>
      {deliverable && delivery && deliveryHost ? (
        <>
          {delivery.prs > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => open("pr")}
              aria-label={`${delivery.prs} pull request${delivery.prs > 1 ? "s" : ""} on ${branch || projectName(cwd)}`}
              title={`${delivery.prs} pull request${delivery.prs > 1 ? "s" : ""} on ${branch || projectName(cwd)}`}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none ${
                delivery.prNeedsAttention
                  ? "border-red-400/40 text-red-300"
                  : "border-content/15 text-content/60 hover:text-content"
              }`}
            >
              <GitPullRequest className="size-3" strokeWidth={1.75} />
              {delivery.prs > 1 ? delivery.prs : "PR"}
            </button>
          ) : null}
          {delivery.ci > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => open("ci")}
              aria-label={`${delivery.ci} pipeline${delivery.ci > 1 ? "s" : ""} on ${branch || projectName(cwd)}`}
              title={`${delivery.ci} pipeline${delivery.ci > 1 ? "s" : ""} on ${branch || projectName(cwd)}`}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none ${
                delivery.ciFailing
                  ? "border-red-400/40 text-red-300"
                  : delivery.ciRunning
                    ? "border-amber-400/40 text-amber-300"
                    : "border-content/15 text-content/60 hover:text-content"
              }`}
            >
              <Zap className="size-3" strokeWidth={1.75} />
              {delivery.ci > 1 ? delivery.ci : "CI"}
            </button>
          ) : null}
          <button
            ref={anchor}
            type="button"
            title={`PRs and CI for ${branch || projectName(cwd)}`}
            aria-label={`Delivery actions for ${branch || projectName(cwd)} in ${projectName(cwd)}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
          </button>
          {menu ? (
            <Popover
              anchor={anchor}
              onDismiss={() => setMenu(false)}
              role="menu"
              aria-label={`Delivery for ${branch || title}`}
              className="w-48 overflow-hidden"
            >
              <div className="px-1.5 py-1.5">
                {(["pr", "ci"] as const).map((kind) => {
                  const provider = providerName(kind);
                  const kindLabel = kind === "pr" ? "PRs" : "CI";
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      title={
                        provider
                          ? `${kindLabel} · ${provider}`
                          : `Pick a ${kindLabel} provider first`
                      }
                      onClick={() => {
                        setMenu(false);
                        open(kind);
                      }}
                      className={itemClass}
                    >
                      {provider
                        ? provider === "GitHub" && kind === "ci"
                          ? "GitHub checks"
                          : `${provider} ${kindLabel}`
                        : `Choose ${kindLabel} provider`}
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onChooseProviders(scope, cwd);
                  }}
                  className={itemClass}
                >
                  Providers…
                </button>
              </div>
            </Popover>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
