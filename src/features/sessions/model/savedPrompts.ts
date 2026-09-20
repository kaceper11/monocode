import { pathKey } from "../../../shared/lib/paths.ts";

export type SavedPrompt = {
  id: string;
  name: string;
  text: string;
  cwd?: string;
  /** Preserved until the owner explicitly chooses a current scope. */
  legacyProjectId?: string;
};
const KEY = "monocode.savedPrompts.v1";
const LEGACY_KEY = "monocode.agentActions.v1";
const EVENT = "monocode:saved-prompts-changed";
export const MAX_PROMPT_TEXT = 16_000;
const DEFAULTS: SavedPrompt[] = [
  {
    id: "implement",
    name: "Implement",
    text: "Implement the work described in this conversation in the selected working copy. Keep changes focused and run the relevant checks.",
  },
  {
    id: "review",
    name: "Review",
    text: "Review the working tree changes in the selected working copy. Look for correctness issues, regressions and missing tests. Report findings ordered by severity. Do not modify files.",
  },
  {
    id: "test",
    name: "Test",
    text: "Add or update tests for the work described in this conversation. Run relevant tests in the selected working copy and report what passes or fails.",
  },
];
const LEGACY_DEFAULTS = [
  "Implement the work described in the context. Work in the task's working copies, keep changes focused, and run the relevant checks when you are done.",
  "Review the working tree changes listed in the context. Look for correctness issues, regressions and missing tests, then report findings ordered by severity. Do not modify files.",
  "Add or update tests covering the work described in the context. Run the test suite in the relevant working copy and report what passes or fails.",
];

/** Reads never migrate or rewrite either store. Legacy bytes remain recoverable. */
export function savedPromptsSnapshot(): string {
  try {
    const current = localStorage.getItem(KEY);
    if (current !== null) return `current:${current}`;
    const legacy = localStorage.getItem(LEGACY_KEY);
    return legacy === null ? "" : `legacy:${legacy}`;
  } catch {
    return "unavailable:";
  }
}
function validate(value: unknown): SavedPrompt {
  if (!value || typeof value !== "object")
    throw new Error(
      "A saved prompt has invalid data. Its stored content has been preserved.",
    );
  const prompt = value as SavedPrompt;
  if (
    typeof prompt.id !== "string" ||
    !prompt.id ||
    prompt.id.length > 128 ||
    typeof prompt.name !== "string" ||
    !prompt.name.trim() ||
    prompt.name.length > 120 ||
    typeof prompt.text !== "string" ||
    !prompt.text.trim() ||
    prompt.text.length > MAX_PROMPT_TEXT ||
    (prompt.cwd !== undefined &&
      (typeof prompt.cwd !== "string" || !prompt.cwd.trim())) ||
    (prompt.legacyProjectId !== undefined &&
      (typeof prompt.legacyProjectId !== "string" ||
        !prompt.legacyProjectId.trim())) ||
    (prompt.cwd && prompt.legacyProjectId)
  )
    throw new Error(
      "Give the prompt a name (up to 120 characters) and text (up to 16,000 characters), with one scope.",
    );
  return {
    id: prompt.id,
    name: prompt.name,
    text: prompt.text,
    ...(prompt.cwd ? { cwd: prompt.cwd } : {}),
    ...(prompt.legacyProjectId
      ? { legacyProjectId: prompt.legacyProjectId }
      : {}),
  };
}
export function readSavedPrompts(
  snapshot = savedPromptsSnapshot(),
): SavedPrompt[] {
  if (!snapshot) return DEFAULTS.map((prompt) => ({ ...prompt }));
  const legacy = snapshot.startsWith("legacy:");
  if (!legacy && !snapshot.startsWith("current:"))
    throw new Error("Saved prompt storage is unavailable.");
  let store;
  try {
    store = JSON.parse(snapshot.slice(legacy ? 7 : 8));
  } catch {
    throw new Error(
      "Saved prompt data could not be read. The original data has been preserved.",
    );
  }
  const values = legacy ? store?.actions : store?.prompts;
  if (!Array.isArray(values) || (!legacy && store.version !== 1))
    throw new Error(
      "Unrecognized saved prompt data. The original data has been preserved.",
    );
  if (legacy && !values.length && store.seeded !== true)
    return DEFAULTS.map((prompt) => ({ ...prompt }));
  const prompts = values.map((value) => {
    if (!legacy) return validate(value);
    if (!value || typeof value !== "object") return validate(value);
    const index = DEFAULTS.findIndex(
      (prompt) => prompt.id === value.id && prompt.name === value.name,
    );
    return validate({
      id: value.id,
      name: value.name,
      text:
        index >= 0 && value.instructions === LEGACY_DEFAULTS[index]
          ? DEFAULTS[index].text
          : value.instructions,
      ...(value.projectId !== undefined
        ? { legacyProjectId: value.projectId }
        : {}),
    });
  });
  if (
    prompts.length > 50 ||
    new Set(prompts.map((prompt) => prompt.id)).size !== prompts.length
  )
    throw new Error(
      "Saved prompt data contains too many entries or duplicate IDs. The original data has been preserved.",
    );
  return prompts;
}
export function promptAvailable(prompt: SavedPrompt, cwd: string): boolean {
  return (
    !prompt.legacyProjectId &&
    (!prompt.cwd || pathKey(prompt.cwd) === pathKey(cwd))
  );
}
export function subscribeSavedPrompts(listener: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY || event.key === LEGACY_KEY)
      listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", changed);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", changed);
  };
}
export async function changeSavedPrompts(
  expected: string,
  change: (prompts: SavedPrompt[]) => SavedPrompt[],
): Promise<string> {
  const write = () => {
    if (savedPromptsSnapshot() !== expected)
      throw new Error(
        "Saved prompts changed in another window. Reopen the prompt before saving.",
      );
    const prompts = change(readSavedPrompts(expected)).map(validate);
    if (
      prompts.length > 50 ||
      new Set(prompts.map((prompt) => prompt.id)).size !== prompts.length
    )
      throw new Error("Keep at most 50 distinct saved prompts.");
    // A failed write is an error, never a successful save in a temporary cache.
    localStorage.setItem(KEY, JSON.stringify({ version: 1, prompts }));
    window.dispatchEvent(new Event(EVENT));
    return savedPromptsSnapshot();
  };
  // Web Locks serialize current WebViews; older engines still reject stale
  // snapshots, as with upstream's local preference stores.
  return navigator.locks ? navigator.locks.request(KEY, write) : write();
}
