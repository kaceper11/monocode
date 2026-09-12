import { useRef, useState } from "react";
import { FileDiff, GitCompare } from "./icons";
import { Popover } from "./Popover";
import { collisionLabel, type CollisionFile } from "../lib/worktreeCollisions";

const MAX_FILES = 12;
const MAX_SESSIONS = 2;

/**
 * Compact mark for a working copy whose changed files overlap a sibling's.
 * A real button (keyboard + screen-reader reachable, icon plus count — not
 * color-only) whose popover lists each shared path, the other worktree and
 * its bound sessions. Never modal, never blocking.
 */
export function WorktreeCollisionBadge({
  files,
  className = "",
}: {
  files: readonly CollisionFile[] | null;
  className?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!files?.length) return null;
  const label = collisionLabel(files);
  return (
    <>
      <button
        type="button"
        ref={anchor}
        data-no-drag
        data-tauri-drag-region="false"
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={`flex h-4 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] tabular-nums text-amber-400 outline-none hover:bg-amber-400/15 focus-visible:ring-1 focus-visible:ring-amber-400/60 [.theme-light_&]:text-amber-700 ${className}`}
      >
        <GitCompare className="size-3 shrink-0" strokeWidth={1.75} />
        {files.length > 99 ? "99+" : files.length}
      </button>
      {open && (
        <Popover
          anchor={anchor}
          side="right"
          width={320}
          maxHeight={320}
          autoFocus
          tabIndex={-1}
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") anchor.current?.focus();
          }}
          role="dialog"
          aria-label="Files changed in other worktrees"
          className="flex flex-col overflow-hidden"
        >
          <p className="border-b border-content/10 px-3 py-2 text-[11px] leading-snug text-content/50">
            Changed in other worktrees — a shared file is a hint, not a
            guaranteed conflict.
          </p>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {files.slice(0, MAX_FILES).map((file) => (
              <li key={file.relative} className="px-3 py-1">
                <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-content/80">
                  <FileDiff
                    className="size-3 shrink-0 text-content/40"
                    strokeWidth={1.5}
                  />
                  <span
                    className="min-w-0 truncate font-mono"
                    title={file.relative}
                  >
                    {file.relative}
                  </span>
                </p>
                {file.peers.map((peer) => (
                  <p
                    key={peer.path}
                    className="truncate pl-5 text-[11px] leading-snug text-content/50"
                    title={`${peer.path}${peer.committed ? " · committed on that branch" : ""}${peer.sessions.length ? `\n${peer.sessions.join(", ")}` : ""}`}
                  >
                    also in <span className="text-content/75">{peer.name}</span>
                    {peer.committed ? " · committed" : ""}
                    {peer.sessions.length
                      ? ` · ${peer.sessions.slice(0, MAX_SESSIONS).join(", ")}${
                          peer.sessions.length > MAX_SESSIONS
                            ? ` +${peer.sessions.length - MAX_SESSIONS}`
                            : ""
                        }`
                      : ""}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {files.length > MAX_FILES ? (
            <p className="border-t border-content/10 px-3 py-1.5 text-[11px] text-content/40">
              +{files.length - MAX_FILES} more
            </p>
          ) : null}
        </Popover>
      )}
    </>
  );
}
