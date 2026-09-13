import { openUrl } from "@tauri-apps/plugin-opener";
import { gitPrStatus } from "./fs";
import { parseAzurePrLocation } from "./azureRepos";
import { gitlabMrForBranch, gitlabRepo } from "./gitlab";

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
export async function openGitHubDelivery(cwd: string, kind: "pr" | "ci", current: () => boolean, prUrl?: string) {
  const url = prUrl ?? (await gitPrStatus(cwd))?.url;
  if (!current()) return;
  if (!url) throw new Error("No GitHub PR found for this branch. Open the PR branch or choose another provider.");
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(target.pathname)) throw new Error("GitHub returned an invalid PR link.");
  target.search = "";
  target.hash = "";
  target.pathname = target.pathname.replace(/\/$/, "") + (kind === "ci" ? "/checks" : "");
  await openUrl(target.href);
}
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
  const repo = (await gitlabRepo(cwd)).trim();
  if (!repo) throw new Error("This checkout does not resolve to a GitLab project.");
  const mr = await gitlabMrForBranch(cwd, branch);
  return { repo, number: mr.number };
}
