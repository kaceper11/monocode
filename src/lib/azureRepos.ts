export const AZURE_PR_ASSOCIATIONS_CHANGED = "monocode:azure-pr-associations";
import { invoke } from "@tauri-apps/api/core";
import { contextFromText, type AgentContext } from "./agentContext";
import type { LinkedWorkItem } from "./session";
import { sessionWorkItems } from "./sessionWorkItem";
import { pathKey } from "./paths";
import { ensureDeliveryWatcher, unwatchAzurePrDelivery } from "./watchers";
import type { AzureStatus } from "./azure";

export type AzurePrTarget = {
  site: string;
  accountId: string;
  project: string;
  repository: string;
  number: number;
};
export type AzurePr = {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  sourceRefName: string;
  targetRefName: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  /** Azure's merge verdict — "conflicts" among others; empty when unknown. */
  mergeStatus?: string;
  /** Target branch head at read time (best-effort — absent when the commits
   * lookup was refused). Compare to lastMergeTargetCommit for behind. */
  targetHead?: string;
  reviewers: {
    id: string;
    displayName: string;
    vote: number;
    isRequired?: boolean;
  }[];
};
export type AzurePrPage<T> = {
  items: T[];
  nextSkip: number | null;
  revision: string;
};
export type AzurePrSection =
  "threads" | "workitems" | "iterations" | "changes" | "policies" | "statuses";
export type AzurePrThread = {
  id: number;
  status: string;
  isDeleted?: boolean;
  threadContext?: {
    filePath: string;
    rightFileStart?: { line: number };
    leftFileStart?: { line: number };
  };
  pullRequestThreadContext?: {
    iterationContext?: {
      firstComparingIteration: number;
      secondComparingIteration: number;
    };
  };
  comments: {
    id: number;
    content?: string;
    isDeleted?: boolean;
    author?: { displayName: string };
  }[];
};
export type AzurePrAssociation = {
  target: AzurePrTarget;
  pr: AzurePr;
  revision: string;
  account: string;
  projectName: string;
  repositoryName: string;
  cwd: string;
  branch: string;
  sourceSessionId?: string;
};

export const azurePrKey = (target: AzurePrTarget) =>
  JSON.stringify([
    target.site,
    target.accountId,
    target.project,
    target.repository,
    target.number,
  ]);
export type AzurePrDiscoveryGroup = Awaited<ReturnType<typeof findAzurePrs>> & {
  origins: string[];
};

