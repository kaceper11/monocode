import { useState } from "react";
import { Modal } from "./Modal";
import { composeAgentContext, type AgentContext } from "../lib/agentContext";
import { BROWSER_CONTEXT_ADDED, useBrowserContextTargets, type BrowserContextTarget } from "../lib/browserContext";
import { HARNESS_TITLE, harnessSupportsAttachments, type Session } from "../lib/session";
import { prettyCwd } from "../lib/paths";

export function BrowserContextPicker({ context, sessions, onClose }: {
  context: AgentContext;
  sessions: readonly Session[];
  onClose: () => void;
}) {
  const targets = useBrowserContextTargets();
  const [selected, setSelected] = useState<BrowserContextTarget | null>(null);
  const [includeImage, setIncludeImage] = useState(true);
  const [error, setError] = useState("");
  const target = selected && targets.includes(selected) ? selected : null;
  const imageSupported = !!target && harnessSupportsAttachments(target.harness);
  return <Modal title="Add browser context" description="Review the captured page, then choose an open conversation. This adds to its draft." onClose={onClose}>
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-[12px]">
        Conversation
        <select aria-label="Destination conversation" value={target?.sessionId ?? ""} onChange={event => {
          setSelected(targets.find(entry => entry.sessionId === event.target.value) ?? null); setError("");
        }} className="h-8 rounded-md border border-content/15 bg-background-base px-2 text-content">
          <option value="">Choose a conversation</option>
          {targets.map(entry => <option key={entry.sessionId} value={entry.sessionId}>
            {sessions.find(session => session.id === entry.sessionId)?.title || "New conversation"} · {HARNESS_TITLE[entry.harness]} · {prettyCwd(entry.cwd)}
          </option>)}
        </select>
      </label>
      {!targets.length ? <p className="text-[12px] text-content/60">Open a conversation to add this context.</p> : null}
      {selected && !target ? <p role="alert" className="text-[12px] text-amber-500">The destination changed or closed. Select it again.</p> : null}
      <pre aria-label="Captured page context" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-content/10 p-3 font-mono text-[11px] text-content/70">{composeAgentContext({ ...context, attachments: [] }, "")}</pre>
      {context.attachments.length ? <>
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={includeImage && imageSupported} disabled={!imageSupported} onChange={event => setIncludeImage(event.target.checked)} />
          Include screenshot{target && !imageSupported ? " (unavailable for this provider)" : ""}
        </label>
        {includeImage && imageSupported && context.attachments[0]?.data ? <img alt="Captured browser page" className="max-h-48 rounded border border-content/10 object-contain" src={`data:image/png;base64,${context.attachments[0].data}`} /> : null}
      </> : null}
      {error ? <p role="alert" className="text-[12px] text-red-400">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-[12px] hover:bg-content/5">Cancel</button>
        <button type="button" disabled={!target} className="rounded bg-content px-3 py-1.5 text-[12px] text-background-base disabled:opacity-40" onClick={() => {
          if (!target) return;
          try { target.accept({ ...context, attachments: includeImage && imageSupported ? context.attachments : [] }); window.dispatchEvent(new CustomEvent(BROWSER_CONTEXT_ADDED, { detail: target.sessionId })); onClose(); }
          catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        }}>Add to draft</button>
      </div>
    </div>
  </Modal>;
}
