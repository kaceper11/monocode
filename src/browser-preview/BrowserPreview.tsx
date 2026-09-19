import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
} from "../chrome/icons";
import "./preview.css";

type Notice = { url: string | null; message: string };

export function BrowserPreview() {
  const [address, setAddress] = useState("");
  const [hasPage, setHasPage] = useState(false);
  const [message, setMessage] = useState(
    "Open a development URL. Preview runs on this computer; WSL networking must be available separately.",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const listener = getCurrentWebview().listen<Notice>(
      "browser-preview-state",
      ({ payload }) => {
        if (payload.url && payload.url !== "about:blank") {
          setHasPage(true);
          if (document.activeElement !== input.current) setAddress(payload.url);
        }
        setMessage(payload.message);
      },
    );
    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, []);

  async function action(name: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("browser_preview_action", {
        action: name,
        url: name === "navigate" ? address.trim() : null,
      });
      if (name === "navigate") input.current?.blur();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action("navigate");
        }}
      >
        <button
          type="button"
          title="Back"
          aria-label="Back"
          disabled={!hasPage || busy}
          onClick={() => void action("back")}
        >
          <ChevronLeft />
        </button>
        <button
          type="button"
          title="Forward"
          aria-label="Forward"
          disabled={!hasPage || busy}
          onClick={() => void action("forward")}
        >
          <ChevronRight />
        </button>
        <button
          type="button"
          title="Reload"
          aria-label="Reload"
          disabled={!hasPage || busy}
          onClick={() => void action("reload")}
        >
          <RefreshCw />
        </button>
        <input
          ref={input}
          autoFocus
          aria-label="Preview URL"
          type="url"
          placeholder="http://localhost:3000"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
        <button type="submit" className="go" disabled={busy || !address.trim()}>
          Go
        </button>
        <button
          type="button"
          title="Open externally"
          aria-label="Open externally"
          disabled={!hasPage || busy}
          onClick={() => void action("external")}
        >
          <ExternalLink />
        </button>
      </form>
      <p role={error ? "alert" : "status"} className={error ? "error" : ""}>
        {error || message}
      </p>
    </main>
  );
}