/** Only explicit story references and configured remotes; never infer a repo from its issue provider. */
export async function discoverAzurePrs(
  cwd: string,
  branch: string,
  status: AzureStatus,
  linkedWorkItem?: LinkedWorkItem,
  current: () => boolean = () => true,
) {
  if (!status.connected || !status.accountId)
    throw new Error("Connect Azure DevOps before discovering PRs.");
  const accountId = status.accountId;
  const errors: string[] = [];
  const sources = new Map<
    string,
    { target: AzurePrTarget; origins: string[]; branch: string }
  >();
  const add = (raw: string, origin: string, lookupBranch = "") => {
    let location: Omit<AzurePrTarget, "accountId">;
    try {
      location = parseAzurePrLocation(raw);
    } catch {
      return;
    }
    if (!location.number && !lookupBranch) return;
    if (location.site !== status.site) {
      errors.push(
        `${origin}: PRs in ${location.site} need that Azure connection.`,
      );
      return;
    }
    const target = { ...location, accountId };
    const key = azurePrKey(target);
    const previous = sources.get(key);
    if (previous) {
      if (!previous.origins.includes(origin)) previous.origins.push(origin);
    } else
      sources.set(key, { target, origins: [origin], branch: lookupBranch });
  };
  const stories = sessionWorkItems({ linkedWorkItem }).slice(0, 20);
  // Bound concurrent story reads and repository lookups; closing the dialog stops subsequent batches.
  for (let start = 0; start < stories.length && current(); start += 2) {
    await Promise.all(
      stories.slice(start, start + 2).map(async (story) => {
        const label =
          story.identifier ||
          story.title ||
          `${story.provider ?? "GitHub"} #${story.number}`;
        add(story.url, `Linked to session · ${label}`);
        for (const url of (story.context ?? "")
          .slice(0, 32_000)
          .match(/https:\/\/[^\s<>"')\]]+/g) ?? []) {
          add(url, `Captured reference · ${label}`);
        }
        if (
          story.kind !== "issue" ||
          !["azure", "jira"].includes(story.provider ?? "")
        )
          return;
        try {
          const result = await invoke<{ links: string[]; more: boolean }>(
            "azure_pr_story_links",
            {
              provider: story.provider,
              url: story.url,
              site: status.site,
              accountId: status.accountId,
            },
          );
          for (const url of result.links) add(url, `Story link · ${label}`);
          if (result.more)
            errors.push(
              `${label}: first 50 story links shown; open the story for more.`,
            );
        } catch (error) {
          errors.push(`${label}: ${String(error)}`);
        }
      }),
    );
  }
  if (branch && current()) {
    try {
      const remotes = await invoke<{
        items: { name: string; url: string }[];
        more: boolean;
      }>("azure_pr_remotes", { cwd, branch });
      for (const remote of remotes.items)
        add(remote.url, `Branch ${branch} · remote ${remote.name}`, branch);
      if (remotes.more)
        errors.push(
          "First 20 Azure remotes shown; link another repository manually.",
        );
    } catch (error) {
      errors.push(`Branch discovery: ${String(error)}`);
    }
  }
  const priority = (source: { origins: string[] }) =>
    source.origins.some(
      (origin) =>
        origin.startsWith("Story link") ||
        origin.startsWith("Linked to session"),
    )
      ? 0
      : source.origins.some((origin) => origin.startsWith("Captured reference"))
        ? 1
        : 2;
  const bounded = [...sources.values()]
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, 20);
  if (sources.size > 20)
    errors.push(
      "First 20 PR/repository sources inspected; open the story or link another PR manually.",
    );
  const groups: AzurePrDiscoveryGroup[] = [];
  for (let start = 0; start < bounded.length && current(); start += 2) {
    const results = await Promise.all(
      bounded.slice(start, start + 2).map(async (source) => {
        try {
          return {
            ...(await findAzurePrs(source.target, source.branch, 0)),
            origins: source.origins,
          };
        } catch (error) {
          errors.push(`${source.origins.join(", ")}: ${String(error)}`);
          return null;
        }
      }),
    );
    for (const result of results) if (result) groups.push(result);
  }
  // A PR can be linked to several stories and also match the branch. Keep one row, all provenance.
  const seen = new Map<string, { group: AzurePrDiscoveryGroup; pr: AzurePr }>();
  for (const group of groups)
    group.items = group.items.filter((pr) => {
      const key = azurePrKey({ ...group.target, number: pr.pullRequestId });
      const previous = seen.get(key);
      if (!previous) {
        seen.set(key, { group, pr });
        return true;
      }
      for (const origin of group.origins)
        if (!previous.group.origins.includes(origin))
          previous.group.origins.push(origin);
      return false;
    });
  return { groups, errors: [...new Set(errors)] };
}

/** Accept a PR URL or HTTPS/SSH repo remote. The caller still chooses a candidate. */
export function parseAzurePrLocation(
  raw: string,
): Omit<AzurePrTarget, "accountId"> {
  const input = raw.trim();
  if (input.length > 2048) throw new Error("Azure link is too long.");
  const ssh = input.match(
    /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/,
  );
  let parts: string[];
  if (ssh) {
    parts = ssh.slice(1);
  } else {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Paste an Azure PR link or repository remote.");
    }
    if (url.search || url.hash || url.password || url.port)
      throw new Error(
        "Use an Azure link without credentials, query or fragment.",
      );
    const path = url.pathname.split("/").filter(Boolean);
    const legacyOrganization = url.hostname.match(
      /^([a-z0-9-]+)\.visualstudio\.com$/,
    )?.[1];
    if (legacyOrganization && url.protocol === "https:") {
      if (path[0] === "DefaultCollection") path.shift();
      path.unshift(legacyOrganization);
    }
    if (
      url.protocol === "ssh:" &&
      url.hostname === "ssh.dev.azure.com" &&
      url.username === "git" &&
      path[0] === "v3" &&
      path.length === 4
    ) {
      parts = path.slice(1);
    } else if (
      url.protocol === "https:" &&
      (url.hostname === "dev.azure.com" || !!legacyOrganization) &&
      (!url.username ||
        url.username.toLowerCase() === path[0]?.toLowerCase()) &&
      path[2] === "_git" &&
      (path.length === 4 || (path.length === 6 && path[4] === "pullrequest"))
    ) {
      parts = [
        path[0],
        path[1],
        path[3],
        ...(path.length === 6 ? [path[5]] : []),
      ];
    } else {
      throw new Error(
        "Use an Azure DevOps Services PR link or HTTPS/SSH repository remote.",
      );
    }
  }
  try {
    parts = parts.map(decodeURIComponent);
  } catch {
    throw new Error("Invalid encoding in Azure link.");
  }
  if (
    !/^[a-z0-9-]{1,100}$/i.test(parts[0]) ||
    parts
      .slice(1, 3)
      .some(
        (value) =>
          !value ||
          value.length > 256 ||
          /[\x00-\x1f\x7f/\\]/.test(value) ||
          value === "." ||
          value === "..",
      )
  )
    throw new Error("Use a valid Azure organization, project and repository.");
  const number = parts[3] == null ? 0 : Number(parts[3]);
  if (
    parts[3] != null &&
    (!/^[1-9]\d*$/.test(parts[3]) || number > 2_147_483_647)
  )
    throw new Error("Use a positive PR number.");
  return {
    site: `https://dev.azure.com/${parts[0].toLowerCase()}`,
    project: parts[1],
    repository: parts[2],
    number,
  };
}

