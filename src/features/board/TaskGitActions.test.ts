// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { withTaskGitLock } from "./TaskGitActions";

it("serializes git operations per project path", async () => {
  let release!: () => void;
  const first = withTaskGitLock(
    "/repo",
    "fetch",
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  // Same repo — a second operation waits rather than racing the checkout.
  await expect(
    withTaskGitLock("/repo", "merge", () => Promise.resolve(1)),
  ).rejects.toThrow("already running");
  // A different repository is unaffected.
  await expect(
    withTaskGitLock("/other", "merge", () => Promise.resolve(2)),
  ).resolves.toBe(2);
  release();
  await first;
  await expect(
    withTaskGitLock("/repo", "merge", () => Promise.resolve(3)),
  ).resolves.toBe(3);
});
