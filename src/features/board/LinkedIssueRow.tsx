import { openUrl } from "@tauri-apps/plugin-opener";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import type { InboxProvider } from "../inbox/model/githubTasks";
import { ExternalLink, X } from "../../shared/ui/icons";
import { providerStage } from "./boardData";
import type { LinkedWorkItem } from "../sessions/model/session";

/** Structural superset of `BoardTicketChip` and `LinkedWorkItem`. */
export type LinkedIssue = Pick<
  LinkedWorkItem,
  "provider" | "identifier" | "title"
> & {
  url?: string;
  number?: number;
  kind?: string;
  state?: string;
  stateType?: string;
};

/** Legacy links predate the provider field — only unambiguous SaaS hosts get
 * a mark; self-hosted/unknown hosts safely render none. */
const HOST_PROVIDERS: [RegExp, InboxProvider][] = [
  [/(^|\.)github\.com$/i, "github"],
  [/(^|\.)gitlab\.com$/i, "gitlab"],
  [/(^|\.)linear\.app$/i, "linear"],
  [/(^|\.)atlassian\.net$/i, "jira"],
  [/(^|\.)dev\.azure\.com$/i, "azuredevops"],
  [/(^|\.)visualstudio\.com$/i, "azuredevops"],
];

const providerFromUrl = (url?: string): InboxProvider | undefined => {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return HOST_PROVIDERS.find(([pattern]) => pattern.test(host))?.[1];
  } catch {
    return undefined;
  }
};

/** One linked issue/PR row — shared by task details and the session task
 * popover so linked work renders identically on both surfaces. `onEdit` adds
 * the manage affordance (task-authored links only). */
export function LinkedIssueRow({
  issue,
  onEdit,
}: {
  issue: LinkedIssue;
  onEdit?: () => void;
}) {
  const provider = issue.provider ?? providerFromUrl(issue.url);
  return (
    <div
      title={issue.url}
      className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-content/4"
    >
      {provider ? (
        <InboxProviderMark
          provider={provider}
          className="size-3.5 shrink-0 text-content/60"
        />
      ) : null}
      <span className="max-w-28 shrink-0 truncate rounded bg-content/8 px-1 py-px text-[10px] font-medium text-content/55">
        {issue.identifier?.trim() ||
          (issue.number ? `#${issue.number}` : undefined) ||
          issue.kind ||
          "item"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
        {issue.title ?? issue.url}
      </span>
      {issue.state ? (
        <span
          className={`max-w-20 shrink-0 truncate text-[10px] ${
            providerStage(issue) === "done"
              ? "text-content/35"
              : "text-emerald-300/80"
          }`}
        >
          {issue.state}
        </span>
      ) : null}
      {issue.url ? (
        <button
          type="button"
          aria-label={`Open ${issue.title ?? issue.identifier ?? "item"} in browser`}
          className="grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => void openUrl(issue.url!)}
        >
          <ExternalLink className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
      {onEdit ? (
        <button
          type="button"
          aria-label={`Edit linked issues (${issue.title} linked)`}
          className="grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onEdit}
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}
