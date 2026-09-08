import { expect, it } from "vitest";
import { newSession } from "./session";
import {
  historyWithLiveSessions,
  replaceProjectHistory,
} from "./sessionHistory";
import { sessionListWindow, SESSION_LIST_PAGE } from "./sessionListWindow";
import type { SessionSummary } from "./sessionStore";

it("preserves project ownership and active sessions during a large history refresh", () => {
  const projects = [
    "/synthetic/project a",
    "/synthetic/project b",
    "/synthetic/project c",
  ];
  const history: SessionSummary[] = Array.from({ length: 3000 }, (_, i) => ({
    id: `history-${i}`,
    cwd: projects[i % 3],
    harness: "codex",
    model: "fixture",
    runtimeMode: "supervised",
    title: `History ${i}`,
    createdAt: i,
    updatedAt: i,
  }));
  const live = Array.from({ length: 10 }, (_, i) => {
    const session = newSession("codex", projects[i % 3]);
    session.id = `live-${i}`;
    session.busy = true;
    session.blocks = [{ id: "user", role: "user", text: "synthetic" }];
    return session;
  });
  const refreshed = replaceProjectHistory(
    history,
    projects[0],
    history.filter((row) => row.cwd === projects[0]),
  );
  for (const cwd of projects) {
    const rows = historyWithLiveSessions(refreshed, live, cwd);
    expect(rows).toHaveLength(
      1000 + live.filter((session) => session.cwd === cwd).length,
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.every((row) => row.cwd === cwd)).toBe(true);
    expect(sessionListWindow(rows.length, SESSION_LIST_PAGE, -1)).toBe(
      SESSION_LIST_PAGE,
    );
    const activeIndex = rows.findIndex(
      (row) => row.id === live.find((session) => session.cwd === cwd)!.id,
    );
    expect(
      sessionListWindow(rows.length, SESSION_LIST_PAGE, activeIndex),
    ).toBeGreaterThan(activeIndex);
  }
  expect(history).toHaveLength(3000);
});
