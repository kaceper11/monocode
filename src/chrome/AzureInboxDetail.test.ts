// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {AzureInboxDetail} from "./AzureInboxDetail";
import {loadAzurePrAssociation} from "../lib/azureRepos";
import type {InboxItem} from "../lib/githubTasks";
import {applyInboxFilters,DEFAULT_INBOX_FILTERS} from "../lib/inboxFilters";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("./AzurePrReview",()=>({AzurePrReview:()=>createElement("div",null,"Native PR review")}));
vi.mock("./AzureCiReview",()=>({AzureCiReview:()=>createElement("div",null,"Native CI review")}));
vi.mock("./CwdPicker",()=>({CwdPicker:()=>null}));
const item:InboxItem={provider:"azure",kind:"pr",number:7,title:"Review transport",url:"https://dev.azure.com/team/project/_git/repo/pullrequest/7",state:"open",draft:false,repo:"repo",projectPath:"",projectName:"Project",site:"https://dev.azure.com/team",account:"account",updatedAt:"2026-09-11T10:00:00Z",labels:[],assignees:[],delivery:{kind:"pr",project:"project",repository:"repo",branch:"refs/heads/feature",commit:"head",author:"Ada",accountId:"account"}};
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const rows=new Map<string,string>();vi.stubGlobal("localStorage",{getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>rows.set(key,value)});vi.mocked(invoke).mockReset().mockImplementation(async(cmd,args)=>{
 if(cmd==="azure_status")return {connected:true,site:item.site,accountId:"account",account:"Ada"};
 if(cmd==="azure_ci_context")return {cwd:"/repo",branch:"main",commit:"head",remotes:[]};
 if(cmd==="azure_pr_list")return {target:(args as {target:unknown}).target,projectName:"Project",repositoryName:"repo",items:[]};
 if(cmd==="azure_pr_read" && (args as {section:string}).section==="threads") return {items:[{id:1,status:"active",comments:[{id:2,content:"Fix retry",author:{displayName:"Sam"}},{id:3,content:"   "}]}],nextSkip:null,revision:"head:base"};
 if(cmd==="azure_pr_read" && (args as {section:string}).section==="workitems") return {items:[{id:"42"}],nextSkip:null,revision:"head:base"};
 if(cmd==="azure_pr_read")return {pr:{pullRequestId:7,title:item.title,description:"First paragraph.\n\n[Documentation](https://example.com/docs)",status:"active",sourceRefName:"refs/heads/feature",targetRefName:"refs/heads/main",reviewers:[]},revision:"head:base"};
 if(cmd==="azure_pr_thread_comment"||cmd==="azure_pr_submit_review"||cmd==="azure_pr_thread_status")return {revision:"head:base"};
 throw new Error(`Unexpected ${cmd}`);
});});
afterEach(()=>vi.unstubAllGlobals());
it("opens the exact Azure PR through the existing review and links it to Changes",async()=>{
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
 await act(async()=>root.render(createElement(AzureInboxDetail,{item,cwd:"/repo",projects:[]})));
 expect(host.textContent).toContain("Review transport");
 const button=[...host.querySelectorAll("button")].find(b=>b.textContent==="Review PR")!;
 await act(async()=>{button.click();button.click();});
 expect(host.textContent).toContain("Native PR review");
 expect(loadAzurePrAssociation("/repo","main")?.target.number).toBe(7);
 expect(vi.mocked(invoke).mock.calls.filter(([cmd])=>cmd==="azure_pr_list")).toHaveLength(1);
 expect(vi.mocked(invoke).mock.calls.some(([cmd])=>cmd==="azure_item_content")).toBe(false);
 }finally{await act(async()=>root.unmount());host.remove();}
});
it("blocks another Azure account before binding a checkout",async()=>{
 vi.mocked(invoke).mockResolvedValue({connected:true,site:item.site,accountId:"other"});
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
 await act(async()=>root.render(createElement(AzureInboxDetail,{item,cwd:"/repo",projects:[]})));
 await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="Review PR")!.click());
 expect(host.textContent).toContain("Azure account changed");
 expect(loadAzurePrAssociation("/repo","main")).toBeNull();
 }finally{await act(async()=>root.unmount());host.remove();}
});
it("filters Azure issues, PRs and CI independently",()=>{
 const ci={...item,kind:"ci" as const,state:"failed",url:item.url+"ci"};
 const board={...item,kind:"azure" as const,state:"Active",stateType:"InProgress",delivery:undefined,url:item.url+"board"};
 expect(applyInboxFilters([item,ci,board],{...DEFAULT_INBOX_FILTERS,hiddenKinds:["azure","pr"]},"",Date.now(),"azure")).toEqual([ci]);
});

