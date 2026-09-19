import { useEffect, useRef, useState } from "react";
import { AZURE_CHANGE_EVENT, azureConnected } from "../lib/azure";
import { JIRA_CHANGE_EVENT, jiraConnected } from "../lib/jira";
import { refreshLinkedWorkItem } from "../lib/linkedWorkItemRefresh";
import type { LinkedWorkItem } from "../lib/session";

/** Recovery for links saved before the fork recorded provider account identity. */
export function LinkedWorkItemAccount({ target, cwd, onBind }: {
  target: LinkedWorkItem;
  cwd: string;
  onBind: (account: string, site: string) => boolean;
}) {
  const [connection, setConnection] = useState<{ account: string; accountId: string; site: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const epoch = ++generation.current;
    let cancelled = false;
    setConnection(undefined);
    setError("");
    setBusy(false);
    const refresh = () => setRevision(value => value + 1);
    const event = target.provider === "jira" ? JIRA_CHANGE_EVENT : AZURE_CHANGE_EVENT;
    window.addEventListener(event, refresh);
    void (target.provider === "jira" ? jiraConnected() : azureConnected()).then(status => {
      if (cancelled) return;
      if (!status.connected || !status.accountId) throw new Error("Connect this provider in Settings, then retry.");
      const site = new URL(status.site);
      const saved = new URL(target.url);
      if (saved.origin !== site.origin || !saved.pathname.startsWith(`${site.pathname.replace(/\/$/, "")}/`)) {
        throw new Error("The connected account belongs to a different site. Connect an account for the saved link in Settings, then retry.");
      }
      setConnection({ account: status.account, accountId: status.accountId, site: status.site });
    }).catch(reason => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); });
    return () => { cancelled = true; if (generation.current === epoch) generation.current++; window.removeEventListener(event, refresh); };
  }, [target.provider, target.url, revision]);

  return <div className="flex max-w-sm flex-col gap-3 text-[12px]">
    <p>This saved link has no account attached. Choose the account to use before loading its activity.</p>
    <p className="break-all text-content/50">{target.url}</p>
    {connection ? <>
      <p className="text-content/70">{connection.account || connection.accountId}<br />{connection.site}</p>
      <button type="button" disabled={busy} className="rounded-md border border-stroke px-3 py-2 hover:bg-content/5 disabled:opacity-50" onClick={() => {
        setBusy(true); setError("");
        const chosen = connection;
        const epoch = generation.current;
        void refreshLinkedWorkItem(cwd, { ...target, account: chosen.accountId, site: chosen.site }).then(item => {
          if (generation.current !== epoch) return;
          if (!item || item.account !== chosen.accountId) throw new Error("The account changed or this item is unavailable. Retry and choose the account again.");
          if (!onBind(chosen.accountId, chosen.site)) throw new Error("The saved link changed. Reopen it before choosing an account.");
        }).catch(reason => { if (generation.current === epoch) setError(String(reason instanceof Error ? reason.message : reason)); }).finally(() => { if (generation.current === epoch) setBusy(false); });
      }}>{busy ? "Checking link…" : `Use ${connection.account || connection.accountId}`}</button>
    </> : !error ? <p role="status">Checking connected account…</p> : null}
    {error ? <p role="alert" className="text-rose-400">{error}</p> : null}
    <button type="button" disabled={busy} className="self-center text-content/60 hover:text-content" onClick={() => setRevision(value => value + 1)}>Retry connection</button>
  </div>;
}
