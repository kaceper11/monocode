import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, FolderOpen, Search } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { MatchText } from "./MatchText";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { isImeComposition } from "../lib/keyboard";
import type { RankedFile } from "../lib/fileIndex";

type Props = {
  files: RankedFile[];
  query: string;
  active: number;
  loading?: boolean;
  /** Paths already attached; picking one of these removes the attachment. */
  attached: ReadonlySet<string>;
  onQuery: (query: string) => void;
  onActive: (index: number) => void;
  onToggle: (file: RankedFile) => void;
  onBrowse: () => void;
  onClose: () => void;
};

/**
 * In-app file attach popover for the composer: ranked project files with a
 * search field, toggled on pick, plus a native-dialog escape hatch for files
 * outside the project. Sits above the composer like the @-mention picker.
 */
export function AttachPicker({
  files,
  query,
  active,
  loading,
  attached,
  onQuery,
  onActive,
  onToggle,
  onBrowse,
  onClose,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    pointer.current.allow = false;
  }, [files]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const onListMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.clientX === pointer.current.x && e.clientY === pointer.current.y) {
      return;
    }
    pointer.current = { x: e.clientX, y: e.clientY, allow: true };
  };

  const onRowEnter = (index: number) => {
    if (!pointer.current.allow) return;
    fromPointer.current = true;
    onActive(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposition(event.nativeEvent)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      fromPointer.current = false;
      onActive(files.length ? (active + 1) % files.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      fromPointer.current = false;
      onActive(
        files.length ? (active - 1 + files.length) % files.length : 0,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const file = files[active];
      if (file) onToggle(file);
      else onBrowse();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  const empty = loading
    ? "Indexing files…"
    : query.trim()
      ? "No matching files"
      : "No project files";

  return (
    <div
      ref={rootRef}
      data-attach-picker
      className="overflow-hidden rounded-lg border border-content/10 bg-content/5 backdrop-blur-xl"
    >
      <label className="flex items-center gap-2 border-b border-content/10 px-2.5 py-2 text-content/50">
        <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-label="Attach files"
          placeholder="Attach files"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
            onActive(0);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
        />
      </label>
      {files.length === 0 ? (
        <p className="px-3 py-2.5 text-[12px] text-content/50">{empty}</p>
      ) : (
        <div
          ref={lockOverscroll}
          role="listbox"
          aria-label="Files"
          onMouseMove={onListMouseMove}
          className="max-h-[min(240px,40vh)] overflow-y-auto overscroll-none px-1 py-1"
        >
          {files.map((file, index) => {
            const highlighted = index === active;
            const isAttached = attached.has(file.path);
            const slash = file.relative.lastIndexOf("/");
            const dir = slash === -1 ? "" : file.relative.slice(0, slash);
            const nameOffset = slash === -1 ? 0 : slash + 1;
            const namePositions = file.positions
              .filter((pos) => pos >= nameOffset)
              .map((pos) => pos - nameOffset);
            return (
              <button
                key={file.path}
                ref={highlighted ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={highlighted}
                title={file.relative}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onRowEnter(index)}
                onClick={() => onToggle(file)}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-none ${
                  highlighted ? "bg-content/10 text-content" : "text-content"
                }`}
              >
                <span className="shrink-0">
                  <FileTypeIcon name={file.name} isDir={false} size={15} />
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${
                    highlighted ? "text-mention" : ""
                  }`}
                >
                  <MatchText
                    text={file.name}
                    positions={namePositions}
                    active={Boolean(query.trim())}
                  />
                </span>
                {dir ? (
                  <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-content/40">
                    <MatchText
                      text={dir}
                      positions={file.positions.filter((pos) => pos < slash)}
                      active={Boolean(query.trim())}
                    />
                  </span>
                ) : null}
                {isAttached ? (
                  <Check
                    className="size-3.5 shrink-0 text-accent"
                    strokeWidth={2}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <div className="border-t border-content/10 p-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBrowse}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-content/60 hover:bg-content/10 hover:text-content"
        >
          <FolderOpen className="size-3.5 shrink-0" strokeWidth={1.75} />
          Browse files…
        </button>
      </div>
    </div>
  );
}