it("asks through selected-context preparation without dispatching or loading Boards",async()=>{
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 const discuss=vi.fn();
 try{
 await act(async()=>root.render(createElement(AzureInboxDetail,{item,cwd:"/repo",projects:[],onDiscuss:discuss})));
 await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="Ask agent")!.click());
 expect(document.body.textContent).toContain("Ask about this PR");
 expect(document.body.textContent).toMatch(/Comments\s*1/);
 await act(async()=>[...document.querySelectorAll("button")].find(b=>b.textContent==="Open discussion")!.click());
 expect(discuss).toHaveBeenCalledTimes(1);
 expect(discuss.mock.calls[0][0].kind).toBe("pr");
 expect(discuss.mock.calls[0][0].prompt).toContain("Review transport");
 expect(discuss.mock.calls[0][0].contextPreview.description).toContain("First paragraph.\n\n[Documentation](https://example.com/docs)");
 expect(discuss.mock.calls[0][0].contextPreview.description).toContain("Revision: head:base");
 expect(discuss.mock.calls[0][0].prompt).not.toContain("Fix retry");
 expect(vi.mocked(invoke).mock.calls.some(([cmd])=>cmd==="azure_item_content")).toBe(false);
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("pins a CI Inbox run by ID and opens only that pipeline",async()=>{
 const target={site:item.site!,accountId:"account",project:"project",definition:3,repositoryId:"repo",repositoryType:"GitHub",repositoryUrl:"https://github.com/team/repo"};
 const ci:InboxItem={...item,kind:"ci",number:99,state:"failed",delivery:{...item.delivery!,kind:"ci",definition:3,repositoryType:"GitHub"}};
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(cmd,args)=>{
  if(cmd==="azure_ci_context")return {cwd:"/repo",branch:"main",commit:"head",remotes:[{name:"origin",url:target.repositoryUrl}]};
  if(cmd==="azure_ci_lookup") {
   const input=(args as {input:{runId?:number}}).input;
   return {target,definitionName:"Tests",projectName:"Project",checkedAt:1,items:input.runId===99 ? [{id:99,number:"99",status:"completed",result:"failed",branch:"refs/heads/feature",commit:"old",revision:"revision",match:"other-branch"}] : [],continuation:null};
  }
  return original(cmd,args);
 });
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(AzureInboxDetail,{item:ci,cwd:"/repo",projects:[]})));
  await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="Review CI")!.click());
  expect(host.textContent).toContain("Native CI review");
  expect(invoke).toHaveBeenCalledWith("azure_ci_lookup",expect.objectContaining({input:expect.objectContaining({runId:99})}));
  const {loadCiSources}=await import("../lib/azurePipelines");
  expect(loadCiSources("/repo","main")[0].last?.run.id).toBe(99);
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("shows Summary and Code tabs with the PR description, threads and linked stories",async()=>{
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
 await act(async()=>root.render(createElement(AzureInboxDetail,{item,cwd:"/repo",projects:[]})));
 const tabs=[...host.querySelectorAll("[role=tab]")].map(t=>t.textContent);
 expect(tabs).toEqual(["Summary","Code"]);
 expect(host.textContent).toContain("First paragraph.");
 expect(host.textContent).toContain("Fix retry");
 expect(host.textContent).toContain("#42");
 expect(host.querySelector("button[role=tab][aria-selected=true]")?.textContent).toBe("Summary");
 // The code tab verifies the checkout and embeds the review, same as GitHub.
 await act(async()=>[...host.querySelectorAll("[role=tab]")].find(t=>t.textContent==="Code")!.click());
 expect(host.textContent).toContain("Native PR review");
 expect(host.textContent).not.toContain("Opening review does not change its files.");
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("replies to a PR thread and posts a summary comment pinned to the revision",async()=>{
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
 await act(async()=>root.render(createElement(AzureInboxDetail,{item,cwd:"/repo",projects:[]})));
 const reply=[...host.querySelectorAll("button")].find(b=>b.textContent==="Reply")!;
 await act(async()=>reply.click());
 const area=host.querySelector("textarea")!;
 await act(async()=>{const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;setter.call(area,"on it");area.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(vi.mocked(invoke).mock.calls.some(([cmd,args])=>cmd==="azure_pr_thread_comment"&&(args as {threadId:number}).threadId===1&&(args as {expectedRevision:string}).expectedRevision==="head:base"&&(args as {body:string}).body==="on it")).toBe(true);
 await act(async()=>{const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;setter.call(host.querySelector("textarea")!,"looks good");host.querySelector("textarea")!.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(vi.mocked(invoke).mock.calls.some(([cmd,args])=>cmd==="azure_pr_submit_review"&&(args as {event:string}).event==="comment"&&(args as {expectedRevision:string}).expectedRevision==="head:base"&&(args as {body:string}).body==="looks good")).toBe(true);
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("offers a Watch action bound to the verified checkout",async()=>{
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 const seen:{source?:{kind?:string;target?:unknown;cwd?:string;branch?:string}}[]=[];
 const onSheet=(event:Event)=>seen.push((event as CustomEvent).detail);
 window.addEventListener("monocode:open-watch-sheet",onSheet);
 try{
 await act(async()=>root.render(createElement(AzureInboxDetail,{item,cwd:"/repo",projects:[]})));
 expect([...host.querySelectorAll("button")].some(b=>b.textContent?.includes("Watch"))).toBe(false);
 await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="Review PR")!.click());
 const watch=[...host.querySelectorAll("button")].find(b=>b.textContent?.includes("Watch"))!;
 await act(async()=>watch.click());
 expect(seen).toHaveLength(1);
 expect(seen[0].source?.kind).toBe("azure-pr");
 expect(seen[0].source?.cwd).toBe("/repo");
 expect(seen[0].source?.branch).toBe("main");
 expect((seen[0].source?.target as {number:number}).number).toBe(7);
 }finally{window.removeEventListener("monocode:open-watch-sheet",onSheet);await act(async()=>root.unmount());host.remove();}
});

it("renders the shared tasks section when my work joins the item",async()=>{
 const myWork={hasWork:true,tasks:[],sessions:[{sessionId:"s1",title:"Fix transport retry",harness:"claude" as const,cwd:"/repo",state:"idle" as const}],prs:[],ci:[],attention:[]};
 const opened:string[]=[];
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
 await act(async()=>root.render(createElement(AzureInboxDetail,{item,cwd:"/repo",projects:[],myWork,onOpenSession:(id:string)=>{opened.push(id);}})));
 expect(host.textContent).toContain("Fix transport retry");
 await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent?.includes("Fix transport retry"))!.click());
 expect(opened).toEqual(["s1"]);
 }finally{await act(async()=>root.unmount());host.remove();}
});
