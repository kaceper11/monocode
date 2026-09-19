import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { InboxCheck, InboxChecksPage } from "../lib/inboxProvider";

/** Shared check rows; each provider owns identity, pagination, and log reads. */
export function InboxChecks({
  load,
}: {
  load: () => Promise<InboxChecksPage>;
}) {
  const [page, setPage] = useState<InboxChecksPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setPage(null);
    setBusy(true);
    setError(null);
    void load()
      .then(
        (next) => {
          if (current === generation.current) setPage(next);
        },
        (reason) => {
          if (current === generation.current) setError(String(reason));
        },
      )
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      ++generation.current;
    };
  }, [load]);
  const more = async () => {
    if (!page?.more || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await page.more();
      if (current === generation.current)
        setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Checks"
      aria-busy={busy}
      className="flex flex-col gap-3 text-[12px]"
    >
      {page?.items.map((row) => (
        <CheckRow key={row.id} row={row} />
      ))}
      {busy ? <p className="text-content/45">Loading checks…</p> : null}
      {error ? (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      ) : null}
      {page && !page.items.length && !page.more ? (
        <p className="text-content/45">No checks reported</p>
      ) : null}
      {page?.more ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void more()}
          className="self-start rounded px-2 py-1 hover:bg-content/5"
        >
          More checks
        </button>
      ) : null}
    </section>
  );
}
function CheckRow({ row }: { row: InboxCheck }) {
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-content/10 p-3">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 break-words">{row.name}</span>
        <span className="shrink-0 text-content/50">{row.status}</span>
        {row.url?.startsWith("https://") ? (
          <button
            type="button"
            onClick={() => void openUrl(row.url!)}
            className="hover:underline"
          >
            Open
          </button>
        ) : null}
        {row.log ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (log !== null) {
                setLog(null);
                return;
              }
              setBusy(true);
              setError(null);
              try {
                setLog(await row.log!());
              } catch (reason) {
                setError(String(reason));
              } finally {
                setBusy(false);
              }
            }}
            className="shrink-0 hover:underline"
          >
            {busy ? "Loading…" : log === null ? "View log" : "Hide log"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-red-400">
          {error}
        </p>
      ) : null}
      {log !== null ? (
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
          {log}
        </pre>
      ) : null}
    </div>
  );
}
