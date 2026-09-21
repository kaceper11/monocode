import { useEffect, useRef, useState } from "react";
import { Modal } from "../../shared/ui/Modal";
import { Check, Copy, ExternalLink } from "../../shared/ui/icons";
import {
  standupMarkdown,
  type StandupSection,
} from "./standup";

/** Standup report — structured preview of `standupSections` output with
 * per-row provider links and a markdown copy action. Sections recompute
 * in BoardView so the dialog stays live while open. */
export function StandupDialog({
  sections,
  openUrl,
  onClose,
}: {
  sections: readonly StandupSection[];
  openUrl: (url: string) => void;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = () => {
    void navigator.clipboard
      .writeText(standupMarkdown(sections))
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("failed"))
      .finally(() => {
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopyState("idle"), 1500);
      });
  };

  return (
    <Modal
      title="Standup"
      description="Generated from the board's current state"
      size="md"
      onClose={onClose}
      className="max-h-[70vh]"
    >
      <div className="px-4 pb-4 pt-1">
        {sections.length ? (
          sections.map((section) => (
            <section key={section.title} className="mt-3 first:mt-1">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-content/45">
                {section.title}
                <span className="rounded-full bg-content/8 px-1.5 text-[10px] font-medium tabular-nums text-content/50">
                  {section.items.length}
                </span>
              </h3>
              <ul className="mt-1 space-y-0.5">
                {section.items.map((item, index) => (
                  <li
                    key={index}
                    className="group flex items-start gap-2 rounded-md px-2 py-1 text-[12.5px] leading-snug text-content/85 hover:bg-content/5"
                  >
                    <span
                      aria-hidden
                      className="mt-[7px] size-1 shrink-0 rounded-full bg-content/30"
                    />
                    <span className="min-w-0 flex-1 break-words">
                      {item.text}
                    </span>
                    {item.url ? (
                      <button
                        type="button"
                        title="Open in provider"
                        aria-label="Open in provider"
                        className="mt-0.5 shrink-0 rounded p-0.5 text-content/35 opacity-0 hover:bg-content/8 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => openUrl(item.url!)}
                      >
                        <ExternalLink
                          className="size-3"
                          strokeWidth={1.75}
                        />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className="py-6 text-center text-[12.5px] text-content/45">
            Nothing on the board yet — finished and in-flight work will
            appear here.
          </p>
        )}
        <div className="mt-4 flex items-center justify-end gap-2 border-t border-content/8 pt-3">
          <button
            type="button"
            onClick={copy}
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent/12 px-2.5 text-[12px] font-medium text-accent hover:bg-accent/20"
          >
            {copyState === "copied" ? (
              <Check className="size-3.5" strokeWidth={2} />
            ) : (
              <Copy className="size-3.5" strokeWidth={1.75} />
            )}
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy markdown"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
