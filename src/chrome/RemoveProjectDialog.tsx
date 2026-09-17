import { useEffect, useRef, useState } from "react";
import { DIALOG_ACTION } from "./controls";
import { Modal } from "./Modal";
import { prettyCwd } from "../lib/paths";
import { projectSessionCount } from "../lib/projectData";

type Props = {
  name: string;
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Delete drops the project from the rail and its saved chats. The folder on
 * disk is left alone; opening it again brings the project back empty.
 */
export function RemoveProjectDialog({ name, path, onCancel, onConfirm }: Props) {
  const [sessions, setSessions] = useState<number | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void projectSessionCount(path).then((count) => {
      if (!cancelled) setSessions(count);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <Modal
      title={`Delete “${name}”?`}
      size="sm"
      trapFocus
      onClose={onCancel}
      className="text-[13px]"
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        <p className="text-[12px] leading-snug text-content/55">
          All conversations for this project will be deleted. It also leaves
          the sidebar. The folder on disk stays put, and opening it again
          brings the project back empty.
        </p>
        {sessions != null && sessions > 0 ? (
          <p className="text-[12px] leading-snug text-content/45">
            {sessions === 1
              ? "1 saved conversation will be removed."
              : `${sessions} saved conversations will be removed.`}
          </p>
        ) : null}
        <p
          title={prettyCwd(path)}
          className="truncate text-[11px] leading-tight text-content/40"
        >
          {prettyCwd(path)}
        </p>

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className={DIALOG_ACTION.ghost}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={DIALOG_ACTION.danger}
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}
