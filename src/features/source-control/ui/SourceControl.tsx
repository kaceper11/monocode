import { useEffect, useState } from "react";
import { listWorktrees } from "../model/worktrees";
import { pathKey } from "../../../shared/lib/paths";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import type { GitRepositoryScope } from "../model/repositoryScope";
import type { HarnessId } from "../../sessions/model/session";
import type {
  GitFileDiffKind,
  GitHistoryCommit,
} from "../../../platform/tauri/fs";
import { GitChangesPanel } from "./GitChangesPanel";

type Props = {
  cwd: string;
  repositories?: GitRepositoryScope[];
  selectedRepositoryId?: string;
  onSelectRepository?: (id: string) => void;
  enabled: boolean;
  textHarness?: HarnessId;
  selectedPath?: string;
  selectedKind?: GitFileDiffKind;
  selectedSha?: string;
  onOpenFile: (path: string, kind: GitFileDiffKind) => void;
  onOpenAllChanges: () => void;
  onOpenCommit: (commit: GitHistoryCommit) => void;
};

export function SourceControl({
  cwd,
  repositories = [],
  selectedRepositoryId,
  onSelectRepository,
  enabled,
  textHarness,
  selectedPath,
  selectedKind,
  selectedSha,
  onOpenFile,
  onOpenAllChanges,
  onOpenCommit,
}: Props) {
  const repositoriesKey = JSON.stringify(
    repositories.map((repo) => [repo.id, repo.projectPath, repo.cwd]),
  );
  const [availability, setAvailability] = useState<{
    key: string;
    unavailable: Set<string>;
  }>({ key: "", unavailable: new Set() });
  useEffect(() => {
    if (!enabled || !repositories.length) return;
    let active = true;
    const roots = [...new Set(repositories.map((repo) => repo.projectPath))];
    void Promise.allSettled(roots.map((root) => listWorktrees(root))).then(
      (results) => {
        const unavailable = new Set<string>();
        for (const repo of repositories) {
          const result = results[roots.indexOf(repo.projectPath)];
          if (
            !repo.cwd ||
            result.status === "rejected" ||
            !result.value?.worktrees.some(
              (tree) =>
                pathKey(tree.path) === pathKey(repo.cwd!) && !tree.missing,
            )
          )
            unavailable.add(repo.id);
        }
        if (active) setAvailability({ key: repositoriesKey, unavailable });
      },
    );
    return () => {
      active = false;
    };
    // Identities, not render-time array objects, control validation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, repositoriesKey]);
  const checking =
    repositories.length > 0 && availability.key !== repositoriesKey;
  const unavailable =
    !!selectedRepositoryId &&
    availability.unavailable.has(selectedRepositoryId);
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {repositories.length > 1 && (
        <div className="shrink-0 border-b border-stroke p-2">
          <SearchableSelect
            label="Git repository"
            value={selectedRepositoryId ?? ""}
            options={repositories.map((repo) => ({
              value: repo.id,
              label: `${repo.label}${availability.unavailable.has(repo.id) ? " · unavailable" : ""}`,
              disabled:
                checking || !repo.cwd || availability.unavailable.has(repo.id),
            }))}
            onChange={(id) => onSelectRepository?.(id)}
            placeholder="Choose repository…"
          />
        </div>
      )}
      {checking ? (
        <p role="status" className="p-3 text-[12px] text-content/50">
          Loading task checkouts…
        </p>
      ) : repositories.length && (!selectedRepositoryId || unavailable) ? (
        <p className="p-3 text-[12px] text-content/50">
          {unavailable
            ? repositories.length > 1
              ? "This checkout is unavailable. Choose another repository or edit the task or project."
              : "This checkout is unavailable. Edit the task or project to fix it."
            : "Prepare a task checkout to use Git."}
        </p>
      ) : (
        <GitChangesPanel
          key={cwd}
          cwd={cwd}
          enabled={enabled}
          textHarness={textHarness}
          selectedPath={selectedPath}
          selectedKind={selectedKind}
          selectedSha={selectedSha}
          onOpenFile={onOpenFile}
          onOpenAllChanges={onOpenAllChanges}
          onOpenCommit={onOpenCommit}
        />
      )}
    </div>
  );
}
