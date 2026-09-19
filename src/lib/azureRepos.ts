import { invoke } from "@tauri-apps/api/core";

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
  creationDate?: string;
  closedDate?: string;
  repositoryName?: string;
  projectName?: string;
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
  "threads" | "iterations" | "changes" | "policies" | "statuses" | "workitems";
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
    publishedDate?: string;
    author?: { displayName: string };
  }[];
};

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
export function readAzurePrActivity(target: AzurePrTarget) {
  return invoke<{ pr: AzurePr; revision: string; activityDates: string[] }>("azure_pr_read", {
    target,
    section: "activity",
    expectedRevision: null,
    iteration: null,
    skip: 0,
  });
}
export type AzurePrDiffItem = {
  path: string;
  originalPath?: string | null;
  changeType?: string;
  /** Anchors inline review threads to this change. */
  changeTrackingId?: number;
  original?: string;
  modified?: string;
  /** Content unavailable for this file (binary, oversized, read failure). */
  error?: string;
};
export type AzurePrDiff = {
  items: AzurePrDiffItem[];
  nextSkip: null;
  revision: string;
  iteration?: number;
  truncated?: boolean;
};
/** The aggregated base → latest-iteration diff — same shape GitHub/GitLab
 * render from one patch. */
export function readAzurePrDiff(target: AzurePrTarget, revision: string) {
  return invoke<AzurePrDiff>("azure_pr_read", {
    target,
    section: "diff",
    expectedRevision: revision,
    iteration: null,
    skip: 0,
  });
}

export type AzurePrReviewEvent = "comment" | "approve" | "reject";

/** One pending inline comment — the anchor Azure's thread API expects. */
export type AzureReviewCommentDraft = {
  path: string;
  line: number;
  side: "left" | "right";
  /** Characters the comment spans — Azure positions are offset ranges. */
  offset: number;
  body: string;
};

export function azurePrThreadComment(
  target: AzurePrTarget,
  revision: string,
  threadId: number,
  body: string,
) {
  return invoke<{ revision: string }>("azure_pr_thread_comment", {
    target,
    expectedRevision: revision,
    threadId,
    body,
  });
}

/**
 * Submit a review — the event, pending inline comments and summary body,
 * pinned to the revision the reviewer saw (like the GitHub review submit).
 */
export function azurePrSubmitReview(
  target: AzurePrTarget,
  revision: string,
  review: {
    event: AzurePrReviewEvent;
    body: string;
    comments: AzureReviewCommentDraft[];
  },
) {
  return invoke<{ revision: string }>("azure_pr_submit_review", {
    target,
    expectedRevision: revision,
    event: review.event,
    body: review.body,
    comments: review.comments,
  });
}