export function azurePrUrl(target: AzurePrTarget) {
  // Construct links from validated identity, never navigate a provider-supplied URL.
  const location = parseAzurePrLocation(
    `${target.site}/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(target.repository)}/pullrequest/${target.number}`,
  );
  return `${location.site}/${encodeURIComponent(location.project)}/_git/${encodeURIComponent(location.repository)}/pullrequest/${location.number}`;
}

export function findAzurePrs(target: AzurePrTarget, branch: string, skip = 0) {
  return invoke<
    Omit<AzurePrPage<AzurePr>, "revision"> & {
      target: AzurePrTarget;
      projectName: string;
      repositoryName: string;
    }
  >("azure_pr_list", { target, branch, skip });
}
export type AzurePrCreateResult = {
  pr: AzurePr;
  existing: boolean;
  revision: string;
  target: AzurePrTarget;
  repositoryName: string;
  projectName: string;
  account: string;
};
/** `target.project`/`target.repository` may be names; the response carries canonical IDs. */
export function azurePrCreate(
  target: AzurePrTarget,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description: string,
  draft: boolean,
) {
  return invoke<AzurePrCreateResult>("azure_pr_create", {
    target,
    sourceBranch,
    targetBranch,
    title,
    description,
    draft,
  });
}
export function azurePrUpdate(target: AzurePrTarget, description: string) {
  return invoke<{ pr: AzurePr; revision: string }>("azure_pr_update", {
    target,
    description,
  });
}
export function readAzurePr(
  target: AzurePrTarget,
  expectedRevision: string | null = null,
) {
  return invoke<{ pr: AzurePr; revision: string }>("azure_pr_read", {
    target,
    section: "summary",
    expectedRevision,
    iteration: null,
    skip: 0,
  });
}
export function readAzurePrSection<T>(
  target: AzurePrTarget,
  revision: string,
  section: AzurePrSection,
  skip = 0,
  iteration: number | null = null,
) {
  return invoke<AzurePrPage<T>>("azure_pr_read", {
    target,
    section,
    expectedRevision: revision,
    iteration,
    skip,
  });
}
export function readAzurePrFile(
  target: AzurePrTarget,
  revision: string,
  iteration: number,
  filePath: string,
  skip: number,
) {
  return invoke<{
    path: string;
    originalPath: string;
    original: string;
    modified: string;
    sourceCommit: string;
    baseCommit: string;
    iteration: number;
    revision: string;
  }>("azure_pr_read", {
    target,
    section: "file",
    expectedRevision: revision,
    iteration,
    filePath,
    skip,
  });
}

export function azurePrContext(
  association: AzurePrAssociation,
  thread: AzurePrThread,
): AgentContext {
  const { target, pr, revision, cwd, sourceSessionId } = association;
  const origin = `${azurePrUrl(target)} · account ${association.account} (${target.accountId}) · repository ${target.repository} · revision ${revision} · checkout ${cwd} · session ${sourceSessionId ?? "not assigned"}`;
  const file = thread.threadContext;
  const iteration = thread.pullRequestThreadContext?.iterationContext;
  const comments = thread.comments
    .filter((comment) => !comment.isDeleted)
    .slice(0, 50)
    .map(
      (comment) =>
        `${comment.author?.displayName ?? "Unknown author"} (comment ${comment.id}):\n${comment.content ?? ""}`,
    )
    .join("\n\n");
  const context = contextFromText(
    `Azure PR #${pr.pullRequestId}: ${pr.title} · thread ${thread.id}`,
    [
      `PR state: ${pr.status}. Thread state: ${thread.status}.`,
      `Branches: ${pr.sourceRefName} → ${pr.targetRefName}`,
      `Revision: ${revision}`,
      file
        ? `File: ${file.filePath}; right line ${file.rightFileStart?.line ?? "unknown"}; left line ${file.leftFileStart?.line ?? "unknown"}`
        : "General discussion",
      iteration
        ? `Thread iterations: ${iteration.firstComparingIteration} → ${iteration.secondComparingIteration}`
        : "Thread iteration not supplied by Azure",
      comments,
    ].join("\n\n"),
    origin,
  );
  context.entries[0].truncated = thread.comments.length > 50;
  return context;
}

const ASSOCIATIONS_KEY = "monocode.azurePrAssociations.v1";
export const azurePrScope = (cwd: string, branch: string, session?: string) =>
  JSON.stringify([cwd, branch, session ?? null]);
/** Every saved association, validated — one storage read for callers that
 * aggregate several scopes (e.g. a task's repository children). */
