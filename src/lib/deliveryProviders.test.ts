// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { gitPrStatus } from "./fs";
import { githubRepo } from "./githubTasks";
import { deliveryProvider, saveDeliveryProvider, repositoryProvider, resolvePrProviders, githubDeliveryTarget, parseGithubPrLocation } from "./deliveryProviders";
vi.mock("./fs", () => ({gitPrStatus: vi.fn()}));
vi.mock("./githubTasks", () => ({githubRepo: vi.fn()}));
vi.mock("./gitlab", () => ({gitlabMrForBranch: vi.fn()}));
beforeEach(() => { const rows = new Map<string, string>(); vi.stubGlobal("localStorage", {getItem:(key:string) => rows.get(key) ?? null, setItem:(key:string,value:string) => rows.set(key,value)}); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("resolves known remotes without choosing between ambiguous providers", () => {
  const github = {name:"origin", url:"git@github.com:team/repo.git"};
  const azure = {name:"azure", url:"https://dev.azure.com/team/project/_git/repo"};
  expect(repositoryProvider([github])).toBe("github");
  expect(repositoryProvider([azure])).toBe("azure");
  expect(repositoryProvider([github, azure])).toBeUndefined();
  expect(repositoryProvider([github, azure], "azure")).toBe("azure");
  expect(repositoryProvider([{name:"origin", url:"https://github.com.evil.test/a/b"}])).toBeUndefined();
});
it("separates detected auto resolution from an explicit provider override", () => {
  const github = {name:"origin", url:"git@github.com:team/repo.git"};
  const azure = {name:"azure", url:"https://dev.azure.com/team/project/_git/repo"};
  // Auto on a GitHub-only remote set detects github; an azure override stays
  // effective without rewriting what auto claims.
  expect(resolvePrProviders({remotes:[github], upstream:"origin/feature"}))
    .toEqual({detected:"github", effective:"github"});
  expect(resolvePrProviders({remotes:[github], upstream:"origin/feature", override:"azure"}))
    .toEqual({detected:"github", effective:"azure"});
  // A local upstream like `main` names no remote — the default remote is used.
  expect(resolvePrProviders({remotes:[github], upstream:"main", remote:"origin"}))
    .toEqual({detected:"github", effective:"github"});
  // Mixed remotes stay undetectable unless a remote upstream disambiguates.
  expect(resolvePrProviders({remotes:[github, azure], upstream:"main", remote:"origin"}))
    .toEqual({detected:"github", effective:"github"});
  expect(resolvePrProviders({remotes:[github, azure], upstream:"azure/feature", remote:"origin"}))
    .toEqual({detected:"azure", effective:"azure"});
  expect(resolvePrProviders({remotes:[github, azure]}))
    .toEqual({detected:undefined, effective:undefined});
});
it("keeps PR and CI choices scoped to checkout, branch and conversation", () => {
  saveDeliveryProvider("/repo", "feature", "owner", "pr", "github");
  saveDeliveryProvider("/repo", "feature", "owner", "ci", "azure");
  expect(deliveryProvider("/repo", "feature", "owner", "pr")).toBe("github");
  expect(deliveryProvider("/repo", "feature", "owner", "ci")).toBe("azure");
  expect(deliveryProvider("/repo", "other", "owner", "ci")).toBeUndefined();
  expect(deliveryProvider("/repo", "feature", "other", "ci")).toBeUndefined();
  saveDeliveryProvider("/repo", "feature", "owner", "ci", "");
  expect(deliveryProvider("/repo", "feature", "owner", "ci")).toBeUndefined();
});
it("parses a github.com PR link into an explicit repo + number identity", () => {
  expect(parseGithubPrLocation("https://github.com/team/repo/pull/42?tab=files"))
    .toEqual({ repo: "team/repo", number: 42 });
  expect(parseGithubPrLocation("https://github.com/team/repo/pull/42/"))
    .toEqual({ repo: "team/repo", number: 42 });
  expect(() => parseGithubPrLocation("javascript:alert(1)")).toThrow("invalid PR link");
  expect(() => parseGithubPrLocation("https://github.com.evil.test/a/b/pull/1")).toThrow("invalid PR link");
  expect(() => parseGithubPrLocation("https://github.com/a/b/pull/")).toThrow("invalid PR link");
});
it("resolves the delivery target from a PR link or the branch's open PR", async () => {
  await expect(githubDeliveryTarget("/repo", "https://github.com/team/repo/pull/7"))
    .resolves.toEqual({ repo: "team/repo", number: 7 });
  vi.mocked(gitPrStatus).mockResolvedValue({number:3,title:"Fix",state:"OPEN",url:"https://github.com/team/repo/pull/3"});
  await expect(githubDeliveryTarget("/repo")).resolves.toEqual({ repo: "team/repo", number: 3 });
  // A non-standard PR URL still binds to the checkout's own repository.
  vi.mocked(gitPrStatus).mockResolvedValue({number:4,title:"Fix",state:"OPEN",url:"https://example.test/x"});
  vi.mocked(githubRepo).mockResolvedValue("team/repo");
  await expect(githubDeliveryTarget("/repo")).resolves.toEqual({ repo: "team/repo", number: 4 });
  vi.mocked(gitPrStatus).mockResolvedValue(null);
  await expect(githubDeliveryTarget("/repo")).rejects.toThrow("No GitHub PR found");
});
it("binds GitLab delivery to the project the backend resolved", async () => {
  const { gitlabDeliveryTarget } = await import("./deliveryProviders");
  const { gitlabMrForBranch } = await import("./gitlab");
  vi.mocked(gitlabMrForBranch).mockResolvedValue({repo: "acme/web", number: 7} as never);
  await expect(gitlabDeliveryTarget("/repo", "feature")).resolves.toEqual({repo: "acme/web", number: 7});
  await expect(gitlabDeliveryTarget("/repo", " ")).rejects.toThrow("No branch");
  vi.mocked(gitlabMrForBranch).mockRejectedValueOnce(new Error("No open merge request for this branch"));
  await expect(gitlabDeliveryTarget("/repo", "feature")).rejects.toThrow("No open merge request");
  vi.mocked(gitlabMrForBranch).mockResolvedValueOnce({repo: "", number: 7} as never);
  await expect(gitlabDeliveryTarget("/repo", "feature")).rejects.toThrow("does not resolve");
});
