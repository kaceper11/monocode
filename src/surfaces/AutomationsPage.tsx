import { useMemo, useSyncExternalStore } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  loadWatchers,
  openWatchSheet,
  removeWatcher,
  setWatcherEnabled,
  subscribeWatchers,
  watcherSourceLabel,
  watchersSnapshot,
  type Watcher,
} from "../lib/watchers";
import { pollWatcherNow, watcherDueLabel } from "../lib/watcherEngine";
import {
  loadSchedules,
  openScheduleSheet,
  removeSchedule,
  scheduleCadenceLabel,
  scheduleNextLabel,
  scheduleTimezone,
  setScheduleEnabled,
  subscribeSchedules,
  schedulesSnapshot,
  type Schedule,
} from "../lib/schedules";
import { runScheduleNow } from "../lib/scheduleEngine";
import {
  loadProjects,
  projectsSnapshot,
  setProjectVerify,
  subscribeProjects,
} from "../lib/projects";
import {
  subscribeVerify,
  verifyRunsFor,
  verifySnapshot,
  verifyStoreFromSnapshot,
  type CheckRunRecord,
} from "../lib/verify";
import { formatRelativeTime } from "../lib/githubTasks";
import { displayPath } from "../lib/paths";
import { HARNESS_TITLE } from "../lib/session";

const button =
  "rounded-md border border-content/15 px-2 py-1 text-[12px] text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-40";

const MODE_LABEL = { notify: "Notify", draft: "Draft", run: "Run" } as const;

const CHECK_STATUS_LABEL: Record<CheckRunRecord["status"], string> = {
  passed: "passed",
  failed: "failed",
  timeout: "timeout",
  error: "error",
  skipped: "skipped",
};

/**
 * Settings → Automations (#23, #24, #76). Watchers poll and schedules fire
 * while MonoCode is open — this page is their pause/resume, cadence, and
 * history surface. The rows they emit land in the rail's Attention queue.
 */
