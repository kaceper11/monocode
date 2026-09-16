import type { DeliveryTabSource } from "../lib/layout";
import type { HarnessId } from "../lib/session";
import type { GitFileDiffKind, GitHistoryCommit } from "../lib/fs";
import { GitChangesPanel } from "./GitChangesPanel";

type Props = {
  sourceSessionId?: string;
  cwd: string;
  enabled: boolean;
  textHarness?: HarnessId;
  selectedPath?: string;
  selectedKind?: GitFileDiffKind;
  selectedSha?: string;
  /** Live session ids — task "N conversations" labels count these, not
   * stale task records. */
  liveSessionIds?: ReadonlySet<string>;
  onOpenFile: (path: string, kind: GitFileDiffKind) => void;
  onOpenDelivery?: (cwd: string, source: DeliveryTabSource) => void;
  onOpenAllChanges: () => void;
  onOpenCommit: (commit: GitHistoryCommit) => void;
};

export function SourceControl({
  sourceSessionId,
  cwd,
  enabled,
  textHarness,
  selectedPath,
  selectedKind,
  selectedSha,
  liveSessionIds,
  onOpenFile,
  onOpenAllChanges,
  onOpenDelivery,
  onOpenCommit,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <GitChangesPanel
        sourceSessionId={sourceSessionId}
        cwd={cwd}
        enabled={enabled}
        textHarness={textHarness}
        selectedPath={selectedPath}
        selectedKind={selectedKind}
        selectedSha={selectedSha}
        liveSessionIds={liveSessionIds}
        onOpenFile={onOpenFile}
        onOpenDelivery={onOpenDelivery}
        onOpenAllChanges={onOpenAllChanges}
        onOpenCommit={onOpenCommit}
      />
    </div>
  );
}
