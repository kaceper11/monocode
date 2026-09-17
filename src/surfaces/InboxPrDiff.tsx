import { useMemo } from "react";
import type { GithubPrDiff } from "../lib/githubTasks";
import { mergePrDiff, parsePrPatch, type PrDiffFile } from "../lib/prDiff";
import { blocksFromLines, type UnifiedLine } from "../lib/unifiedDiff";
import {
  UnifiedDiffView,
  type LineCommentComposer,
  type UnifiedDiffFileModel,
} from "./UnifiedDiffView";

type Props = {
  diff: GithubPrDiff;
  /** Remote review surfaces route line comments into their own review flow. */
  lineCommentComposer?: LineCommentComposer;
  /** When true, show the whole file (no fold rows). */
  fullFile?: boolean;
};

export function InboxPrDiff({
  diff,
  lineCommentComposer,
  fullFile = false,
}: Props) {
  const files = useMemo(() => {
    const parsed = mergePrDiff(diff.files, parsePrPatch(diff.patch));
    const context = fullFile ? Number.POSITIVE_INFINITY : undefined;
    return parsed.map((file) => toModel(file, diff.truncated, context));
  }, [diff, fullFile]);

  return (
    <UnifiedDiffView
      files={files}
      truncated={diff.truncated}
      totals={{ additions: diff.additions, deletions: diff.deletions }}
      fill={false}
      fileLayout="cards"
      initialExpansion="first"
      lineCommentComposer={lineCommentComposer}
    />
  );
}

function toModel(
  file: PrDiffFile,
  truncated: boolean,
  context?: number,
): UnifiedDiffFileModel {
  const lines = file.lines.map(toUnifiedLine);
  return {
    id: file.path,
    path: file.path,
    label:
      file.status === "renamed" && file.previousPath
        ? `${file.previousPath} → ${file.path}`
        : file.path,
    binary: file.binary,
    emptyMessage:
      !file.binary && file.lines.length === 0
        ? truncated
          ? "Patch unavailable because this change is too large"
          : "No textual diff"
        : undefined,
    additions: file.additions,
    deletions: file.deletions,
    // Remote diff — chat-bound hunk/line actions lose the PR binding, so the
    // owning review surface provides the comment flow instead.
    contextActions: false,
    blocks: blocksFromLines(lines, context),
  };
}

function toUnifiedLine(line: PrDiffFile["lines"][number]): UnifiedLine {
  return {
    kind: line.kind,
    text: line.text,
    oldNumber: line.oldNumber,
    newNumber: line.newNumber,
  };
}
