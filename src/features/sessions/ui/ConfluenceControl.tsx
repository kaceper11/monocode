import { useEffect, useState } from "react";
import type { AgentContext } from "../model/agentContext";
import { atlassianCapable, jiraConnected, JIRA_CHANGE_EVENT } from "../model/jira";
import { FilePlus } from "../../../shared/ui/icons.tsx";
import { ConfluencePicker } from "./ConfluencePicker";

/** Connection visibility belongs to the integration, not the composer layout. */
export function useConfluenceControl({ enabled, owner, onOpen, onAdd }: {
  owner: string;
  onOpen: () => void;
  enabled: boolean;
  onAdd: (context: AgentContext) => void;
}) {
  const [connected, setConnected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setOpen(null);
    setConnected(null);
    if (!enabled) return;
    let disposed = false;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void jiraConnected().then(status => {
        if (disposed || current !== request) return;
        const available = status.connected && !!status.accountId && atlassianCapable(status, "Confluence");
        setConnected(available ? owner : null);
        if (!available) setOpen(null);
      }).catch(() => {
        if (disposed || current !== request) return;
        setConnected(null);
        setOpen(null);
      });
    };
    refresh();
    window.addEventListener(JIRA_CHANGE_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener(JIRA_CHANGE_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, owner]);
  const available = enabled && connected === owner;
  return {
    button: available ? <button type="button" title="Add Confluence pages" aria-label="Add Confluence pages" onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(owner); onOpen(); }} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10">
      <FilePlus className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <span className="block text-[13px]">Confluence</span>
        <span className="block text-[11px] leading-4 text-content/45">Attach pages to this message</span>
      </span>
    </button> : null,
    picker: available && open === owner ? <ConfluencePicker key={owner} onClose={() => setOpen(null)} onAdd={onAdd} /> : null,
  };
}
