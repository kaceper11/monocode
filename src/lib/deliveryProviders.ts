import { gitPrStatus } from "./fs";
import { githubRepo } from "./githubTasks";
import { parseAzurePrLocation } from "./azureRepos";
import { gitlabMrForBranch } from "./gitlab";

export type DeliveryProvider = "github" | "azure" | "gitlab";
export const DELIVERY_PROVIDERS_CHANGED = "monocode:delivery-providers";
const key = "monocode.deliveryProviders.v1";
const scope = (cwd: string, branch: string, session: string | undefined, kind: string) => JSON.stringify([cwd, branch, session ?? "", kind]);
function saved(): Record<string, DeliveryProvider> {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, provider]) => provider === "github" || provider === "azure" || provider === "gitlab").slice(-100)) as Record<string, DeliveryProvider> : {};
  } catch { return {}; }
}
export function deliveryProvider(cwd: string, branch: string, session: string | undefined, kind: "pr" | "ci") {
  return saved()[scope(cwd, branch, session, kind)];
}
export function saveDeliveryProvider(cwd: string, branch: string, session: string | undefined, kind: "pr" | "ci", provider: DeliveryProvider | "") {
  const values = saved(), id = scope(cwd, branch, session, kind);
  delete values[id];
  if (provider) values[id] = provider;
  localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(values).slice(-100))));
  window.dispatchEvent(new Event(DELIVERY_PROVIDERS_CHANGED));
}
export function repositoryProvider(remotes: { name: string; url: string }[], upstream?: string | null): DeliveryProvider | undefined {
  const selected = remotes.find(remote => remote.name === upstream);
  const providers = (selected ? [selected] : remotes).map(({ url }) => {
    try { parseAzurePrLocation(url); return "azure" as const; } catch { /* Not Azure. */ }
    if (/^git@github\.com:[^/]+\/[^/]+$/.test(url)) return "github" as const;
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "github.com" && ["https:", "ssh:"].includes(parsed.protocol) && !parsed.password && /^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)) return "github" as const;
    } catch { /* Unknown remotes require a choice. */ }
    return undefined;
  });
  return providers.length && providers.every(value => value === providers[0]) ? providers[0] : undefined;
}
/**
 * Splits a PR row's provider into `detected` — what "Auto" resolves to from
 * the remotes alone — and `effective`, the explicit override when present.
 * Keeping them separate matters for display: an explicit pick must not
 * rewrite what Auto claims it will do. `upstream` is `@{upstream}` output
 * like `origin/feature`; a local upstream (`main`) names no remote, so the
 * repo's default remote is used instead.
 */
export function resolvePrProviders(input: {
  remotes: { name: string; url: string }[];
  upstream?: string | null;
  remote?: string | null;
  override?: DeliveryProvider;
}): { detected?: DeliveryProvider; effective?: DeliveryProvider } {
  const upstreamRemote =
    input.upstream && input.upstream.includes("/")
      ? input.upstream.split("/")[0]
      : (input.remote ?? undefined);
  const detected = repositoryProvider(input.remotes, upstreamRemote);
  return { detected, effective: input.override ?? detected };
}

/** owner/repo + PR number from a `github.com/<owner>/<repo>/pull/<n>` link. */
export function parseGithubPrLocation(url: string): { repo: string; number: number } {
  let target: URL;
  try {
    target = new URL(url.trim());
  } catch {
    throw new Error("GitHub returned an invalid PR link.");
  }
  const match = target.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "github.com" ||
    target.username ||
    target.password ||
    !match
  )
    throw new Error("GitHub returned an invalid PR link.");
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

/**
 * The exact GitHub PR a delivery tab is bound to — explicit `repo` +
 * `number`, never guessed from the checkout alone. `prUrl` (an inbox item
 * link) carries both; otherwise the branch's open PR and the checkout's
 * repository resolve them.
 */
export async function githubDeliveryTarget(
  cwd: string,
  prUrl?: string,
): Promise<{ repo: string; number: number }> {
  if (prUrl) return parseGithubPrLocation(prUrl);
  const pr = await gitPrStatus(cwd);
  if (!pr) throw new Error("No GitHub PR found for this branch. Open the PR branch or choose another provider.");
  if (pr.url) {
    try {
      return parseGithubPrLocation(pr.url);
    } catch { /* Fall back to the checkout repo + reported number. */ }
  }
  const repo = (await githubRepo(cwd)).trim();
  if (!repo) throw new Error("This checkout does not resolve to a GitHub repository.");
  return { repo, number: pr.number };
}
/** GitLab has no standalone branch-CI review — pipeline state rides on the
 * merge request surface. */
export const GITLAB_CI_ON_MR =
  "GitLab pipelines are reviewed on the merge request — open PRs instead.";

/**
 * The exact GitLab MR a delivery tab is bound to — the checkout's
 * configured-host project plus the open MR for its source branch. GitLab
 * identity resolves only from GitLab bindings, never inferred from
 * GitHub/Azure configuration.
 */
export async function gitlabDeliveryTarget(
  cwd: string,
  branch: string,
): Promise<{ repo: string; number: number }> {
  if (!branch.trim())
    throw new Error("No branch for this checkout. Open the MR branch or choose another provider.");
  // `mr.repo` is resolved fresh in the backend — strictly more current than
  // the cached gitlabRepo, so bind the tab to what the lookup actually used.
  const mr = await gitlabMrForBranch(cwd, branch);
  if (!mr.repo.trim())
    throw new Error("This checkout does not resolve to a GitLab project.");
  return { repo: mr.repo, number: mr.number };
}
