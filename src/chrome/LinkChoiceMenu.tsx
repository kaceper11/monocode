import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import {
  isLinkChoiceRequest,
  LINK_CHOICE_EVENT,
  type LinkChoiceRequest,
} from "../lib/browser";
import { copyText } from "../lib/clipboard";
import { ExplorerMenu } from "./ExplorerMenu";

/**
 * The "localhost link choices" menu — a link emitted by a terminal or a chat
 * message was deliberately activated and asks where it should open. Never
 * fires on its own: only an explicit click/activation reaches here.
 */
export function LinkChoiceMenu({
  onOpenBrowser,
}: {
  onOpenBrowser: (url: string, cwd?: string) => void;
}) {
  const [menu, setMenu] = useState<LinkChoiceRequest | null>(null);

  useEffect(() => {
    const listener = (event: Event) => {
      if (!isLinkChoiceRequest(event)) return;
      setMenu(event.detail);
    };
    window.addEventListener(LINK_CHOICE_EVENT, listener);
    return () => window.removeEventListener(LINK_CHOICE_EVENT, listener);
  }, []);

  if (!menu) return null;

  const url = menu.url;
  return (
    <ExplorerMenu
      x={menu.x}
      y={menu.y}
      ariaLabel="Link actions"
      items={[
        { kind: "item", id: "open-browser", label: "Open in Browser" },
        {
          kind: "item",
          id: "open-external",
          label: "Open in Default Browser",
        },
        { kind: "sep" },
        { kind: "item", id: "copy", label: "Copy Link" },
      ]}
      onPick={(id) => {
        setMenu(null);
        if (id === "open-browser") {
          onOpenBrowser(url, menu.cwd);
          return;
        }
        if (id === "copy") {
          void copyText(url).catch(() => undefined);
          return;
        }
        if (id === "open-external") {
          void openUrl(url).catch(() => undefined);
        }
      }}
      onClose={() => setMenu(null)}
    />
  );
}
