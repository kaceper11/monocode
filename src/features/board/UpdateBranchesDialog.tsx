import { useState } from "react";
import { Modal } from "../../shared/ui/Modal";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import { useProjectBranches } from "../source-control/hooks/useProjectBranches";
import { projectName } from "../../shared/lib/paths";
import { LAYER } from "../../shared/lib/layers";
import { loadBoard, type TaskWorkstream } from "./boardStore";
function BranchRow({
  row,
  value,
  onChange,
}: {
  row: TaskWorkstream;
  value: string;
  onChange: (ref: string) => void;
}) {
  const branches = useProjectBranches(row.projectPath, true);
  return (
    <div className="space-y-1">
      <p className="text-[12px] text-content/70">
        {projectName(row.projectPath)} · {row.branch}
      </p>
      <SearchableSelect
        label={`Merge into ${row.branch} from`}
        value={value}
        options={[
          {
            value: "HEAD",
            label: "Default branch · remote HEAD / main / master",
          },
          ...(branches?.branches ?? []).map((branch) => ({
            value: branch.remote
              ? `refs/remotes/${branch.remote}/${branch.name}`
              : `refs/heads/${branch.name}`,
            label: branch.remote
              ? `${branch.remote}/${branch.name}`
              : branch.name,
          })),
        ]}
        onChange={onChange}
        layer={LAYER.dialogPopover}
      />
    </div>
  );
}
export function UpdateBranchesDialog({
  rows,
  onClose,
  onSubmit,
}: {
  rows: TaskWorkstream[];
  onClose: () => void;
  onSubmit: (refs: Record<string, string>) => void;
}) {
  const [refs, setRefs] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.id, "HEAD"])),
  );
  const [error, setError] = useState("");
  const submit = () => {
    const current = loadBoard()
      .tasks.filter((task) => !task.archived)
      .flatMap((task) => task.workstreams);
    if (
      rows.some((row) => {
        const live = current.find((ws) => ws.id === row.id);
        return (
          !live ||
          live.branch !== row.branch ||
          live.projectPath !== row.projectPath ||
          live.worktreePath !== row.worktreePath
        );
      })
    ) {
      setError(
        "Task checkout changed. Close this dialog and review the branches again.",
      );
      return;
    }
    onSubmit(refs);
  };
  return (
    <Modal
      title="Merge into branches"
      fitViewport
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2 p-3">
          <button
            className="rounded px-3 py-1.5 text-[12px] text-content/65 hover:bg-content/8"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded bg-accent/10 px-3 py-1.5 text-[12px] text-accent"
            onClick={submit}
          >
            Fetch & merge
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        {rows.map((row) => (
          <BranchRow
            key={row.id}
            row={row}
            value={refs[row.id]}
            onChange={(ref) =>
              setRefs((current) => ({ ...current, [row.id]: ref }))
            }
          />
        ))}
        {error && (
          <p role="alert" className="text-[12px] text-red-400">
            {error}
          </p>
        )}
        <p className="text-[11px] text-content/60">
          Fetch remote refs, then merge into these task checkouts. Conflicts
          stay in the checkout for resolution.
        </p>
      </div>
    </Modal>
  );
}
