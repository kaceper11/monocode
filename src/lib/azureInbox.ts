import { invoke } from "@tauri-apps/api/core";
import { loadAzureFilter, type AzureStatus } from "./azure";
import type { InboxItem } from "./githubTasks";

export type AzureInboxDelivery = {
  kind: "pr" | "ci";
  project: string;
  repository: string;
  repositoryType?: string;
  definition?: number;
  branch: string;
  commit: string;
  targetBranch?: string;
  author: string;
  accountId: string;
};
export async function listAzureDelivery(status: AzureStatus, state: "open" | "all") {
  const filter = loadAzureFilter(status.site, status.project);
  const result = await invoke<{items: (Omit<InboxItem,"provider"|"projectPath"|"labels"|"assignees"> & {delivery:AzureInboxDelivery})[]; errors:string[]}>("azure_delivery_inbox", {
    site:status.site,accountId:status.accountId,project:filter.project,assigned:filter.assigned,state,
  });
  return {
    items: result.items.map(item => ({...item,provider:"azure" as const,site:status.site,account:status.accountId,projectPath:"",id:String(item.number),identifier:`${item.kind === "ci" ? "Run" : "PR"} #${item.number}`,labels:[],assignees:[]})),
    errors:result.errors,
  };
}
