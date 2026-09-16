import { InboxContextPicker, useInboxContext } from "./InboxContextPicker";
import { ACTION_FILLED, ACTION_OUTLINE, ACTION_GHOST } from "./inboxActions";
import { MessageSquare, ExternalLink } from "./icons";
import type { SessionSummary } from "../lib/sessionStore";
import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { azureConnected } from "../lib/azure";
import {
  findAzurePrs,
  readAzurePr,
  readAzurePrSection,
  saveAzurePrAssociation,
} from "../lib/azureRepos";
import {
  ciContext,
  ciLookup,
  loadCiSources,
  saveCiSources,
  parsePipelineUrl,
} from "../lib/azurePipelines";
import { saveDeliveryProvider } from "../lib/deliveryProviders";
import type { InboxItem, InboxComposerCard } from "../lib/githubTasks";
import { CwdPicker } from "./CwdPicker";
import { AzurePrReview } from "./AzurePrReview";
import { AzureCiReview } from "./AzureCiReview";

const button =
  "rounded-md px-2 py-1.5 text-[12px] text-content/70 hover:bg-content/10 disabled:opacity-40";
/** Delivery uses its existing review surface, never the Boards item-content endpoint. */
export function AzureInboxDetail({
  item,
  cwd,
  projects,
  relatedSessions = [],
  onOpenSession,
  onDiscuss,
}: {
  item: InboxItem;
  cwd: string;
  projects: { path: string; name: string }[];
  relatedSessions?: readonly SessionSummary[];
  onOpenSession?: (id: string) => void | Promise<void>;
  onDiscuss?: (card: InboxComposerCard) => void | Promise<void>;
}) {
  const delivery = item.delivery!;
  const context = useInboxContext(item);
  const [folder, setFolder] = useState(item.projectPath || cwd);
  const [ready, setReady] = useState<{
    cwd: string;
    branch: string;
    inboxTarget?: import("../lib/azurePipelines").CiTarget;
  }>();
  const [remotes, setRemotes] = useState<{ name: string; url: string }[]>([]);
  const [remote, setRemote] = useState("");
  const [stories, setStories] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0),
    pending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
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
      let inboxTarget: import("../lib/azurePipelines").CiTarget | undefined;
      if (delivery.kind === "pr") {
        const page = await findAzurePrs(
          {
            site: item.site!,
            accountId: delivery.accountId,
            project: delivery.project,
            repository: delivery.repository,
            number: item.number,
          },
          "",
        );
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
        const run = page.items.find((run) => run.id === item.number);
        if (!run)
          throw new Error(
            "Azure did not return this run. Refresh Inbox or open it in Azure.",
          );
        inboxTarget = page.target;
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
      setReady({ cwd: folder, branch: checkout.branch, inboxTarget });
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const loadStories = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const id = generation.current;
    try {
      const target = {
        site: item.site!,
        accountId: delivery.accountId,
        project: delivery.project,
        repository: delivery.repository,
        number: item.number,
      };
      const fresh = await readAzurePr(target);
      if (id !== generation.current) return;
      const page = await readAzurePrSection<{ id: string }>(
        target,
        fresh.revision,
        "workitems",
      );
      if (id === generation.current)
        setStories(
          page.items
            .map((value) => value.id)
            .filter((value) => /^\d+$/.test(value))
            .slice(0, 50),
        );
    } catch (e) {
      if (id === generation.current)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (id === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b border-content/10 p-4 text-[12px] text-content/65">
        <div className="text-[11px]">
          {delivery.kind === "pr" ? "Azure Repos" : "Azure Pipelines"} ·{" "}
          {item.site?.split("/").pop()} / {item.projectName} · {item.repo}
        </div>
        <h2 className="text-[15px] font-medium text-content">{item.title}</h2>
        <p>
          {item.identifier} · {item.state} · {delivery.author}
        </p>
        <p className="break-all">
          {delivery.branch.replace(/^refs\/heads\//, "")}
          {delivery.targetBranch
            ? ` → ${delivery.targetBranch.replace(/^refs\/heads\//, "")}`
            : ""}{" "}
          · {delivery.commit.slice(0, 8)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={ACTION_FILLED}
            disabled={context.busy}
            onClick={() => context.open("ask")}
          >
            <MessageSquare className="size-3.5" strokeWidth={1.75} />
            Ask agent
          </button>
          {!ready ? (
            <>
              <button
                className={ACTION_OUTLINE}
                disabled={busy || !folder || folder === "~"}
                onClick={() => void review()}
              >
                {busy
                  ? "Opening…"
                  : delivery.kind === "pr"
                    ? "Review PR"
                    : "Review CI"}
              </button>
            </>
          ) : (
            <button className={button} onClick={() => setReady(undefined)}>
              Change checkout
            </button>
          )}
          <button
            className={ACTION_GHOST}
            onClick={() =>
              void openUrl(item.url).catch((e) => setError(String(e)))
            }
          >
            <ExternalLink className="size-3.5" strokeWidth={1.75} />
            Open in Azure
          </button>
        </div>
        {!ready ? (
          <div className="flex items-center gap-2 text-[11px]">
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
          </div>
        ) : null}
        {!ready && remotes.length > 1 ? (
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
        {delivery.kind === "pr" ? (
          <div className="text-[11px]">
            <button
              className={button}
              disabled={busy}
              onClick={() => void loadStories()}
            >
              Related stories
            </button>
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
                <span>No linked stories</span>
              )
            ) : null}
          </div>
        ) : null}
        {!ready ? (
          <p className="text-[11px] text-content/45">
            Review uses this working copy. Opening review does not change its
            files.
          </p>
        ) : null}
        {relatedSessions.length ? (
          <div className="text-[11px]">
            Related conversations{" "}
            {relatedSessions.map((session) => (
              <button
                key={session.id}
                className={button}
                onClick={() =>
                  void Promise.resolve(onOpenSession?.(session.id)).catch((e) =>
                    setError(String(e)),
                  )
                }
              >
                {session.title || "Conversation"}
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        ) : null}
      </div>
      <InboxContextPicker
        context={context}
        onConfirm={async (card) => {
          await onDiscuss?.(card);
        }}
      />
      {ready ? (
        <div className="min-h-0 flex-1">
          {delivery.kind === "pr" ? (
            <AzurePrReview
              {...ready}
              embedded
              enabled
              onClose={() => setReady(undefined)}
            />
          ) : (
            <AzureCiReview
              {...ready}
              embedded
              enabled
              onClose={() => setReady(undefined)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
