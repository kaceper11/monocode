import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  checkState,
  currentDeliveryStatuses,
  ciLabel,
  deliveryKey,
  evidenceFingerprint,
  handoffPrompt,
  matchesTarget,
  probeDelivery,
  snapshotIdentity,
  type DeliverySnapshot,
} from "./delivery";
import { lanePrSignal } from "./boardData";
import type { TaskWorkstream } from "./boardStore";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const lane: TaskWorkstream = {
  id: "w",
  projectPath: "/repo",
  worktreePath: "/repo-wt",
  branch: "feature",
  base: "main",
};
const snapshot: DeliverySnapshot = {
  pr: null,
  source: { provider: "github", repo: "a/b", host: "github.com", account: "1" },
  headSha: "head",
  localHead: "local",
  checks: [],
};
const target = { cwd: "/repo-wt", branch: "feature", head: "local" };
beforeEach(() => vi.mocked(invoke).mockReset());
describe("delivery evidence", () => {
  it("hides old bindings immediately while replacement probes are pending", () => {
    const status = { pr: null, checks: [], requestKey: deliveryKey(lane) };
    const cached = new Map([[lane.id, status]]);
    expect(currentDeliveryStatuses([lane], cached).get(lane.id)).toBe(status);
    expect(
      currentDeliveryStatuses(
        [{ ...lane, worktreePath: "/another-copy" }],
        cached,
      ).size,
    ).toBe(0);
    expect(
      currentDeliveryStatuses([{ ...lane, ci: { provider: "gitlab" } }], cached)
        .size,
    ).toBe(0);
    expect(currentDeliveryStatuses([], cached).size).toBe(0);
  });

  it("distinguishes canceled, blocked, unknown and unavailable from success", () => {
    for (const [bucket, label] of [
      ["cancel", "canceled"],
      ["blocked", "blocked"],
      ["unknown", "unknown"],
      ["skipping", "skipped"],
      ["pass", "passed"],
    ]) {
      const check = { name: "build", state: bucket, bucket, url: "" };
      expect(checkState(check)).toBe(label);
      expect(ciLabel([check])).toContain(label);
    }
    expect(ciLabel([], "offline")).toBe("CI unavailable");
    expect(ciLabel([])).toBe("No CI runs");
  });
  it("never reports a PR ready while CI or the worktree is uncertain", () => {
    const row = {
      pr: {
        number: 1,
        title: "x",
        url: "url",
        state: "open",
        mergeState: "clean",
        unresolvedThreads: 0,
      },
      ciFailing: 0,
      ciRunning: 0,
    };
    expect(lanePrSignal(row)).toBe("ready");
    for (const problem of [
      { ciError: "offline" },
      { ciBlocked: true },
      { probeError: "changed branch" },
    ])
      expect(lanePrSignal({ ...row, ...problem })).not.toBe("ready");
  });
  it("matches the working copy, never just the parent repository", () => {
    expect(matchesTarget({ cwd: "/repo" }, target)).toBe(false);
    expect(
      matchesTarget({ cwd: "/repo", worktreeCwd: "/repo-wt" }, target),
    ).toBe(true);
    expect(
      matchesTarget(
        { cwd: "/repo", worktreeCwd: "/repo-wt", worktreeRemoved: true },
        target,
      ),
    ).toBe(false);
  });
  it("invalidates evidence on account, revision or CI binding changes", () => {
    expect(
      snapshotIdentity({
        ...snapshot,
        source: { ...snapshot.source, account: "2" },
      }),
    ).not.toBe(snapshotIdentity(snapshot));
    expect(snapshotIdentity({ ...snapshot, headSha: "new" })).not.toBe(
      snapshotIdentity(snapshot),
    );
    expect(
      deliveryKey({
        ...lane,
        ci: { provider: "azuredevops", project: "P", definitionIds: [7] },
      }),
    ).not.toBe(deliveryKey(lane));
  });
  it("deduplicates in-flight probes and releases them after failure", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    const a = probeDelivery(lane),
      b = probeDelivery(lane);
    expect(a).toBe(b);
    expect(invoke).toHaveBeenCalledTimes(1);
    reject(new Error("offline"));
    await expect(a).rejects.toThrow("offline");
    vi.mocked(invoke).mockResolvedValue(snapshot);
    await probeDelivery(lane);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("sends only selected evidence and preserves source and authority boundaries", () => {
    const evidence = [
      {
        id: "a",
        title: "test",
        body: "FAIL",
        url: "https://provider/run",
        selected: true,
      },
      {
        id: "b",
        title: "ignore",
        body: "UNSELECTED",
        url: "",
        selected: false,
      },
    ];
    const text = handoffPrompt(snapshot, target, "Fix tests", evidence);
    expect(text).toContain("Working copy: /repo-wt");
    expect(text).toContain("https://provider/run");
    expect(text).not.toContain("UNSELECTED");
    expect(text).toContain("Do not push, merge");
    expect(evidenceFingerprint(evidence)).not.toBe(
      evidenceFingerprint([{ ...evidence[0], body: "changed" }]),
    );
  });
});
