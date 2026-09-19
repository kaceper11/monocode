import { useMemo } from "react";
import type { InboxDiff } from "../lib/inboxProvider";
import { mergePrDiff, parsePrPatch, type PrDiffFile } from "../lib/prDiff";
import { buildUnifiedFile, blocksFromLines, type UnifiedLine } from "../lib/unifiedDiff";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "./UnifiedDiffView";

type Props = {
  diff: InboxDiff;
  /** When true, show the whole file (no fold rows). */
  fullFile?: boolean;
};

export function InboxPrDiff({ diff, fullFile = false }: Props) {
  const files = useMemo(() => {
    if ("items" in diff) return diff.items.map((item, index): UnifiedDiffFileModel => {
      const built = item.error ? null : buildUnifiedFile(item.original ?? "", item.modified ?? "");
      return { id: `${index}:${item.path}`, path: item.path,
        label: item.originalPath ? `${item.originalPath} → ${item.path}` : item.path,
        emptyMessage: item.error, additions: built?.additions ?? 0,
        deletions: built?.deletions ?? 0, blocks: built?.blocks ?? [] };
    });
    const parsed = mergePrDiff(diff.files, parsePrPatch(diff.patch));
    const context = fullFile ? Number.POSITIVE_INFINITY : undefined;
    return parsed.map((file) => toModel(file, diff.truncated, context));
  }, [diff, fullFile]);

  return (
    <UnifiedDiffView
      files={files}
      truncated={diff.truncated}
      totals={"items" in diff
        ? { additions: files.reduce((sum, f) => sum + f.additions, 0), deletions: files.reduce((sum, f) => sum + f.deletions, 0) }
        : { additions: diff.additions, deletions: diff.deletions }}
      fill={false}
      fileLayout="cards"
      initialExpansion="first"
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