export function AutomationsPage() {
  const raw = useSyncExternalStore(subscribeWatchers, watchersSnapshot);
  const watchers = useMemo(() => (raw ? loadWatchers() : []), [raw]);
  const schedulesRaw = useSyncExternalStore(subscribeSchedules, schedulesSnapshot);
  const schedules = useMemo(
    () => (schedulesRaw ? loadSchedules() : []),
    [schedulesRaw],
  );
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const verifyRaw = useSyncExternalStore(subscribeVerify, verifySnapshot);
  const checkedProjects = useMemo(() => {
    const store = verifyStoreFromSnapshot(verifyRaw);
    return loadProjects()
      .filter((project) => project.verify)
      .map((project) => ({
        project,
        runs: verifyRunsFor(project.id, store),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsRaw, verifyRaw]);

  const remove = async (watcher: Watcher) => {
    if (
      await ask(`Stop watching "${watcher.name}"? Its queue rows stay until they resolve.`, {
        title: "Remove watcher",
        kind: "warning",
        okLabel: "Remove",
        cancelLabel: "Cancel",
      })
    )
      removeWatcher(watcher.id);
  };

  const removeScheduleRow = async (schedule: Schedule) => {
    if (
      await ask(`Remove the schedule "${schedule.name}"?`, {
        title: "Remove schedule",
        kind: "warning",
        okLabel: "Remove",
        cancelLabel: "Cancel",
      })
    )
      removeSchedule(schedule.id);
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-content/80">Schedules</h3>
          <button
            type="button"
            className={button}
            onClick={() => openScheduleSheet()}
          >
            New schedule
          </button>
        </div>
        <p className="text-[13px] text-content/60">
          Send instructions to an agent on a schedule — times are{" "}
          {scheduleTimezone()} and runs happen only while MonoCode is open. A
          run the app missed fires once on next open, never in a burst.
        </p>
        {schedules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-content/15 px-4 py-6 text-center text-[13px] text-content/45">
            No schedules yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {schedules.map((schedule) => (
              <li
                key={schedule.id}
                className="rounded-lg border border-content/10 px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {schedule.name}
                  </span>
                  <span className="shrink-0 rounded bg-content/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content/50">
                    {MODE_LABEL[schedule.mode]}
                  </span>
                  <span className="shrink-0 text-[11px] text-content/40">
                    {scheduleNextLabel(schedule)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[12px] text-content/50">
                  {scheduleCadenceLabel(schedule.cadence)} ·{" "}
                  {displayPath(schedule.target.cwd)} ·{" "}
                  {HARNESS_TITLE[schedule.target.harness]}
                </p>
                {schedule.lastOutcome ? (
                  <p className="mt-1 text-[12px] text-content/55">
                    Last: {schedule.lastOutcome}
                  </p>
                ) : null}
                {schedule.history.length ? (
                  <ul className="mt-1.5 space-y-0.5">
                    {schedule.history.slice(-3).map((entry, index) => (
                      <li
                        key={`${entry.at}-${index}`}
                        className="flex items-baseline gap-2 text-[11px] text-content/45"
                      >
                        <span className="w-10 shrink-0 text-right tabular-nums">
                          {formatRelativeTime(new Date(entry.at).toISOString())}
                        </span>
                        <span
                          className={`shrink-0 ${
                            entry.kind === "error"
                              ? "text-red-400"
                              : entry.kind === "skip" || entry.kind === "missed"
                                ? "text-content/35"
                                : ""
                          }`}
                        >
                          {entry.kind}
                        </span>
                        <span className="min-w-0 truncate">{entry.text}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    className={button}
                    onClick={() =>
                      setScheduleEnabled(schedule.id, !schedule.enabled)
                    }
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={!schedule.enabled}
                    onClick={() => runScheduleNow(schedule.id)}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className={button}
                    onClick={() => openScheduleSheet({ existing: schedule })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${button} text-red-400/80 hover:text-red-400`}
                    onClick={() => void removeScheduleRow(schedule)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-[13px] font-medium text-content/80">
          Checks on finish
        </h3>
        <p className="text-[13px] text-content/60">
          Run a saved command when an agent turn ends — the outcome lands in
          the Attention queue while MonoCode is open. Pick the command per
          project in its saved-commands sheet; a failed run can hand the
          output tail back to the same agent.
        </p>
        {checkedProjects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-content/15 px-4 py-6 text-center text-[13px] text-content/45">
            No checks configured. Choose a finish command in a project’s saved
            commands.
          </p>
        ) : (
          <ul className="space-y-2">
            {checkedProjects.map(({ project, runs }) => {
              const verify = project.verify;
              if (!verify) return null;
              const command = project.commands.find(
                (item) => item.id === verify.commandId,
              );
              const last = runs[runs.length - 1];
              return (
                <li
                  key={project.id}
                  className="rounded-lg border border-content/10 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {project.name ??
                        (project.anchor
                          ? displayPath(project.anchor)
                          : "Project")}
                    </span>
                    <span className="shrink-0 rounded bg-content/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content/50">
                      {verify.mode === "fix" ? "Auto-fix" : "Notify"}
                    </span>
                    <span className="shrink-0 text-[11px] text-content/40">
                      {verify.enabled === false ? "Paused" : "On"}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-content/50">
                    {command?.name ?? "Deleted command — reconfigure in saved commands"}
                  </p>
                  {last ? (
                    <p
                      className={`mt-1 text-[12px] ${
                        last.status === "failed" ||
                        last.status === "timeout" ||
                        last.status === "error"
                          ? "text-red-400"
                          : "text-content/55"
                      }`}
                    >
                      Last: {CHECK_STATUS_LABEL[last.status]}
                      {last.detail ? ` — ${last.detail}` : ""} ·{" "}
                      {formatRelativeTime(new Date(last.at).toISOString())}
                      {last.sentToAgent ? " · sent to agent" : ""}
                    </p>
                  ) : null}
                  {runs.length > 1 ? (
                    <ul className="mt-1.5 space-y-0.5">
                      {/* The latest run is already the "Last:" line above. */}
                      {runs.slice(-4, -1).map((run) => (
                        <li
                          key={run.id}
                          className="flex items-baseline gap-2 text-[11px] text-content/45"
                        >
                          <span className="w-10 shrink-0 text-right tabular-nums">
                            {formatRelativeTime(new Date(run.at).toISOString())}
                          </span>
                          <span
                            className={`shrink-0 ${
                              run.status === "failed" ||
                              run.status === "timeout" ||
                              run.status === "error"
                                ? "text-red-400"
                                : run.status === "skipped"
                                  ? "text-content/35"
                                  : ""
                            }`}
                          >
                            {CHECK_STATUS_LABEL[run.status]}
                          </span>
                          <span className="min-w-0 truncate">
                            {run.sessionTitle}
                            {run.detail ? ` — ${run.detail}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      className={button}
                      onClick={() =>
                        setProjectVerify(project.id, {
                          commandId: verify.commandId,
                          mode: verify.mode,
                          enabled: verify.enabled === false,
                        })
                      }
                    >
                      {verify.enabled === false ? "Resume" : "Pause"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-[13px] font-medium text-content/80">Watchers</h3>
        <p className="text-[13px] text-content/60">
          Watchers poll their bound source while MonoCode is open and raise rows
          in the Attention queue. Create them from the place they watch — an
          Inbox query, a pull request, a pipeline.
        </p>
      {watchers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-content/15 px-4 py-6 text-center text-[13px] text-content/45">
          No watchers yet. Use "Watch this query" in the Inbox or "Watch" on a
          PR or pipeline.
        </p>
      ) : (
        <ul className="space-y-2">
          {watchers.map((watcher) => (
            <li
              key={watcher.id}
              className="rounded-lg border border-content/10 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {watcher.name}
                </span>
                <span className="shrink-0 rounded bg-content/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content/50">
                  {MODE_LABEL[watcher.mode]}
                </span>
                <span className="shrink-0 text-[11px] text-content/40">
                  {watcherDueLabel(watcher)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[12px] text-content/50">
                {watcherSourceLabel(watcher.source)}
              </p>
              {watcher.lastError ? (
                <p role="status" className="mt-1 text-[12px] text-red-400">
                  {watcher.lastError}
                </p>
              ) : null}
              {watcher.history.length ? (
                <ul className="mt-1.5 space-y-0.5">
                  {watcher.history.slice(-3).map((entry, index) => (
                    <li
                      key={`${entry.at}-${index}`}
                      className="flex items-baseline gap-2 text-[11px] text-content/45"
                    >
                      <span className="w-10 shrink-0 text-right tabular-nums">
                        {formatRelativeTime(new Date(entry.at).toISOString())}
                      </span>
                      <span
                        className={`shrink-0 ${
                          entry.kind === "error"
                            ? "text-red-400"
                            : entry.kind === "skip"
                              ? "text-content/35"
                              : ""
                        }`}
                      >
                        {entry.kind}
                      </span>
                      <span className="min-w-0 truncate">{entry.text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    setWatcherEnabled(watcher.id, !watcher.enabled)
                  }
                >
                  {watcher.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={!watcher.enabled}
                  onClick={() => pollWatcherNow(watcher.id)}
                >
                  Check now
                </button>
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    openWatchSheet({
                      source: watcher.source,
                      name: watcher.name,
                      existing: watcher,
                    })
                  }
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`${button} text-red-400/80 hover:text-red-400`}
                  onClick={() => void remove(watcher)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      </section>
    </div>
  );
}
