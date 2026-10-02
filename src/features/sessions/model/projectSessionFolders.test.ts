// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { loadSessionFolders, saveSessionFolders } from "./sessionFolders";
import {
  loadProjectSessionFolders,
  saveProjectSessionFolders,
} from "./projectSessionFolders";
const folder = {
  id: "same-id",
  name: "Work",
  sessionIds: ["api"],
  collapsed: false,
};
beforeEach(() => localStorage.clear());
it("keeps same-named folders scoped to their own repository", () => {
  saveSessionFolders("/api", [folder]);
  saveSessionFolders("/web", [{ ...folder, sessionIds: ["web"] }]);
  const view = loadProjectSessionFolders(["/api", "/web"]);
  expect(view[0].id).not.toBe(view[1].id);
  view[0].name = "Renamed";
  saveProjectSessionFolders(
    ["/api", "/web"],
    view,
    [
      { id: "api", cwd: "/api" },
      { id: "web", cwd: "/web" },
    ],
    "/api",
  );
  expect(loadSessionFolders("/api")[0]).toEqual({ ...folder, name: "Renamed" });
  expect(loadSessionFolders("/web")[0].name).toBe("Work");
});
it("rejects a cross-repository folder move before writing either repository", () => {
  saveSessionFolders("/api", [folder]);
  saveSessionFolders("/web", [{ ...folder, sessionIds: ["web"] }]);
  const before = localStorage.getItem("monocode.sessionFolders");
  const view = loadProjectSessionFolders(["/api", "/web"]);
  view[0].sessionIds.push("web");
  expect(() =>
    saveProjectSessionFolders(
      ["/api", "/web"],
      view,
      [
        { id: "api", cwd: "/api" },
        { id: "web", cwd: "/web" },
      ],
      "/api",
    ),
  ).toThrow("one repository");
  expect(localStorage.getItem("monocode.sessionFolders")).toBe(before);
});
it("preserves unloaded folder members during a partial history load", () => {
  saveSessionFolders("/api", [folder]);
  saveSessionFolders("/web", [{ ...folder, sessionIds: ["unloaded"] }]);
  const view = loadProjectSessionFolders(["/api", "/web"]);
  view[0].collapsed = true;
  saveProjectSessionFolders(
    ["/api", "/web"],
    view,
    [{ id: "api", cwd: "/api" }],
    "/api",
  );
  expect(loadSessionFolders("/web")[0].sessionIds).toEqual(["unloaded"]);
});
