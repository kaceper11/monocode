import { beforeEach, expect, it, vi } from "vitest";
import { loadProjectSessionHistory } from "./projectSessionHistory";
import { listSessionsByProject } from "./sessionStore";
vi.mock("./sessionStore", () => ({ listSessionsByProject: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("retains successful repository results when another load fails", async () => {
  vi.mocked(listSessionsByProject).mockImplementation(async (cwd) => {
    if (cwd === "/broken") throw new Error("Unavailable");
    return [];
  });
  const loaded = vi.fn();
  expect(
    await loadProjectSessionHistory(
      ["/api", "/broken", "/web"],
      loaded,
      () => true,
    ),
  ).toEqual(["/broken"]);
  expect(loaded.mock.calls.map(([cwd]) => cwd)).toEqual(["/api", "/web"]);
});
it("discards late results when the selected project changes", async () => {
  let finish!: (value: []) => void;
  vi.mocked(listSessionsByProject).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let current = true;
  const loaded = vi.fn();
  const request = loadProjectSessionHistory(["/api"], loaded, () => current);
  current = false;
  finish([]);
  expect(await request).toEqual([]);
  expect(loaded).not.toHaveBeenCalled();
});
