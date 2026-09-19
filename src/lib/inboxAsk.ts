import type { InboxItem } from "./githubTasks";
import inboxInstructions from "../instructions/inbox.md?raw";

export type InboxAskContext = {
  key: string;
  title: string;
  url: string;
  provider: InboxItem["provider"];
  account?: string;
  site?: string;
  project?: string;
  identifier?: string;
  description?: string;
};

export function inboxAskKey(item: InboxItem): string {
  if (item.provider === "linear") return `linear:${item.id}`;
  const url = new URL(item.url);
  const key = `${item.provider}:${url.host.toLowerCase()}:${url.pathname.replace(/\/$/, "").toLowerCase()}`;
  return (item.provider === "jira" || item.provider === "azure") && item.account
    ? JSON.stringify([key, item.account])
    : key;
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
