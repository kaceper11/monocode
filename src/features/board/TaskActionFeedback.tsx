import { AlertCircle, CheckCircle, X } from "../../shared/ui/icons";

export function TaskActionFeedback({ title, message, error = false, onDismiss }: {
  title: string; message?: string; error?: boolean; onDismiss?: () => void;
}) {
  const Icon = error ? AlertCircle : CheckCircle;
  return (
    <div role={error ? "alert" : "status"} className={`mt-2 flex min-w-0 items-start gap-2 rounded-lg border p-2.5 text-[12px] ${error ? "border-red-500/15 bg-red-500/5 text-red-700 dark:text-red-300" : "border-emerald-500/15 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"}`}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p className="font-medium">{title}</p>
        {message && <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">{message.replace(/^Error:\s*/, "")}</p>}
      </div>
      {onDismiss && <button type="button" aria-label="Dismiss message" onClick={onDismiss} className="grid size-5 shrink-0 place-items-center rounded hover:bg-content/10 focus-visible:outline-accent"><X className="size-3" /></button>}
    </div>
  );
}
