import { Terminal } from "@xterm/xterm";
import type { ILink } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "react";
import {
  getPtyStatus,
  killPty,
  resizePty,
  spawnPty,
  subscribePty,
  writePty,
} from "../lib/pty";
import { isOscColorQuery, oscColorReply } from "../lib/terminalChrome";
import {
  defaultTerminalTitle,
  scanOscCwd,
  type TerminalMetaPatch,
} from "../lib/terminalTab";
import { isLightScheme, SCHEME_CHANGE_EVENT } from "../lib/appearance";
import { isLocalhostUrl, requestLinkChoice } from "../lib/browser";
import { homeDir } from "../lib/fs";
import {
  applyTerminalChrome,
  fitTerminal,
  resetGridStretch,
  type TerminalFitMode,
} from "../lib/terminalLayout";
import { IS_MAC } from "../lib/platform";
import type { TerminalCommand } from "../lib/layout";
import "@xterm/xterm/css/xterm.css";

type Props = {
  id: string;
  cwd: string;
  active: boolean;
  onMetaChange?: (patch: TerminalMetaPatch) => void;
  /** Saved command bound to this terminal — written to the PTY once per
   * `runId`; `launched` makes a remount or restart side-effect-free. */
  command?: TerminalCommand;
};

function cssColor(expr: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = expr;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

/** Printed URLs — brackets/quotes can't be part of a link, and trailing
 * punctuation is almost always prose, not the target. */
const LINK_PATTERN = /https?:\/\/[^\s<>"'()[\]{}]+/g;
const LINK_TRAILING = /[.,;:!?'")\]}>]+$/;

function cssHexColor(expr: string, fallback: string): string {
  const color = cssColor(expr, fallback);
  if (/^#[\da-f]{6}$/i.test(color)) return color;
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length < 3 || channels.some(Number.isNaN)) {
    return fallback;
  }
  return `#${channels
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const ANSI_DARK = {
  black: "#1d2428",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e8eef2",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

// One-Light-family palette tuned for a near-white canvas.
const ANSI_LIGHT = {
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#4078f2",
  magenta: "#a626a4",
  cyan: "#0184bc",
  white: "#fafafa",
  brightBlack: "#7c8591",
  brightRed: "#df6b60",
  brightGreen: "#68b567",
  brightYellow: "#d19a2f",
  brightBlue: "#5c89f5",
  brightMagenta: "#b54bb3",
  brightCyan: "#1f9cc9",
  brightWhite: "#ffffff",
};

function terminalTheme(light: boolean) {
  return {
    background: "#00000000",
    foreground: cssColor("var(--color-content)", light ? "#2e2e2e" : "#e8eef2"),
    cursor: cssColor("var(--color-accent)", light ? "#4078f2" : "#4da3f5"),
    cursorAccent: light ? "#ffffff" : "#000000",
    selectionBackground: light ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.18)",
    selectionInactiveBackground: light
      ? "rgba(0,0,0,0.08)"
      : "rgba(255,255,255,0.08)",
    ...(light ? ANSI_LIGHT : ANSI_DARK),
  };
}

/** The newest spawn owns the id: a StrictMode/remount ghost cleanup must not
 * kill the replacement PTY once its own spawn promise finally settles. */
const latestSpawn = new Map<string, Promise<void>>();

function monoFont(): string {
  const fromCss = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return fromCss || "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";
}

function oscColors() {
  const light = isLightScheme();
  return {
    fg: cssHexColor(
      "var(--color-content)",
      light ? "#2e2e2e" : "#ebebeb",
    ),
    bg: cssHexColor(
      "var(--color-background-base)",
      light ? "#f7f7f7" : "#171717",
    ),
    cursor: cssHexColor(
      "var(--color-accent)",
      light ? "#4078f2" : "#4da3f5",
    ),
  };
}

export function TerminalView({ id, cwd, active, onMetaChange, command }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const spawned = useRef(false);
  const startingRef = useRef<Promise<void>>(Promise.resolve());
  /** Spawn routine the mount effect installs; the step runner drives it. */
  const startPtyRef = useRef<(exec: string | undefined, dir: string) => Promise<void>>(
    () => Promise.reject(new Error("Terminal is not mounted")),
  );
  /** Resolved by the next PTY exit while a command step is in flight. */
  const exitWaiterRef = useRef<((code: number | null) => void) | null>(null);
  /** Whether a PTY is live or its spawn is in flight — set/cleared by the
   * mount effect's spawn/exit handlers so the command effect can tell a dead
   * terminal from one that is merely still starting. */
  const ptyLiveRef = useRef(false);
  const applySizeRef = useRef<() => void>(() => {});
  const onMetaChangeRef = useRef(onMetaChange);
  onMetaChangeRef.current = onMetaChange;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const runningProcessRef = useRef<string | null>(null);

  useEffect(() => {
    const outer = outerRef.current;
    const host = hostRef.current;
    if (!outer || !host) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: monoFont(),
      fontSize: 13,
      lineHeight: 1,
      letterSpacing: 0,
      scrollback: 5000,
      allowTransparency: true,
      smoothScrollDuration: 0,
      theme: terminalTheme(isLightScheme()),
      macOptionIsMeta: IS_MAC,
    });
    term.open(host);
    termRef.current = term;
    let closed = false;

    const onCopy = (event: ClipboardEvent) => {
      const text = term.getSelection();
      if (!text) return;
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      term.paste(text);
    };
    host.addEventListener("copy", onCopy);
    host.addEventListener("paste", onPaste);

    term.attachCustomKeyEventHandler((event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return true;
      const key = event.key.toLowerCase();
      if (key === "c") {
        if (term.hasSelection()) return false;
        if (event.metaKey && !event.ctrlKey) return false;
        return true;
      }
      if (key === "v") return false;
      return true;
    });

    // Explicit click on a printed http(s) link: loopback targets ask where
    // to open (preview vs system browser); anything else opens externally.
    // Never automatic — activation is always a user gesture.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: ILink[] = [];
        for (const match of text.matchAll(LINK_PATTERN)) {
          const url = match[0].replace(LINK_TRAILING, "");
          if (!url) continue;
          const startX = match.index + 1;
          links.push({
            range: {
              start: { x: startX, y },
              end: { x: startX + url.length - 1, y },
            },
            text: url,
            activate(event, target) {
              if (isLocalhostUrl(target)) {
                requestLinkChoice({
                  url: target,
                  x: event.clientX,
                  y: event.clientY,
                  cwd: cwdRef.current,
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

    let oscBuffer = "";
    // Per-mount streaming decoder — shared state would leak partial codepoints
    // between terminals, and a fresh decoder per chunk splits UTF-8.
    const decoder = new TextDecoder();
    // Bumped on every PTY exit so a spawn resolving after its process already
    // died cannot flip `spawned` back on.
    let exitStamp = 0;

    const unsubscribe = subscribePty(
      id,
      (data) => {
        const onMeta = onMetaChangeRef.current;
        if (onMeta) {
          const text = decoder.decode(data, { stream: true });
          const scanned = scanOscCwd(text, oscBuffer);
          oscBuffer = scanned.rest;
          if (scanned.cwd) {
            const patch: TerminalMetaPatch = { cwd: scanned.cwd };
            if (!runningProcessRef.current) {
              patch.title = defaultTerminalTitle(scanned.cwd);
            }
            onMeta(patch);
          }
        }
        term.write(data);
      },
      (code) => {
        if (closed) return;
        exitStamp++;
        spawned.current = false;
        ptyLiveRef.current = false;
        runningProcessRef.current = null;
        const waiter = exitWaiterRef.current;
        exitWaiterRef.current = null;
        if (!waiter) {
          const status = code == null ? "" : ` (${code})`;
          term.writeln(`\r\n[process exited${status}]`);
        }
        // The shell is gone — a dead terminal must not stay "running" or a
        // bound command could never re-run.
        onMetaChangeRef.current?.({
          foreground: null,
          title: defaultTerminalTitle(cwd),
        });
        waiter?.(code);
      },
    );

    // Every spawn this mount owns, so unmount kills whichever one is live
    // while a newer mount's spawn stays untouched.
    const myStarts = new Set<Promise<void>>();
    const startPty = (exec: string | undefined, dir: string) => {
      const stamp = exitStamp;
      ptyLiveRef.current = true;
      const starting = spawnPty(id, dir, term.cols, term.rows, exec)
        .then(() => {
          if (!closed && exitStamp === stamp) spawned.current = true;
        })
        .catch((error) => {
          spawned.current = false;
          ptyLiveRef.current = false;
          if (!closed) {
            const message =
              error instanceof Error ? error.message : String(error);
            term.writeln(`\x1b[31m${message}\x1b[0m`);
          }
          throw error;
        });
      myStarts.add(starting);
      startingRef.current = starting;
      latestSpawn.set(id, starting);
      void starting.catch(() => undefined);
      return starting;
    };
    startPtyRef.current = startPty;

    // A steps run spawns each step itself — only open an interactive shell
    // when nothing is pending.
    const stepsPending =
      !!command?.steps?.length &&
      (command.launched ?? 0) < command.runId &&
      command.failed !== command.runId;
    const starting = stepsPending
      ? Promise.resolve()
      : startPty(undefined, cwd);

    const dataSub = term.onData((data) => {
      void starting
        .then(() => (closed ? undefined : writePty(id, data)))
        .catch(() => undefined);
    });

    const replyOsc = (code: 10 | 11 | 12, hex: string) => {
      const reply = oscColorReply(code, hex);
      if (reply) {
        void starting
          .then(() => (closed ? undefined : writePty(id, reply)))
          .catch(() => undefined);
      }
      return true;
    };
    const oscFg = term.parser.registerOscHandler(10, (data) =>
      isOscColorQuery(data) ? replyOsc(10, oscColors().fg) : false,
    );
    const oscBg = term.parser.registerOscHandler(11, (data) =>
      isOscColorQuery(data) ? replyOsc(11, oscColors().bg) : false,
    );
    const oscCursor = term.parser.registerOscHandler(12, (data) =>
      isOscColorQuery(data) ? replyOsc(12, oscColors().cursor) : false,
    );

    const onSchemeChange = () => {
      term.options.theme = terminalTheme(isLightScheme());
    };
    window.addEventListener(SCHEME_CHANGE_EVENT, onSchemeChange);

    term.attachCustomWheelEventHandler(() => {
      if (term.element?.classList.contains("enable-mouse-events")) return true;
      return term.buffer.active.type !== "alternate";
    });

    let lastCols = 0;
    let lastRows = 0;
    let raf = 0;
    let tuiMode = false;

    const fitMode = (): TerminalFitMode =>
      term.buffer.active.type === "alternate" ? "tui" : "shell";

    const syncAltScreenMode = () => {
      const next = fitMode() === "tui";
      if (next === tuiMode) return;
      tuiMode = next;
      applyTerminalChrome(term, outer, next);
      if (!next) resetGridStretch(term);
      lastCols = 0;
      lastRows = 0;
      schedule();
    };

    const applySize = () => {
      if (closed) return;
      const next = fitTerminal(term, host, fitMode());
      if (!next) return;
      const { cols, rows } = next;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      void starting
        .then(() => (closed ? undefined : resizePty(id, cols, rows)))
        .catch(() => {
          // A dead PTY rejects every resize — keep the attempted size so a
          // blinking cursor doesn't re-issue a doomed invoke each frame.
          if (spawned.current) {
            lastCols = 0;
            lastRows = 0;
          }
        });
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applySize();
      });
    };

    applySizeRef.current = applySize;
    const renderSub = term.onRender(() => {
      if (!spawned.current) applySize();
    });
    const bufferSub = term.buffer.onBufferChange(syncAltScreenMode);
    syncAltScreenMode();
    const frame = requestAnimationFrame(applySize);
    const observer = new ResizeObserver(schedule);
    observer.observe(host);

    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      outer.classList.remove("monocode-terminal--alt-screen");
      applySizeRef.current = () => {};
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("paste", onPaste);
      window.removeEventListener(SCHEME_CHANGE_EVENT, onSchemeChange);
      dataSub.dispose();
      oscFg.dispose();
      oscBg.dispose();
      oscCursor.dispose();
      renderSub.dispose();
      bufferSub.dispose();
      unsubscribe();
      // Spawns this mount started may still be in flight — wait for all of
      // them before killing so `pty_kill` never races ahead of a host insert
      // and an in-flight spawn can't land orphaned afterwards. A newer
      // mount's spawn is not ours and must survive.
      void Promise.allSettled([...myStarts])
        .then(() => {
          const live = latestSpawn.get(id);
          if (!live || !myStarts.has(live)) return;
          latestSpawn.delete(id);
          void killPty(id);
        });
      // Wake a step runner blocked on a PTY exit so it can bail out.
      exitWaiterRef.current?.(null);
      exitWaiterRef.current = null;
      term.dispose();
      termRef.current = null;
      spawned.current = false;
      ptyLiveRef.current = false;
    };
  }, [id]);

  // Identity-stable: the callers pass an inline arrow, so depending on the
  // prop itself would tear down and re-arm the poll — and re-fork `ps` — on
  // every parent render.
  const wantsMeta = !!onMetaChange;

  useEffect(() => {
    if (!wantsMeta) return;
    let lastForeground: string | null = null;
    let inFlight = false;
    const refresh = () => {
      if (!spawned.current) return;
      // Each status read forks `ps`; an off-screen window has no title to paint.
      if (document.hidden) return;
      if (inFlight) return;
      inFlight = true;
      void getPtyStatus(id)
        .then(({ foreground }) => {
          const fg = foreground?.trim() || null;
          runningProcessRef.current = fg;
          if (fg === lastForeground) return;
          lastForeground = fg;
          onMetaChangeRef.current?.(
            fg
              ? { title: fg, foreground: fg }
              : { title: defaultTerminalTitle(cwd), foreground: null },
          );
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [id, cwd, wantsMeta]);

  // A bound saved command is written to the PTY exactly once per runId.
  // `launched` is persisted through the meta patch, so remounting the view or
  // restarting the app re-shows the terminal without re-running the command.
  // Deps are deliberately narrow — progress/launched meta patches rebuild the
  // `command` object on every merge and must not retrigger a running sequence.
  const commandRunId = command?.runId;
  const commandText = command?.text;
  const commandSteps = command?.steps;
  useEffect(() => {
    if (
      !command ||
      (command.launched ?? 0) >= command.runId ||
      command.failed === command.runId
    ) {
      // Nothing is pending — a run finished elsewhere or the binding was
      // cleared could leave this tab without any PTY. Make sure a shell
      // exists, but don't fight a spawn that is already in flight.
      if (!ptyLiveRef.current) {
        void startPtyRef.current(undefined, cwd).catch(() => undefined);
      }
      return;
    }
    const pending = command;
    let cancelled = false;
    const steps = pending.steps;
    if (steps?.length) {
      const runId = pending.runId;
      let done = pending.step?.runId === runId ? pending.step.done : 0;
      let myWaiter: ((code: number | null) => void) | null = null;
      // Only disarm the shared slot while it still holds this runner's
      // resolver — a remount arms a new one we must not clear.
      const clearWaiter = () => {
        if (myWaiter && exitWaiterRef.current === myWaiter) {
          exitWaiterRef.current = null;
        }
        myWaiter = null;
      };
      const note = (text: string, color: 2 | 31 = 2) =>
        termRef.current?.writeln(`\r\n\x1b[${color}m${text}\x1b[0m`);
      const respawnShell = () => {
        void startPtyRef.current(undefined, cwd).catch(() => undefined);
      };
      const fail = (text: string) => {
        note(text, 31);
        // `launched` is set too: the run is over, so `runId > launched` must
        // not pin the launch-pending guard forever.
        onMetaChangeRef.current?.({
          command: { failed: runId, launched: runId, step: { runId, done } },
        });
        respawnShell();
      };
      void (async () => {
        // A mount-time interactive spawn can still be in flight — if it lands
        // after a step PTY it would silently replace it, so serialize.
        await startingRef.current.catch(() => undefined);
        for (let i = done; i < steps.length; i++) {
          if (cancelled || !termRef.current) return;
          const step = steps[i];
          let dir = cwd;
          if (step.host === "native") {
            // OS host home — where wsl.exe/diskpart actually belong when the
            // resolved target lives inside WSL. A failed lookup must NOT fall
            // back to `cwd`: that could land the step inside WSL, the host it
            // explicitly means to avoid.
            try {
              dir = await homeDir();
            } catch {
              fail(`step ${i + 1} needs the OS host, but its directory is unavailable`);
              return;
            }
          }
          if (cancelled || !termRef.current) return;
          note(
            `── step ${i + 1}/${steps.length}${step.host === "native" ? " (OS host)" : ""}: ${step.command}`,
          );
          const exited = new Promise<number | null>((resolve) => {
            myWaiter = resolve;
            exitWaiterRef.current = resolve;
          });
          try {
            await startPtyRef.current(step.command, dir);
          } catch {
            clearWaiter();
            if (!cancelled && termRef.current) fail(`step ${i + 1} failed to start`);
            return;
          }
          const code = await exited;
          myWaiter = null;
          if (cancelled || !termRef.current) return;
          if (code !== 0) {
            fail(
              code == null
                ? `step ${i + 1} was interrupted`
                : `step ${i + 1} failed (${code})`,
            );
            return;
          }
          done = i + 1;
          onMetaChangeRef.current?.({
            command: { step: { runId, done } },
          });
        }
        if (cancelled || !termRef.current) return;
        onMetaChangeRef.current?.({ command: { launched: runId } });
        note("── all steps finished");
        // Hand an interactive shell back so the tab stays usable.
        respawnShell();
      })();
      return () => {
        cancelled = true;
        // Wake the runner so its continuation can bail, and disarm the slot
        // so a late step exit still prints its marker.
        const waiter = myWaiter;
        clearWaiter();
        waiter?.(null);
      };
    }
    void startingRef.current
      .then(async () => {
        const dead = () => {
          // The run can never land — record it as failed so `runId >
          // launched` doesn't pin the launch-pending guard forever, and so a
          // remount doesn't silently retry a write of uncertain delivery.
          if (!cancelled) {
            onMetaChangeRef.current?.({
              command: { failed: pending.runId, launched: pending.runId },
            });
          }
        };
        if (cancelled) return;
        if (!spawned.current) return dead();
        try {
          await writePty(id, `${pending.text}\r`);
          if (!cancelled) {
            onMetaChangeRef.current?.({ command: { launched: pending.runId } });
          }
        } catch {
          dead();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, commandRunId, commandText, commandSteps]);

  useEffect(() => {
    if (!active) return;
    applySizeRef.current();
    termRef.current?.focus();
  }, [active]);

  return (
    <div
      ref={outerRef}
      className="monocode-terminal flex h-full w-full min-h-0 min-w-0 flex-col"
      onMouseDown={() => termRef.current?.focus()}
    >
      <div
        ref={hostRef}
        className="monocode-terminal-host min-h-0 min-w-0 flex-1 overflow-hidden"
      />
    </div>
  );
}