export function allAzurePrAssociations(): AzurePrAssociation[] {
  try {
    const rows: unknown = JSON.parse(
      localStorage.getItem(ASSOCIATIONS_KEY) ?? "[]",
    );
    if (!Array.isArray(rows)) return [];
    return rows
      .slice(0, 100)
      .filter((value) => {
        try {
          if (
            !value ||
            !value.target ||
            typeof value.target.accountId !== "string" ||
            typeof value.revision !== "string" ||
            ![
              value.account,
              value.projectName,
              value.repositoryName,
              value.target.site,
              value.target.project,
              value.target.repository,
            ].every((field) => typeof field === "string") ||
            !Number.isInteger(value.target.number) ||
            !value.pr ||
            ![
              value.pr.title,
              value.pr.status,
              value.pr.sourceRefName,
              value.pr.targetRefName,
            ].every((field) => typeof field === "string") ||
            value.pr.pullRequestId !== value.target.number ||
            !Array.isArray(value.pr.reviewers) ||
            !value.pr.reviewers.every(
              (reviewer: AzurePr["reviewers"][number]) =>
                reviewer &&
                typeof reviewer.displayName === "string" &&
                typeof reviewer.id === "string" &&
                Number.isFinite(reviewer.vote),
            )
          )
            return false;
          azurePrUrl(value.target);
          return true;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
export function loadAzurePrAssociations(
  cwd: string,
  branch: string,
  session?: string,
): AzurePrAssociation[] {
  return allAzurePrAssociations().filter(
    (row) =>
      row.cwd === cwd &&
      row.branch === branch &&
      row.sourceSessionId === session,
  );
}
export const loadAzurePrAssociation = (
  cwd: string,
  branch: string,
  session?: string,
) => loadAzurePrAssociations(cwd, branch, session)[0] ?? null;
export function saveAzurePrAssociation(
  value: AzurePrAssociation | null,
  cwd: string,
  branch: string,
  session?: string,
  removeTarget?: AzurePrTarget,
) {
  let rows: AzurePrAssociation[] = [];
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(ASSOCIATIONS_KEY) ?? "[]",
    );
    if (Array.isArray(stored)) rows = stored;
  } catch {
    /* Recover only this feature's malformed data. */
  }
  // The in-scope rows this write can drop or replace — captured before
  // filtering so a departed link can lift its watcher below.
  const scopeRows = rows.filter(
    (row) =>
      row?.target &&
      azurePrScope(row.cwd, row.branch, row.sourceSessionId) ===
        azurePrScope(cwd, branch, session),
  );
  // A re-save of an already-linked PR is a refresh — only a first-time link
  // registers a watcher, so removing that watcher by hand sticks.
  const linked = value?.target
    ? scopeRows.some(
        (row) => azurePrKey(row.target) === azurePrKey(value.target),
      )
    : false;
  rows = rows.filter(
    (row) =>
      row &&
      (azurePrScope(row.cwd, row.branch, row.sourceSessionId) !==
        azurePrScope(cwd, branch, session) ||
        (!!(value?.target ?? removeTarget) &&
          !!row.target &&
          azurePrKey(row.target) !==
            azurePrKey((value?.target ?? removeTarget)!))),
  );
  // Store only the bounded summary and exact association, never thread bodies or credentials.
  if (value)
    rows.unshift({
      ...value,
      pr: {
        ...value.pr,
        description: undefined,
        title: value.pr.title.slice(0, 500),
        reviewers: value.pr.reviewers.slice(0, 50),
      },
    });
  localStorage.setItem(ASSOCIATIONS_KEY, JSON.stringify(rows.slice(0, 100)));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AZURE_PR_ASSOCIATIONS_CHANGED));
  // A saved link owns a review watcher: registered on first link, lifted only
  // when no remaining row — in any session scope — still covers the delivery
  // at this checkout+branch. Switching the displayed PR keeps the old link's
  // row, so its watcher stays too. A terminal re-save also keeps the row —
  // the next poll retires the watcher with its goodbye row instead.
  const covered = (target: AzurePrTarget) =>
    rows.some(
      (row) =>
        row?.target &&
        azurePrKey(row.target) === azurePrKey(target) &&
        pathKey(row.cwd) === pathKey(cwd) &&
        row.branch === branch,
    );
  for (const row of scopeRows)
    if (!covered(row.target)) unwatchAzurePrDelivery(row.target, cwd, branch);
  if (value && value.pr.status === "active" && !linked) {
    const sessionId = session ?? value.sourceSessionId;
    ensureDeliveryWatcher({
      kind: "azure-pr",
      target: value.target,
      projectName: value.projectName,
      repositoryName: value.repositoryName,
      cwd,
      branch,
      ...(sessionId ? { sessionId } : {}),
    });
  }
}
