import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "../../shared/ui/Modal";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import {
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
} from "../../shared/ui/icons";
import { LAYER } from "../../shared/lib/layers";
import { projectName } from "../../shared/lib/paths";
import { gitPrPreflight } from "../../platform/tauri/fs";
import { useProjectBranchesState } from "../source-control/hooks/useProjectBranches";
import type { BoardTask } from "./boardStore";
import type { BoardWorkstreamRow, WorkstreamStatus } from "./boardData";
import { DEFAULT_PR_TEMPLATE, laneProblem } from "./taskOps";

export type PrSubmit = {
  title: string;
  /** Body template — `{task}`/`{tickets}`/`{prs}`/`{branches}`/`{branch}`/`{base}`. */
  body: string;
  /** Chosen target branch per lane, keyed by workstream id. */
  bases: ReadonlyMap<string, string>;
};

type LaneCheck =
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "ok"; ahead: number; pushed: boolean };

const laneName = (row: BoardWorkstreamRow) =>
  projectName(row.projectPath) || row.projectPath;

/** One lane's target picker + pre-submit validation. The `gitPrPreflight`
 * call resolves the base (fetching it), counts commits ahead, and reports
 * the checked-out branch — so "no commits"/"unknown base"/"wrong branch"
 * surface here instead of as a provider rejection. Reports its check state
 * up via `onCheck` so the form can gate the submit button. */
function LaneRow({
  row,
  value,
  onChange,
  onCheck,
}: {
  row: BoardWorkstreamRow;
  value: string;
  onChange: (base: string) => void;
  onCheck: (workstreamId: string, check: LaneCheck) => void;
}) {
  const { branches } = useProjectBranchesState(row.projectPath, true);
  const options = useMemo(() => {
    const list = (branches?.branches ?? []).map((branch) => {
      const name = branch.remote ? `${branch.remote}/${branch.name}` : branch.name;
      return { value: name, label: name };
    });
    return value && !list.some((option) => option.value === value)
      ? [{ value, label: value }, ...list]
      : list;
  }, [branches, value]);

  const [check, setCheck] = useState<LaneCheck>({ kind: "checking" });
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    const report = (next: LaneCheck) => {
      if (seq.current === id) {
        setCheck(next);
        onCheck(row.id, next);
      }
    };
    report({ kind: "checking" });
    if (!row.worktreePath) {
      report({ kind: "error", message: "No worktree — spawn a session first" });
      return;
    }
    void gitPrPreflight(row.worktreePath, value)
      .then((preflight) => {
        // A default ("HEAD") base resolves to the real branch name —
        // substitute it so the picker shows what the PR actually targets
        // and the submit sends a name providers accept. The change
        // re-runs this effect for the resolved value.
        if (
          (!value || value === "HEAD") &&
          preflight.baseBranch &&
          preflight.baseBranch !== value
        ) {
          onChange(preflight.baseBranch);
          return;
        }
        const problem = laneProblem(row, value, preflight);
        report(
          problem
            ? { kind: "error", message: problem }
            : {
                kind: "ok",
                ahead: preflight.ahead,
                pushed: preflight.headPushed,
              },
        );
      })
      .catch((error) =>
        report({
          kind: "error",
          message: String(error)
            .replace(/^Error:\s*/, "")
            .split("\n")[0]
            .slice(0, 120),
        }),
      );
    // `branches` re-runs the check when git state changes underneath —
    // e.g. the user pushes the base branch from a terminal mid-dialog.
  }, [row.id, row.branch, row.worktreePath, value, branches, onCheck]);

  return (
    <div className="rounded-md border border-content/8 bg-content/[0.02] px-2 py-1.5">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 truncate text-[12px] font-medium text-content/80">
            {laneName(row)}
          </span>
          <span className="min-w-0 truncate font-mono text-[10.5px] text-content/45">
            {row.branch}
          </span>
        </div>
        <span className="shrink-0 text-[11px] text-content/35">into</span>
        <div className="w-36 shrink-0">
          <SearchableSelect
            label={`${laneName(row)} target branch`}
            value={value}
            options={options}
            onChange={onChange}
            placeholder={branches ? "branch…" : "…"}
            searchPlaceholder="Branches…"
            minMenuWidth={240}
            layer={LAYER.dialogPopover}
          />
        </div>
      </div>
      {check.kind === "checking" ? (
        <p className="mt-1 flex items-center gap-1 text-[10.5px] text-content/40">
          <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
          Checking {value}…
        </p>
      ) : check.kind === "error" ? (
        <p role="alert" className="mt-1 break-words text-[10.5px] text-red-300">
          {check.message}
        </p>
      ) : (
        <p className="mt-1 text-[10.5px] text-content/35">
          {check.ahead} {check.ahead === 1 ? "commit" : "commits"} ahead
          {check.pushed ? "" : " — not pushed yet, pushes on create"}
        </p>
      )}
    </div>
  );
}

/**
 * Create-PR composer: per-lane target branches with pre-submit validation,
 * an editable title, and a body template with `{task}`/`{tickets}`/`{prs}`/
 * `{branches}`/`{branch}`/`{base}` tokens rendered per lane. `rows` are the
 * lanes this run may create; only lanes that pass validation are submitted.
 */
