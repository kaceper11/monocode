import { Loader, WandSparkles } from "./icons";
import { useEffect, useRef, useState } from "react";
import { DIALOG_ACTION } from "./controls";
import { Modal } from "./Modal";
import { generateCommitMessage } from "../lib/harness";
import { MOD } from "../lib/platform";

type Busy = "stash" | "commit" | null;

type Props = {
  cwd: string;
  branch: string;
  creating?: boolean;
  busy: Busy;
  error?: string | null;
  onStash: () => void;
  onCommit: (message: string) => void;
  onCancel: () => void;
};

export function SwitchBranchDialog({
  cwd,
  branch,
  creating = false,
  busy,
  error,
  onStash,
  onCommit,
  onCancel,
}: Props) {
  const [message, setMessage] = useState("");
  const [generateError, setGenerateError] = useState("");
  const [generating, setGenerating] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = message.trim();
  const canCommit = trimmed.length > 0 && !busy && !generating;

  useEffect(() => {
    messageRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = messageRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [message]);

  const generate = async () => {
    if (busy || generating) return;
    setGenerating(true);
    setGenerateError("");
    try {
      setMessage(await generateCommitMessage(cwd));
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      messageRef.current?.focus();
    }
  };

  const close = () => {
    if (!busy && !generating) onCancel();
  };

  return (
    <Modal
      title="Uncommitted changes"
      size="sm"
      trapFocus
      onClose={close}
      className="text-[13px]"
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        <p className="text-[12px] leading-snug text-content/55">
          {creating
            ? `Creating “${branch}” would overwrite your local changes. Stash them for later, or commit them on this branch first.`
            : `Switching to “${branch}” would overwrite your local changes. Stash them for later, or commit them on this branch first.`}
        </p>

        <div className="relative">
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            placeholder={`Message (${MOD}↩ to commit)`}
            disabled={Boolean(busy) || generating}
            aria-label="Commit message"
            className="max-h-40 w-full resize-none overflow-y-auto rounded-md bg-content/10 py-1 pr-8 pl-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/35 disabled:opacity-40"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                canCommit
              ) {
                event.preventDefault();
                onCommit(trimmed);
              }
            }}
          />
          <button
            type="button"
            title="Generate commit message"
            aria-label="Generate commit message"
            disabled={Boolean(busy) || generating}
            onClick={() => void generate()}
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-content/10 text-content hover:bg-content/20 hover:text-content disabled:opacity-40"
          >
            {generating ? (
              <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <WandSparkles className="size-3" strokeWidth={1} />
            )}
          </button>
        </div>

        {error || generateError ? (
          <p
            role="alert"
            className="whitespace-pre-wrap text-[11px] leading-4 text-red-400/90"
          >
            {generateError || error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={Boolean(busy) || generating}
            onClick={onCancel}
            className={DIALOG_ACTION.ghost}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => onCommit(trimmed)}
            className={`inline-flex items-center gap-1.5 ${DIALOG_ACTION.tonal}`}
          >
            {busy === "commit" ? (
              <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : null}
            Commit & switch
          </button>
          <button
            type="button"
            disabled={Boolean(busy) || generating}
            onClick={onStash}
            className={`inline-flex items-center gap-1.5 ${DIALOG_ACTION.primary}`}
          >
            {busy === "stash" ? (
              <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : null}
            Stash & switch
          </button>
        </div>
      </div>
    </Modal>
  );
}
