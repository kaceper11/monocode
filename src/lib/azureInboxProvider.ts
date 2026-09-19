import { invoke } from "@tauri-apps/api/core";
import type {
  InboxItem,
  GithubWorkItemComment,
  GithubWorkItemThread,
} from "./githubTasks";
import {
  ciRead,
  ciState,
  type CiTarget,
  type CiRun,
  type CiJobs,
  type CiLog,
} from "./azurePipelines";
import type { InboxChecksPage } from "./inboxProvider";
import type { InboxProviderAdapter } from "./inboxProvider";
import {
  parseAzurePrLocation,
  readAzurePr,
  readAzurePrDiff,
  readAzurePrSection,
  azurePrSubmitReview,
  azurePrThreadComment,
  type AzurePrThread,
} from "./azureRepos";

const emptyThread = (): GithubWorkItemThread => ({
  comments: [],
  commits: [],
  truncated: false,
  reviewDecision: "",
  baseRefName: "",
  headRefName: "",
});

export function azureDeliveryProvider(item: InboxItem): InboxProviderAdapter {
  if (item.kind === "ci") {
    type Evidence = InboxItem & {
      evidence: { target: CiTarget; run: Pick<CiRun, "id" | "revision"> };
    };
    let summary: Promise<Evidence> | undefined;
    const read = () =>
      (summary ??= (async () => {
        const delivery = item.delivery;
        if (!delivery || !item.site)
          throw new Error("Missing pipeline identity. Refresh Inbox.");
        const fresh = await invoke<Evidence>("azure_ci_inbox_summary", {
          site: item.site,
          accountId: delivery.accountId,
          project: delivery.project,
          number: item.number,
        });
        if (
          fresh.delivery?.repository !== delivery.repository ||
          fresh.delivery?.definition !== delivery.definition
        )
          throw new Error("Pipeline identity changed. Refresh Inbox.");
        return fresh;
      })().catch((error) => {
        summary = undefined;
        throw error;
      }));
    const checks = async (skip = 0): Promise<InboxChecksPage> => {
      const {
        evidence: { target, run },
      } = await read();
      const page = await ciRead<CiJobs>(target, null, run, "jobs", { skip });
      return {
        items: page.items.map((job) => ({
          id: job.id,
          name: [job.parentName, job.name].filter(Boolean).join(" / "),
          status: ciState(job.state, job.result),
          ...(job.logId && job.attempt
            ? {
                log: async () => {
                  const log = await ciRead<CiLog>(target, null, run, "log", {
                    recordId: job.id,
                    attempt: job.attempt!,
                    logId: job.logId!,
                  });
                  return `Lines ${log.startLine + 1}–${log.endLine + 1} of ${log.lineCount} · attempt ${log.attempt}\n\n${log.text}`;
                },
              }
            : {}),
        })),
        ...(page.nextSkip != null
          ? { more: () => checks(page.nextSkip!) }
          : {}),
      };
    };
    return {
      peekDetails: () => null,
      peekThread: () => null,
      thread: async () => emptyThread(),
      checks,
      details: async () => {
        const fresh = await read();
        return {
          author: fresh.delivery!.author,
          body: [
            fresh.title,
            `Status: ${fresh.state}`,
            `Branch: ${fresh.delivery!.branch}`,
            `Commit: ${fresh.delivery!.commit}`,
          ].join("\n\n"),
        };
      },
    };
  }
  const target = () => ({
    ...parseAzurePrLocation(item.url),
    accountId: item.delivery?.accountId ?? item.account ?? "",
  });
  // One displayed revision binds threads, diff, and writes. Refresh creates a new adapter.
  let summary: ReturnType<typeof readAzurePr> | undefined;
  const read = () =>
    (summary ??= Promise.resolve()
      .then(() => readAzurePr(target()))
      .catch((error) => {
        summary = undefined;
        throw error;
      }));
  return {
    peekDetails: () => null,
    peekThread: () => null,
    details: async () => {
      const { pr } = await read();
      return {
        body: pr.description ?? "",
        author: item.delivery?.author ?? "",
        baseRefName: pr.targetRefName.replace(/^refs\/heads\//, ""),
        headRefName: pr.sourceRefName.replace(/^refs\/heads\//, ""),
      };
    },
    thread: async () => {
      const { revision } = await read();
      const page = await readAzurePrSection<AzurePrThread>(
        target(),
        revision,
        "threads",
      );
      return {
        ...emptyThread(),
        truncated: page.nextSkip !== null,
        comments: page.items
          .filter((t) => !t.isDeleted)
          .flatMap((t) => {
            const comments: GithubWorkItemComment[] = t.comments
              .filter((c) => !c.isDeleted)
              .map((c) => ({
                id: `${t.id}:${c.id}`,
                kind: t.threadContext ? "review_comment" : "comment",
                author: c.author?.displayName ?? "",
                body: c.content ?? "",
                createdAt: c.publishedDate ?? "",
                url: item.url,
                state: "",
                path: t.threadContext?.filePath ?? "",
                line:
                  t.threadContext?.rightFileStart?.line ??
                  t.threadContext?.leftFileStart?.line ??
                  null,
                resolved: ["fixed", "closed", "wontFix", "byDesign"].includes(
                  t.status,
                ),
                threadId: String(t.id),
                replies: [],
              }));
            return comments.length
              ? [{ ...comments[0]!, replies: comments.slice(1) }]
              : [];
          }),
      };
    },
    checks: async () => {
      const { revision } = await read();
      type Check = {
        id: number;
        state?: string;
        status?: string;
        description?: string;
        context?: { name?: string; genre?: string };
        configuration?: { type?: { displayName?: string } };
        targetUrl?: string;
      };
      const load = async (
        section: "policies" | "statuses",
        skip = 0,
      ): Promise<InboxChecksPage> => {
        const page = await readAzurePrSection<Check>(
          target(),
          revision,
          section,
          skip,
        );
        return {
          items: page.items.map((row) => ({
            id: `${section}:${row.id}`,
            name:
              row.context?.name ||
              row.configuration?.type?.displayName ||
              row.description ||
              section,
            status: row.state || row.status || "unknown",
            url: row.targetUrl,
          })),
          ...(page.nextSkip != null
            ? { more: () => load(section, page.nextSkip!) }
            : {}),
        };
      };
      // Show policies first; the same More action proceeds to provider statuses.
      const appendStatuses = (page: InboxChecksPage): InboxChecksPage => ({
        items: page.items,
        more: page.more
          ? async () => appendStatuses(await page.more!())
          : () => load("statuses"),
      });
      return appendStatuses(await load("policies"));
    },
    diff: async () => readAzurePrDiff(target(), (await read()).revision),
    replyMode: "thread",
    comment: async (body, reply) => {
      const { revision } = await read();
      if (reply?.threadId)
        return azurePrThreadComment(
          target(),
          revision,
          Number(reply.threadId),
          body,
        );
      return azurePrSubmitReview(target(), revision, {
        event: "comment",
        body,
        comments: [],
      });
    },
  };
}
