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
};

export function InboxPrDiff({ diff, lineCommentComposer }: Props) {
  const files = useMemo(() => {
    const parsed = mergePrDiff(diff.files, parsePrPatch(diff.patch));
    return parsed.map((file) => toModel(file, diff.truncated));
  }, [diff]);

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

function toModel(file: PrDiffFile, truncated: boolean): UnifiedDiffFileModel {
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
    blocks: blocksFromLines(lines),
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
