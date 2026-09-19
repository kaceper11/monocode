import { invoke } from "@tauri-apps/api/core";
import { azureConnected } from "./azure";
import { ciContext } from "./azurePipelines";
import {
  azurePrCreate,
  azurePrUrl,
  findAzurePrs,
  parseAzurePrLocation,
} from "./azureRepos";
import { gitPrCreate, gitPrStatus, type GitPr } from "./fs";

type PrContent = { title: string; body: string; base: string; head: string };

/** The selected Git remote owns PR routing; ticket and CI providers are independent. */
export async function gitPrProvider(
  cwd: string,
  remote: string,
  branch: string,
) {
  const context = await ciContext(cwd, true);
  const url = context.remotes.find((item) => item.name === remote)?.url;
  if (!url || context.branch !== branch)
    throw new Error(
      "PR destination unavailable. Refresh the branch and remote.",
    );
  const check = async (content: PrContent) => {
    const current = await ciContext(cwd, true);
    if (
      current.branch !== branch ||
      content.head !== branch ||
      current.remotes.find((item) => item.name === remote)?.url !== url
    )
      throw new Error(
        "PR branch or remote changed. Refresh before creating the pull request.",
      );
  };
  if (new URL(url).hostname !== "dev.azure.com") {
    const checkGithub = async () => {
      const repo = await invoke<string>("git_github_repo", { cwd, url: true });
      if (repo.replace(/\/$/, "").toLowerCase() !== url.toLowerCase())
        throw new Error(
          "GitHub CLI and the selected Git remote use different repositories. Choose the intended repository in gh first.",
        );
    };
    await checkGithub();
    return {
      provider: "github" as const,
      label: `GitHub · ${url.replace(/^https?:\/\//, "")} · ${remote}`,
      pr: await gitPrStatus(cwd).catch(() => null),
      async create(content: PrContent) {
        await check(content);
        await checkGithub();
        return gitPrCreate(
          cwd,
          content.title,
          content.body,
          content.base,
          content.head,
        );
      },
    };
  }
  const location = parseAzurePrLocation(url);
  const account = await azureConnected();
  if (
    !account.connected ||
    !account.accountId ||
    account.site !== location.site
  )
    throw new Error(
      `Connect Azure DevOps for ${location.site} to use pull requests.`,
    );
  const target = { ...location, accountId: account.accountId };
  const result = await findAzurePrs(target, branch);
  const matches = result.items.filter(
    (pr) =>
      pr.status === "active" && pr.sourceRefName === `refs/heads/${branch}`,
  );
  if (matches.length > 1 || result.nextSkip != null)
    throw new Error(
      "Multiple PR results. Open Azure Repos to choose the pull request.",
    );
  const active = matches[0];
  const pr: GitPr | null = active
    ? {
        number: active.pullRequestId,
        title: active.title,
        state: "open",
        url: azurePrUrl({ ...result.target, number: active.pullRequestId }),
      }
    : null;
  return {
    provider: "azure" as const,
    label: `Azure Repos · ${account.account} · ${location.site.split("/").pop()}/${location.project}/${location.repository} · ${remote}`,
    pr,
    async create(content: PrContent) {
      await check(content);
      const created = await azurePrCreate(
        target,
        content.head,
        content.base,
        content.title,
        content.body,
        false,
      );
      return azurePrUrl(created.target);
    },
  };
}
