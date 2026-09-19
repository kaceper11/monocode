import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "./icons";
import { prettyCwd } from "../lib/paths";
import {
  changeSavedPrompts,
  MAX_PROMPT_TEXT,
  promptAvailable,
  readSavedPrompts,
  savedPromptsSnapshot,
  subscribeSavedPrompts,
  type SavedPrompt,
} from "../lib/savedPrompts";

export function SavedPromptsPicker({
  cwd,
  onAdd,
  onClose,
}: {
  cwd: string;
  onAdd: (text: string) => void;
  onClose: () => void;
}) {
  const snapshot = useSyncExternalStore(
    subscribeSavedPrompts,
    savedPromptsSnapshot,
    savedPromptsSnapshot,
  );
  const store = useMemo(() => {
    try {
      return { prompts: readSavedPrompts(snapshot), error: "" };
    } catch (reason) {
      return {
        prompts: [] as SavedPrompt[],
        error: String(reason instanceof Error ? reason.message : reason),
      };
    }
  }, [snapshot]);
  const [editing, setEditing] = useState<{
    prompt: SavedPrompt;
    snapshot: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const operation = useRef(0);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  const prompt = editing?.prompt;
  const stale = !!editing && editing.snapshot !== snapshot;
  const update = (patch: Partial<SavedPrompt>) => {
    if (editing)
      setEditing({ ...editing, prompt: { ...editing.prompt, ...patch } });
  };
  const mutate = async (
    change: (prompts: SavedPrompt[]) => SavedPrompt[],
    keep = false,
  ) => {
    const owner = ++operation.current;
    setPending(true);
    setError("");
    try {
      const next = await changeSavedPrompts(
        editing?.snapshot ?? snapshot,
        (prompts) => {
          if (operation.current !== owner)
            throw new Error("The prompt editor closed.");
          return change(prompts);
        },
      );
      if (operation.current !== owner) return;
      setEditing(keep && editing ? { ...editing, snapshot: next } : null);
    } catch (reason) {
      if (operation.current === owner)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (operation.current === owner) setPending(false);
    }
  };
  const field =
    "w-full rounded-md border border-content/15 bg-content/5 px-2 py-1.5 text-[12px] text-content outline-none focus:border-accent";
  return (
    <Modal title="Actions" size="md" onClose={onClose}>
      <div className="flex max-h-[75vh] flex-col gap-3 overflow-auto px-4 pb-4 pt-1">
        <p className="text-[12px] text-content/80">
          Review a prompt, then add it to the current draft.
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-content/80" title={cwd}>
            {prettyCwd(cwd)}
          </span>
          <button
            type="button"
            disabled={pending || !!store.error}
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] hover:bg-content/10"
            onClick={() => {
              setError("");
              setEditing({
                snapshot,
                prompt: { id: crypto.randomUUID(), name: "", text: "" },
              });
            }}
          >
            <Plus className="size-3.5" />
            New prompt
          </button>
        </div>
        <div className="flex max-h-36 shrink-0 flex-col overflow-auto rounded-lg border border-content/10">
          {store.prompts.map((entry, index) => (
            <div
              key={entry.id}
              className={`flex items-center gap-1 px-2 py-1 ${prompt?.id === entry.id ? "bg-content/10" : ""}`}
            >
              <button
                type="button"
                disabled={pending}
                className="min-w-0 flex-1 py-1 text-left"
                onClick={() => {
                  setError("");
                  setEditing({ snapshot, prompt: { ...entry } });
                }}
              >
                <span className="block truncate text-[12px] text-content">
                  {entry.name}
                </span>
                <span className="block truncate text-[10px] text-content/80">
                  {entry.legacyProjectId
                    ? "Legacy project — choose scope"
                    : entry.cwd
                      ? prettyCwd(entry.cwd)
                      : "All working copies"}
                </span>
              </button>
              {([-1, 1] as const).map((delta) => (
                <button
                  key={delta}
                  type="button"
                  aria-label={`Move ${entry.name} ${delta < 0 ? "up" : "down"}`}
                  disabled={
                    pending ||
                    index + delta < 0 ||
                    index + delta >= store.prompts.length ||
                    !!editing
                  }
                  className="rounded p-1 text-content/80 hover:bg-content/10 disabled:opacity-30"
                  onClick={() =>
                    void mutate((prompts) => {
                      const next = [...prompts];
                      [next[index], next[index + delta]] = [
                        next[index + delta],
                        next[index],
                      ];
                      return next;
                    })
                  }
                >
                  {delta < 0 ? (
                    <ChevronUp className="size-3" />
                  ) : (
                    <ChevronDown className="size-3" />
                  )}
                </button>
              ))}
            </div>
          ))}
          {!store.prompts.length && !store.error ? (
            <p className="p-3 text-[12px] text-content/80">
              No saved prompts. Create one above.
            </p>
          ) : null}
        </div>
        {prompt ? (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-content/80">
              Name
              <input
                disabled={pending}
                aria-label="Prompt name"
                maxLength={120}
                value={prompt.name}
                onChange={(event) => update({ name: event.target.value })}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-content/80">
              Prompt
              <textarea
                disabled={pending}
                aria-label="Prompt text"
                rows={6}
                maxLength={MAX_PROMPT_TEXT}
                value={prompt.text}
                onChange={(event) => update({ text: event.target.value })}
                className={`${field} resize-y`}
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-content/80">Available in</span>
              <Select
                dialog
                disabled={pending}
                label="Prompt scope"
                value={
                  prompt.legacyProjectId
                    ? "legacy"
                    : !prompt.cwd
                      ? "all"
                      : promptAvailable(prompt, cwd)
                        ? "current"
                        : "other"
                }
                options={[
                  { value: "all", label: "All working copies" },
                  { value: "current", label: "This working copy" },
                  ...(prompt.legacyProjectId
                    ? [
                        {
                          value: "legacy",
                          label: "Legacy project — choose scope",
                        },
                      ]
                    : []),
                  ...(prompt.cwd && !promptAvailable(prompt, cwd)
                    ? [{ value: "other", label: "Another working copy" }]
                    : []),
                ]}
                onChange={(value) => {
                  if (value === "all" || value === "current")
                    update({
                      legacyProjectId: undefined,
                      cwd: value === "current" ? cwd : undefined,
                    });
                }}
              />
            </div>
            {prompt.legacyProjectId ? (
              <p className="text-[11px] text-content/80">
                Choose where this legacy project prompt belongs before adding
                it.
              </p>
            ) : null}
            {stale ? (
              <p role="alert" className="text-[12px] text-amber-500">
                Saved prompts changed. Select the prompt again to review its
                latest version.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {store.prompts.some((entry) => entry.id === prompt.id) ? (
                <button
                  type="button"
                  aria-label="Delete prompt"
                  disabled={pending || stale}
                  className="mr-auto rounded p-1.5 text-content/80 hover:text-red-400"
                  onClick={() => {
                    const owner = ++operation.current;
                    setPending(true);
                    setError("");
                    void ask(`Delete prompt “${prompt.name}”?`, {
                      title: "MonoCode",
                      kind: "warning",
                      okLabel: "Delete",
                    })
                      .then(async (confirmed) => {
                        if (owner !== operation.current) return;
                        if (confirmed)
                          await mutate((prompts) =>
                            prompts.filter((entry) => entry.id !== prompt.id),
                          );
                        else setPending(false);
                      })
                      .catch((reason) => {
                        if (owner === operation.current) {
                          setError(String(reason));
                          setPending(false);
                        }
                      });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                className="rounded px-2 py-1.5 text-[12px] hover:bg-content/10"
                disabled={pending}
                onClick={() => setEditing(null)}
              >
                Back
              </button>
              <button
                type="button"
                disabled={
                  pending || stale || !prompt.name.trim() || !prompt.text.trim()
                }
                className="rounded border border-content/15 px-2 py-1.5 text-[12px] disabled:opacity-40"
                onClick={() =>
                  void mutate(
                    (prompts) =>
                      prompts.some((entry) => entry.id === prompt.id)
                        ? prompts.map((entry) =>
                            entry.id === prompt.id ? prompt : entry,
                          )
                        : [...prompts, prompt],
                    true,
                  )
                }
              >
                Save prompt
              </button>
              <button
                type="button"
                disabled={
                  pending ||
                  stale ||
                  !prompt.text.trim() ||
                  !promptAvailable(prompt, cwd)
                }
                className="rounded bg-content px-3 py-1.5 text-[12px] text-background-base disabled:opacity-40"
                onClick={() => {
                  try {
                    if (savedPromptsSnapshot() !== editing.snapshot)
                      throw new Error(
                        "Saved prompts changed. Select the prompt again before adding it.",
                      );
                    onAdd(prompt.text);
                    onClose();
                  } catch (reason) {
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  }
                }}
              >
                Add to draft
              </button>
            </div>
          </>
        ) : (
          <p className="text-[12px] text-content/80">
            Choose a prompt to review it.
          </p>
        )}
        {error || store.error ? (
          <p role="alert" className="text-[12px] text-red-400">
            {error || store.error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
