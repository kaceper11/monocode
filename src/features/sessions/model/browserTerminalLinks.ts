import type { Terminal, ILink } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isLocalhostUrl, requestLinkChoice } from "./browser";

const LINK_PATTERN = /https?:\/\/[^\s<>"'()[\]{}]+/g;
const LINK_TRAILING = /[.,;:!?'")\]}>]+$/;

/** Browser-owned activation for URLs printed by a terminal. */
export function registerBrowserTerminalLinks(term: Terminal, cwd: () => string) {
  return term.registerLinkProvider({
      provideLinks(y, callback) {
        const buffer = term.buffer.active;
        let first = y - 1;
        // Bound context from a single long, wrapped output line.
        while (first > 0 && buffer.getLine(first)?.isWrapped) {
          first--;
          if ((y - first) * term.cols > 8192) { callback(undefined); return; }
        }
        let text = "";
        const columns: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [];
        for (let row = first; row < buffer.length; row++) {
          const line = buffer.getLine(row);
          if (!line) break;
          const wrapped = buffer.getLine(row + 1)?.isWrapped;
          const chunk = line.translateToString(!wrapped);
          if (text.length + chunk.length > 8192) { callback(undefined); return; }
          // Regex offsets count UTF-16 units; xterm ranges count screen cells.
          for (let x = 0, units = 0; x < line.length && units < chunk.length;) {
            const cell = line.getCell(x);
            if (!cell) break;
            const width = Math.max(1, cell.getWidth());
            const count = cell.getChars().length || 1;
            for (let i = 0; i < count; i++)
              columns.push({ start: { x: x + 1, y: row + 1 }, end: { x: x + width, y: row + 1 } });
            units += count;
            x += width;
          }
          text += chunk;
          if (!wrapped) break;
        }
        const links: ILink[] = [];
        for (const match of text.matchAll(LINK_PATTERN)) {
          const url = match[0].replace(LINK_TRAILING, "");
          if (!url) continue;
          const start = columns[match.index]?.start;
          const end = columns[match.index + url.length - 1]?.end;
          if (!start || !end || y < start.y || y > end.y) continue;
          links.push({
            range: { start, end },
            text: url,
            activate(event, target) {
              if (isLocalhostUrl(target)) {
                requestLinkChoice({
                  url: target,
                  x: event.clientX,
                  y: event.clientY,
                  cwd: cwd(),
                });
              } else {
                void openUrl(target).catch(() => undefined);
              }
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });
}
