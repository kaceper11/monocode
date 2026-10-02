// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { addTask, loadBoard, updateTask } from "./boardStore";
import {
  parseReplyBundle,
  replyDraftKey,
  replyScope,
  type ReplyRequest,
} from "./replyDrafts";
import type { DeliverySnapshot } from "./delivery";

const request: ReplyRequest = {
  id: "request",
  sessionId: "session",
  scope: "scope",
  identity: "identity",
  fingerprint: "fingerprint",
  threadIds: ["thread"],
};
const bundle = (
  id = "request",
  replies: unknown[] = [{ threadId: "thread", body: "  Thanks, fixed.  " }],
) => JSON.stringify({ requestId: id, replies });
beforeEach(() => localStorage.clear());

it("imports only the exact request's allowed threads with bounded valid bodies", () => {
  expect(
    parseReplyBundle(
      `Here are the drafts:\n\`\`\`json\n${bundle()}\n\`\`\``,
      request,
    ),
  ).toEqual([{ threadId: "thread", body: "Thanks, fixed." }]);
  for (const output of [
    bundle("another"),
    bundle("request", [{ threadId: "unknown", body: "x" }]),
    bundle("request", [
      { threadId: "thread", body: "x" },
      { threadId: "thread", body: "y" },
    ]),
    bundle("request", [{ threadId: "thread", body: " " }]),
    bundle("request", [{ threadId: "thread", body: "x".repeat(32_769) }]),
    "x".repeat(128 * 1024 + 1),
  ])
    expect(() => parseReplyBundle(output, request)).toThrow();
});

it("finds the bundle in a later fence when earlier blocks carry other content", () => {
  expect(
    parseReplyBundle(
      `Here's the diff:\n\`\`\`diff\n-x\n+y\n\`\`\`\nDrafts:\n\`\`\`json\n${bundle()}\n\`\`\``,
      request,
    ),
  ).toEqual([{ threadId: "thread", body: "Thanks, fixed." }]);
  // A fence that parses but names another request is skipped, not trusted.
  expect(
    parseReplyBundle(
      `\`\`\`json\n${bundle("other")}\n\`\`\`\n\`\`\`json\n${bundle()}\n\`\`\``,
      request,
    ),
  ).toEqual([{ threadId: "thread", body: "Thanks, fixed." }]);
});

it("turns malformed JSON into the request-mismatch error", () => {
  for (const output of [
    "```json\n{not json\n```",
    "The replies are { requestId:",
    "",
  ])
    expect(() => parseReplyBundle(output, request)).toThrow(
      "This output does not match the reviewed reply request.",
    );
});

it("keeps drafts through revision changes while separating provider and account identity", () => {
  const snapshot = {
    source: {
      provider: "github",
      repo: "a/b",
      host: "github.com",
      account: "1",
    },
    pr: { url: "https://github.com/a/b/pull/1" },
    headSha: "old",
  } as DeliverySnapshot;
  const scope = replyScope(snapshot);
  expect(replyScope({ ...snapshot, headSha: "new" })).toBe(scope);
  expect(
    replyScope({ ...snapshot, source: { ...snapshot.source, account: "2" } }),
  ).not.toBe(scope);
  const key = replyDraftKey(scope, "thread");
  const id = addTask({ title: "Task", links: [], workstreams: [] })!;
  updateTask(id, {
    replyDrafts: { [key]: "Manually edited draft" },
    replyRequest: request,
  });
  updateTask(id, { title: "Renamed" });
  expect(loadBoard().tasks[0]).toMatchObject({
    replyDrafts: { [key]: "Manually edited draft" },
    replyRequest: request,
  });
  expect(localStorage.getItem("monocode.board.v1.before-delivery")).toContain(
    "Task",
  );
});
