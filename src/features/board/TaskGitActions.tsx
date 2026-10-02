import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { gitRefreshBranches } from "../../platform/tauri/fs";
import { pathKey, projectName } from "../../shared/lib/paths";
import { TaskActionFeedback } from "./TaskActionFeedback";
import {
  CheckCircle,
  LoaderCircle,
  RefreshCw,
} from "../../shared/ui/icons";

type Target = { projectPath: string };
const pending = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = () => {
  revision++;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export async function withTaskGitLock<T>(
  projectPath: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = pathKey(projectPath);
  const running = pending.get(key);
  if (running)
    throw new Error(
      `A Git operation (${running}) is already running for this repository.`,
    );
  pending.set(key, label);
  publish();
  try {
    return await run();
  } finally {
    pending.delete(key);
    publish();
  }
}

export function useTaskGitBusy(paths: readonly string[]): boolean {
  useSyncExternalStore(subscribe, () => revision);
  return paths.some((path) => pending.has(pathKey(path)));
}

/** The label of the op holding the repo's git lock, if any — lets surfaces
 * explain the block instead of just disabling controls. */
export function useTaskGitOperation(
  paths: readonly string[],
): string | undefined {
  useSyncExternalStore(subscribe, () => revision);
  for (const path of paths) {
    const label = pending.get(pathKey(path));
    if (label) return label;
  }
  return undefined;
}

/** The same guarded Git operations for draft rows, saved lanes and bulk actions. */
export function TaskGitActions({
  targets,
  all = false,
  disabled = false,
  children,
}: {
  children?: ReactNode;
  targets: readonly Target[];
  all?: boolean;
  disabled?: boolean;
}) {
  const gitBusy = useTaskGitBusy(targets.map((target) => target.projectPath));
  const [results, setResults] = useState<
    { name: string; error?: string; message: string }[]
  >([]);
  // Successful fetches report inline for a moment — a bordered card per repo
  // would stretch the toolbar row they live in.
  const [succeeded, setSucceeded] = useState(0);
  const [running, setRunning] = useState("");
  const busy = !!running || gitBusy;
  const run = async () => {
    if (busy || disabled) return;
    const unique = [
      ...new Map(
        targets
          .filter((t) => t.projectPath)
          .map((t) => [pathKey(t.projectPath), t]),
      ).values(),
    ];
    const keys = unique.map((t) => pathKey(t.projectPath));
    if (keys.some((key) => pending.has(key))) return;
    keys.forEach((key) => pending.set(key, "fetch"));
    publish();
    setRunning("fetch");
    setResults([]);
    setSucceeded(0);
    try {
      for (const target of unique) {
        const name = projectName(target.projectPath);
        try {
          await gitRefreshBranches(target.projectPath);
          setSucceeded((count) => count + 1);
        } catch (error) {
          setResults((rows) => [
            ...rows,
            { name, message: "Fetch failed", error: String(error) },
          ]);
        }
      }
    } finally {
      keys.forEach((key) => pending.delete(key));
      publish();
      setRunning("");
    }
  };
  useEffect(() => {
    if (!succeeded || running) return;
    const timer = setTimeout(() => setSucceeded(0), 5000);
    return () => clearTimeout(timer);
  }, [succeeded, running]);
  // A single remote op doesn't need a menu — the button is the action.
  const label = all
    ? "Fetch all repositories"
    : `Fetch ${projectName(targets[0]?.projectPath ?? "repository")}`;
  return (
    <div className={`${children ? "w-full" : "shrink-0"} min-w-0 text-[11px]`}>
      <div className="flex items-center gap-1.5">
        {children}
        <span className="flex-1" />
        {running ? null : succeeded ? (
          <span
            role="status"
            className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"
          >
            <CheckCircle className="size-3" strokeWidth={2} />
            {succeeded > 1 ? `Fetched ${succeeded}` : "Fetched"}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={label}
          title="Fetch remote branches without changing your working copy"
          disabled={disabled || busy || !targets.some((t) => t.projectPath)}
          onClick={() => void run()}
          className="grid size-8 shrink-0 place-items-center rounded-md border border-content/10 bg-content/3 text-content/65 hover:bg-content/8 hover:text-content focus-visible:outline-accent disabled:opacity-35"
        >
          {running ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </button>
      </div>
      {results.map((result, index) => (
        <TaskActionFeedback
          key={index}
          title={`${result.name}: ${result.message}`}
          message={result.error}
          error={!!result.error}
          onDismiss={() =>
            setResults((rows) => rows.filter((_, i) => i !== index))
          }
        />
      ))}
    </div>
  );
}
