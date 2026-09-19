import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe } from "./icons";
import { Modal } from "./Modal";

export function BrowserPreviewButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("browser_preview_open");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        aria-label="Open browser preview"
        title="Open browser preview"
        disabled={busy}
        onClick={() => void open()}
        className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-content/60 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-content disabled:opacity-40"
      >
        <Globe className="size-3.5" strokeWidth={1.75} aria-hidden />
        <span>Browser</span>
      </button>
      {error ? (
        <Modal
          title="Browser preview could not open"
          size="sm"
          onClose={() => setError("")}
        >
          <p role="alert" className="p-4 text-sm text-content">
            {error}
          </p>
        </Modal>
      ) : null}
    </>
  );
}
