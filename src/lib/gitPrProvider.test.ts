import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { gitPrProvider } from "./gitPrProvider";
const azureUrl = "https://dev.azure.com/org/project/_git/repo";
const target = {
  site: "https://dev.azure.com/org",
  accountId: "account",
  project: "project",
  repository: "repo",
  number: 0,
};
let remote: string;
let account: string;
let githubUrl: string;
beforeEach(() => {
  remote = azureUrl;
  account = "account";
  githubUrl = "https://github.com/owner/repo";
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "azure_ci_context")
      return {
        branch: "feature",
        commit: "abc",
        remotes: [{ name: "origin", url: remote }],
      };
    if (command === "azure_status")
      return {
        connected: true,
        accountId: account,
        account: "Alice",
        site: target.site,
      };
    if (command === "azure_pr_list")
      return { target, items: [], nextSkip: null };
    if (command === "azure_pr_create") {
      if (args.target.accountId !== account) throw new Error("Account changed");
      return { target: { ...target, number: 5 } };
    }
    if (command === "git_github_repo") return args.url ? githubUrl : "owner/repo";
    if (command === "git_pr_status") return null;
    if (command === "git_pr_create")
      return "https://github.com/owner/repo/pull/6";
    throw new Error(command);
  });
});
const content = {
  title: "Change",
  body: "Details",
  head: "feature",
  base: "main",
};
it("creates Azure PRs from the displayed account and remote using the common content", async () => {
  const provider = await gitPrProvider("/repo", "origin", "feature");
  expect(provider.label).toContain("Alice");
  expect(await provider.create(content)).toBe(`${azureUrl}/pullrequest/5`);
  expect(invoke).toHaveBeenCalledWith("azure_pr_create", {
    target,
    sourceBranch: "feature",
    targetBranch: "main",
    title: "Change",
    description: "Details",
    draft: false,
  });
  expect(
    invoke.mock.calls.some(([command]) => command.startsWith("git_pr")),
  ).toBe(false);
});
it("does not create under a changed remote or account", async () => {
  const provider = await gitPrProvider("/repo", "origin", "feature");
  remote = "https://github.com/owner/repo";
  await expect(provider.create(content)).rejects.toThrow(/remote changed/);
  expect(
    invoke.mock.calls.some(([command]) => command === "azure_pr_create"),
  ).toBe(false);
  remote = azureUrl;
  account = "another";
  await expect(provider.create(content)).rejects.toThrow(/Account changed/);
});
it("retains upstream GitHub creation and rejects an ambiguous CLI destination", async () => {
  remote = "https://github.com/owner/repo";
  const provider = await gitPrProvider("/repo", "origin", "feature");
  expect(await provider.create(content)).toContain("/pull/6");
  remote = "https://github.com/other/repo";
  await expect(gitPrProvider("/repo", "origin", "feature")).rejects.toThrow(
    /different repositories/,
  );
});
it("does not fall back to GitHub when Azure lookup fails", async () => {
  invoke.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(gitPrProvider("/repo", "origin", "feature")).rejects.toThrow(
    "Disconnected",
  );
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("preserves GitHub creation when its optional PR status read fails", async () => {
  remote = "https://github.com/owner/repo";
  const handler = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "git_pr_status") throw new Error("Status unavailable");
    return handler(command, args);
  });
  const provider = await gitPrProvider("/repo", "origin", "feature");
  expect(provider.pr).toBeNull();
  expect(await provider.create(content)).toContain("/pull/6");
  remote = "https://github.com/other/repo";
  await expect(provider.create(content)).rejects.toThrow(/remote changed/);
  expect(invoke.mock.calls.filter(([command]) => command === "git_pr_create")).toHaveLength(1);
});

it("keeps Enterprise PRs on gh and verifies its full host identity", async () => {
  remote = githubUrl = "https://github.example.com/owner/repo";
  const provider = await gitPrProvider("/repo", "origin", "feature");
  expect(provider.provider).toBe("github");
  expect(provider.label).toContain("github.example.com/owner/repo");
  await provider.create(content);
  githubUrl = "https://github.other.example/owner/repo";
  await expect(provider.create(content)).rejects.toThrow(/different repositories/);
  expect(invoke.mock.calls.filter(([command]) => command === "git_pr_create")).toHaveLength(1);
});
