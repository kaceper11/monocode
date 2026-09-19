// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearInboxCache, listInboxItems } from "../lib/githubTasks";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
it("keeps distinct Azure PR and CI rows when Boards access fails", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "azure_status")
      return {
        connected: true,
        site: "https://dev.azure.com/team",
        project: "Product",
        accountId: "ada",
      };
    if (cmd.endsWith("_status")) return { connected: false };
    if (cmd === "azure_list_items") throw new Error("Boards denied");
    if (cmd === "azure_delivery_inbox")
      return {
        errors: [],
        items: ["pr", "ci"].map((kind) => ({
          kind,
          number: 7,
          title: kind,
          url: `https://dev.azure.com/team/Product/${kind}/7`,
          updatedAt: "2026-09-11",
          delivery: {
            kind,
            accountId: "ada",
            project: "Product",
            repository: "repo",
          },
        })),
      };
    return [];
  });
  clearInboxCache();
  const result = await listInboxItems(
    [],
    { state: "open", search: "", assignedToMe: true },
    { force: true },
  );
  expect(result.items.map((item) => item.kind).sort()).toEqual(["ci", "pr"]);
  expect(
    result.items.every(
      (item) => item.account === "ada" && item.provider === "azure",
    ),
  ).toBe(true);
  expect(result.errors.azure).toContain("Boards denied");
  clearInboxCache();
});
