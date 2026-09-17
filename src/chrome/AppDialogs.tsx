import { useSyncExternalStore } from "react";
import { Modal, modalSwap } from "./Modal";
import { DIALOG_ACTION } from "./controls";
import { CircleAlert, Info, TriangleAlert } from "./icons";
import {
  appDialogSnapshot,
  subscribeAppDialogs,
  type DialogRequest,
} from "../lib/dialogs";

const KIND_META = {
  info: { icon: Info, tone: "text-accent" },
  warning: { icon: TriangleAlert, tone: "text-amber-400/90" },
  error: { icon: CircleAlert, tone: "text-rose-400/90" },
} as const;

/** Renders queued ask/message requests one at a time — the next request only
 * appears after the current one settles, like serialized native sheets. */
export function AppDialogs() {
  const requests = useSyncExternalStore(
    subscribeAppDialogs,
    appDialogSnapshot,
  );
  const request = requests[0];
  return request ? (
    <AppDialog key={request.id} request={request} queued={requests.length - 1} />
  ) : null;
}

function AppDialog({
  request,
  queued,
}: {
  request: DialogRequest;
  queued: number;
}) {
  const settle = (ok: boolean | null) => {
    // A queued request follows this one — keep the backdrop dimmed instead of
    // replaying the entrance for every dialog in the chain.
    if (queued > 0) modalSwap();
    request.settle(ok);
  };
  const { icon: KindIcon, tone } = KIND_META[request.kind];
  const confirm = request.mode === "confirm";
  // Warnings and errors default focus to Cancel so Enter never confirms a
  // destructive action by accident; Esc/backdrop/X report a bare dismiss.
  const focusOk = !confirm || request.kind === "info";
  return (
    <Modal
      title={request.title}
      size="sm"
      trapFocus
      onClose={() => settle(null)}
      className="text-[13px]"
    >
      <div className="px-4 pb-4 pt-1">
        <div className="flex items-start gap-2.5">
          <KindIcon
            className={`mt-px size-4 shrink-0 ${tone}`}
            strokeWidth={1.75}
          />
          <p className="min-w-0 flex-1 select-text whitespace-pre-line leading-relaxed text-content/75">
            {request.text}
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {confirm ? (
            <button
              type="button"
              autoFocus={!focusOk}
              onClick={() => settle(false)}
              className={DIALOG_ACTION.ghost}
            >
              {request.cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            autoFocus={focusOk}
            onClick={() => settle(true)}
            className={
              request.kind === "info"
                ? DIALOG_ACTION.accent
                : DIALOG_ACTION.danger
            }
          >
            {request.okLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