export function CreatePrsDialog({
  task,
  rows,
  status,
  busy,
  onSubmit,
  onCancel,
}: {
  task: BoardTask;
  rows: BoardWorkstreamRow[];
  status: ReadonlyMap<string, WorkstreamStatus>;
  busy: boolean;
  onSubmit: (only: ReadonlySet<string>, opts: PrSubmit) => unknown;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(DEFAULT_PR_TEMPLATE);
  const [bases, setBases] = useState<ReadonlyMap<string, string>>(
    () => new Map(rows.map((row) => [row.id, row.base])),
  );
  const [checks, setChecks] = useState<ReadonlyMap<string, LaneCheck>>(
    () => new Map(),
  );
  // Stable identity — LaneRows depend on it in their validation effect.
  const reportCheck = useCallback((workstreamId: string, check: LaneCheck) => {
    setChecks((current) => {
      if (current.get(workstreamId) === check) return current;
      return new Map(current).set(workstreamId, check);
    });
  }, []);

  const rowIds = new Set(rows.map((row) => row.id));
  // Sibling lanes not in this run that already have a PR — they get linked
  // into every created body via `{prs}`.
  const related = task.workstreams
    .filter((ws) => !rowIds.has(ws.id))
    .map((ws) => ({ ws, pr: status.get(ws.id)?.pr }))
    .filter((entry) => entry.pr);
  const multi = task.workstreams.length > 1;

  const checking = rows.some((row) => {
    const check = checks.get(row.id);
    return !check || check.kind === "checking";
  });
  const validIds = rows
    .filter((row) => checks.get(row.id)?.kind === "ok")
    .map((row) => row.id);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || checking || !validIds.length) return;
    // `onSubmit` is async upstream — swallow the rejection so a wholesale
    // failure doesn't surface as an unhandled promise rejection.
    void Promise.resolve(
      onSubmit(new Set(validIds), { title: title.trim(), body, bases }),
    ).catch(() => {});
  };

  return (
    <Modal
      title={rows.length > 1 ? `Create ${rows.length} pull requests` : "Create pull request"}
      description="Each lane opens a PR on its own repo. Bodies cross-link the related PRs."
      size="md"
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 px-4 pb-4 pt-1">
        <label className="flex flex-col gap-1.5 text-[12px] text-content/70">
          Title
          <input
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
            className="h-9 rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] text-content outline-none placeholder:text-content/40 focus:border-content/25"
          />
        </label>

        <section>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
            {rows.length > 1 ? "Lanes" : "Target"}
          </h3>
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <LaneRow
                key={row.id}
                row={row}
                value={bases.get(row.id) ?? row.base}
                onChange={(base) =>
                  setBases((current) => new Map(current).set(row.id, base))
                }
                onCheck={reportCheck}
              />
            ))}
          </div>
        </section>

        {multi ? (
          <section>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
              Related pull requests
            </h3>
            <div className="flex flex-col">
              {related.map(({ ws, pr }) => (
                <button
                  key={ws.id}
                  type="button"
                  className="flex items-center gap-1.5 rounded px-1 py-1 text-left text-[11.5px] text-content/70 hover:bg-content/4 hover:text-content"
                  title={pr!.title}
                  onClick={() => void openUrl(pr!.url)}
                >
                  <GitPullRequest className="size-3 shrink-0 text-content/45" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">
                    {projectName(ws.projectPath) || ws.projectPath} — PR #{pr!.number}
                  </span>
                  <ExternalLink className="size-3 shrink-0 text-content/35" strokeWidth={1.75} />
                </button>
              ))}
              {rows.length > 1
                ? rows.map((row) => (
                    <div
                      key={row.id}
                      className="flex items-center gap-1.5 rounded px-1 py-1 text-[11.5px] text-content/45"
                    >
                      <GitBranch className="size-3 shrink-0 text-content/35" strokeWidth={1.75} />
                      <span className="min-w-0 truncate">
                        {laneName(row)} — created in this run
                      </span>
                    </div>
                  ))
                : null}
            </div>
            <p className="mt-0.5 px-1 text-[10.5px] text-content/40">
              Every body links the others — new ones get patched in once created.
            </p>
          </section>
        ) : null}

        <label className="flex flex-col gap-1.5 text-[12px] text-content/70">
          <span className="flex items-center justify-between">
            Description
            <button
              type="button"
              className="text-[10.5px] font-normal text-content/45 hover:text-content"
              onClick={() => setBody(DEFAULT_PR_TEMPLATE)}
            >
              Reset to template
            </button>
          </span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={Math.min(9, body.split("\n").length + 1)}
            spellCheck={false}
            className="min-h-20 resize-y rounded-md bg-background-base px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-content outline-none placeholder:text-content/40 focus:border-content/25"
          />
          <span className="text-[10.5px] text-content/40">
            Tokens: {"{task} {branch} {base}"} — per lane;{" "}
            {"{tickets} {prs} {branches}"} expand to sections (dropped when empty).
          </span>
        </label>

        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="flex h-8 items-center rounded-md px-3 text-[12px] font-medium text-content/60 hover:bg-content/8 hover:text-content disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || checking || !validIds.length || !title.trim()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-accent/20 px-3 text-[12px] font-medium text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            {busy || checking ? (
              <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
            ) : null}
            {checking
              ? "Checking…"
              : validIds.length > 1
                ? `Create ${validIds.length} PRs`
                : "Create PR"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
