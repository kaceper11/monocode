// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { notifyGitChanged, subscribeGitChanged } from "../../../platform/tauri/fs.ts";

it("refreshes only the affected checkout, including aliases, with an explicit global fallback", () => {
  const calls = [0, 0, 0];
  const stops = [
    "//wsl.localhost/Ubuntu/repo",
    "//wsl.localhost/Ubuntu/other",
    "C:/repo",
  ].map((cwd, i) => subscribeGitChanged(() => calls[i]++, cwd));
  try {
    notifyGitChanged("\\\\wsl$\\ubuntu\\repo");
    expect(calls).toEqual([1, 0, 0]);
    notifyGitChanged("//wsl.localhost/Ubuntu/repo/subfolder");
    expect(calls).toEqual([2, 0, 0]);
    notifyGitChanged("//wsl.localhost/Debian/repo");
    expect(calls).toEqual([2, 0, 0]);
    notifyGitChanged();
    expect(calls).toEqual([3, 1, 1]);
  } finally {
    stops.forEach((stop) => stop());
  }
});
