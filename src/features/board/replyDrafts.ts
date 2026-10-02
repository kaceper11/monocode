import type { DeliverySnapshot, Evidence } from "./delivery";
import type { BoardTask } from "./boardStore";

export type ReplyRequest = NonNullable<BoardTask["replyRequest"]>;
export type Reply = { threadId: string; body: string };
export function replyScope(snapshot: DeliverySnapshot): string {
  return JSON.stringify([snapshot.source, snapshot.pr?.url]);
}
export function replyDraftKey(scope: string, threadId: string): string {
  return JSON.stringify([scope, threadId]);
}
export function replyInstructions(
  requestId: string,
  items: readonly Evidence[],
): string {
  return `Draft a separate reply for each selected PR thread, using the current code as reference. Do not change code, post replies, or resolve threads. Return one JSON code block with this shape: {"requestId":${JSON.stringify(requestId)},"replies":[{"threadId":"...","body":"..."}]}. Use only these exact thread IDs: ${JSON.stringify(items.filter((item) => item.selected).map((item) => item.id.replace(/^comment:/, "")))}.`;
}
export function parseReplyBundle(text: string, request: ReplyRequest): Reply[] {
  if (text.length > 128 * 1024)
    throw new Error("Reply output exceeds 128 KiB.");
  // Any earlier fence (a diff, an example) is not the bundle — try every
  // fenced block, then the raw text, accepting the first whose requestId
  // matches this request.
  const candidates = [
    ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]),
    text,
  ];
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      "requestId" in value &&
      value.requestId === request.id &&
      "replies" in value &&
      Array.isArray(value.replies) &&
      value.replies.length &&
      value.replies.length <= 200
    )
      return validateReplies(value.replies, request);
  }
  throw new Error("This output does not match the reviewed reply request.");
}
function validateReplies(replies: unknown[], request: ReplyRequest): Reply[] {
  const seen = new Set<string>();
  return replies.map((reply: unknown) => {
    if (
      !reply ||
      typeof reply !== "object" ||
      !("threadId" in reply) ||
      typeof reply.threadId !== "string" ||
      !request.threadIds.includes(reply.threadId) ||
      seen.has(reply.threadId) ||
      !("body" in reply) ||
      typeof reply.body !== "string" ||
      !reply.body.trim() ||
      reply.body.length > 32_768
    )
      throw new Error(
        "Reply contains an unknown or duplicate thread, or an invalid body.",
      );
    seen.add(reply.threadId);
    return { threadId: reply.threadId, body: reply.body.trim() };
  });
}
