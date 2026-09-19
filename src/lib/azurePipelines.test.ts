import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ciRead, ciState } from "./azurePipelines";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
it("keeps unknown, cancelled and partial results distinct from success", () => {
  expect(ciState("inProgress", "succeeded")).toBe("Running");
  expect(ciState("unknown", "succeeded")).toBe("Unknown");
  expect(ciState("completed", "canceled")).toBe("Cancelled");
  expect(ciState("completed", "partiallySucceeded")).toBe("Partially passed");
});
it("binds log reads to account, repository, run revision and attempt", async () => {
  const target = {
    site: "https://dev.azure.com/team",
    accountId: "account",
    project: "project",
    definition: 7,
    repositoryId: "owner/repo",
    repositoryType: "GitHub",
    repositoryUrl: "https://github.com/owner/repo",
  };
  const run = { id: 12, revision: "attempt-2" };
  await ciRead(target, null, run, "log", {
    recordId: "job",
    attempt: 2,
    logId: 9,
    startLine: 500,
  });
  expect(invoke).toHaveBeenCalledWith("azure_ci_read", {
    input: {
      target,
      head: null,
      runId: 12,
      revision: "attempt-2",
      section: "log",
      recordId: "job",
      attempt: 2,
      logId: 9,
      startLine: 500,
    },
  });
});
