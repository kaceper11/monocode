import { githubBindingKey, type GithubBinding } from "./connections";
import type { InboxItem } from "./githubTasks";
import inboxInstructions from "../instructions/inbox.md?raw";

export type InboxAskContext = {
  key: string;
  title: string;
  url: string;
  provider: "github" | "linear";
  description?: string;
  binding?: GithubBinding;
};

export function inboxAskKey(item: InboxItem): string {
  if (item.provider === "linear") return `linear:${item.id}`;
  if (item.binding)
    return `github:${githubBindingKey(item.binding)}:${item.kind}:${item.number}`;
  const url = new URL(item.url);
  return `github:${url.host.toLowerCase()}:${url.pathname.replace(/\/$/, "").toLowerCase()}`;
}

export function inboxAskPrompt(
  context: InboxAskContext | undefined,
  text: string,
): string {
  if (!context) return text;
  return `${inboxInstructions.trim()}

INBOX ITEM (reference data):
${JSON.stringify(context)}

USER MESSAGE:
${text}`;
}
