import {
  addSessionWorkItems,
  removeSessionWorkItem,
  linkedWorkItemFromInboxItem,
} from "../lib/sessionWorkItem";
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxDetail, InboxView } from "./InboxView";
import { saveAzurePrAssociation } from "../lib/azureRepos";
import { clearInboxCache, listInboxItems } from "../lib/githubTasks";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock("../lib/agentContext", async (original) => ({
  ...(await original<typeof import("../lib/agentContext")>()),
  requestAgentContext: vi.fn(),
}));
vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("p", null, text),
}));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));
it("keeps distinct Azure PR and CI rows when Boards access fails", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "azure_status")
      return {
        connected: true,
        site: "https://dev.azure.com/team",
        project: "Product",
        accountId: "ada",
      };
    if (cmd.endsWith("_status")) return { connected: false };
    if (cmd === "azure_list_items") throw new Error("Boards denied");
    if (cmd === "azure_delivery_inbox")
      return {
        errors: [],
        items: ["pr", "ci"].map((kind) => ({
          kind,
          number: 7,
          title: kind,
          url: `https://dev.azure.com/team/Product/${kind}/7`,
          updatedAt: "2026-09-11",
          delivery: {
            kind,
            accountId: "ada",
            project: "Product",
            repository: "repo",
          },
        })),
      };
    return [];
  });
  clearInboxCache();
  const result = await listInboxItems(
    [],
    { state: "open", search: "", assignedToMe: true },
    { force: true },
  );
  expect(result.items.map((item) => item.kind).sort()).toEqual(["ci", "pr"]);
  expect(
    result.items.every(
      (item) => item.account === "ada" && item.provider === "azure",
    ),
  ).toBe(true);
  expect(result.errors.azure).toContain("Boards denied");
  clearInboxCache();
});
it("keeps Azure identity and selected context through Ask, Send and retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>([["monocode.inboxSource", "azure"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  let fail = false;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === "azure_status")
      return {
        connected: true,
        site: "https://dev.azure.com/team",
        project: "Product",
        account: "Ada",
        accountId: "ada",
      };
    if (cmd === "git_github_status")
      return { installed: true, connected: true };
    if (cmd.endsWith("_status")) return { connected: false };
    if (cmd === "azure_delivery_inbox") return { items: [], errors: [] };
    if (cmd === "azure_list_items") {
      if (fail) throw new Error("Azure denied access");
      return {
        site: "https://dev.azure.com/team",
        items: [142, 141].map((id) => ({
          id,
          stateCategory: "InProgress",
          fields: {
            "System.Title": `Ticket ${id}`,
            "System.State": "Custom review",
            "System.TeamProject": "Product",
            "System.WorkItemType": "Bug",
            "System.ChangedDate": "2026-09-10T10:00:00Z",
          },
        })),
      };
    }
    if (cmd === "azure_item_content")
      return {
        fields: { "System.Description": "<p>Loaded description</p>" },
        comments: [],
        attachments: (args as { discussion?: boolean })?.discussion
          ? [
              {
                id: "comment-image",
                name: "comment-only.png",
                mimeType: "image/png",
              },
            ]
          : [],
        more: false,
      };
    if (cmd === "inbox_context_document")
      return {
        owner: "azure:team:ada",
        description: "Loaded description",
        comments: [],
        files: [],
        more: false,
      };
    if (cmd === "git_github_repo") return "";
    return [];
  });
  clearInboxCache();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { requestAgentContext } = await import("../lib/agentContext");
  const onAsk = vi.fn().mockResolvedValue("ask-session");
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const click = async (el: HTMLElement) => {
    await act(async () => el.click());
  };
  try {
    await act(async () =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          conversationId: "existing",
        }),
      ),
    );
    expect(
      container.querySelector('[role="tab"][aria-label="Azure DevOps"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Azure DevOps images"]')
        ?.textContent,
    ).toContain("comment-only.png");
    expect(invoke).toHaveBeenCalledWith(
      "azure_image",
      expect.objectContaining({ attachmentId: "comment-image" }),
    );
    await click(
      container.querySelector(
        '[aria-label^="Custom review work item Bug 141: Ticket 141"]',
      )!,
    );
    expect(container.querySelector('[aria-label="Conversation"]')).toBeNull();
    expect(button("Back to conversation")).toBeTruthy();
    await click(button("Back to conversation"));
    expect(
      container.querySelectorAll('[aria-label="Conversation"]'),
    ).toHaveLength(1);
    await click(
      container.querySelector(
        '[aria-label^="Custom review work item Bug 141: Ticket 141"]',
      )!,
    );
    expect(container.querySelector('[aria-label="Conversation"]')).toBeNull();
    await click(button("Send to agent"));
    // The item hands off to the unified send flow — the picker owns context
    // selection and the task-first destination choice.
    expect(requestAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxItems: [
          expect.objectContaining({
            provider: "azure",
            identifier: "Bug 141",
            projectPath: "",
            repo: "",
            site: "https://dev.azure.com/team",
          }),
        ],
      }),
    );
    await click(button("GitHub"));
    await click(button("Azure"));
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 141");
    await click(container.querySelector('[aria-label="Select tickets"]')!);
    await click(
      container.querySelector(
        'input[aria-label="Select azure Bug 141 Ticket 141"]',
      )!,
    );
    await click(button("GitHub"));
    expect(container.textContent).toContain("1 selected");
    await click(button("Azure"));
    expect(
      (
        container.querySelector(
          'input[aria-label="Select azure Bug 141 Ticket 141"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await click(
      container.querySelector<HTMLElement>(
        'button[aria-label="Send selected tickets to an agent"]',
      )!,
    );
    expect(requestAgentContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inboxItems: [
          expect.objectContaining({
            provider: "azure",
            account: "ada",
            id: "141",
          }),
        ],
      }),
    );
    // The selection survives until the route accepts — a cancelled picker
    // keeps it for retry, and onPrepared ends select mode.
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    const sentRequest = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
    await act(async () => sentRequest?.onPrepared?.());
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    fail = true;
    await click(container.querySelector('[aria-label="Refresh"]')!);
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 141");
    expect(container.textContent).toContain("Azure denied access");
    expect(container.querySelector("textarea")).toBeNull();
    await click(button("Ask agent"));
    await click(button("Open discussion"));
    expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "azure", id: "141" }),
      expect.objectContaining({ contextSummary: expect.any(String) }),
    );
    let linked = {
      id: "existing",
      cwd: "/local/project",
      title: "Existing",
      linkedWorkItem: linkedWorkItemFromInboxItem(
        vi.mocked(requestAgentContext).mock.calls.at(-1)![0].inboxItems![0],
      )!,
    };
    let finishToggle: (() => void) | undefined;
    let holdToggle = false;
    const onToggle = vi.fn(async (_id, item, selected) => {
      if (holdToggle)
        await new Promise<void>((resolve) => {
          finishToggle = resolve;
        });
      const link = linkedWorkItemFromInboxItem(item)!;
      linked = selected
        ? addSessionWorkItems(linked, [link])
        : removeSessionWorkItem(linked, link);
      renderLinked();
    });
    const onCloseConversation = vi.fn();
    const onOpenDelivery = vi.fn().mockResolvedValue(undefined);
    const renderLinked = () =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          onOpenDelivery,
          conversationId: "existing",
          sessions: [linked as import("../lib/sessionStore").SessionSummary],
          onToggleConversationTicket: onToggle,
          onCloseConversation,
        }),
      );
    await act(async () => renderLinked());
    // Delivery actions live once per working copy — a branch chip after the
    // thread's chips, labeled by the copy's name when no branch is cached.
    const deliveryMenu = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (el) => el.textContent?.trim() === label,
      )!;
    const openDeliveryMenu = () =>
      click(
        container.querySelector(
          'button[aria-label="Delivery actions for project in project"]',
        )!,
      );
    await openDeliveryMenu();
    await click(deliveryMenu("Azure PRs"));
    expect(onOpenDelivery).toHaveBeenLastCalledWith(
      "existing",
      "pr",
      expect.any(Function),
      "azure",
      undefined,
      undefined,
    );
    await openDeliveryMenu();
    await click(deliveryMenu("Azure CI"));
    expect(onOpenDelivery).toHaveBeenLastCalledWith(
      "existing",
      "ci",
      expect.any(Function),
      "azure",
      undefined,
      undefined,
    );
    await openDeliveryMenu();
    await click(deliveryMenu("Providers…"));
    await click(
      container.querySelector(
        'button[aria-label^="PR provider for project:"]',
      )!,
    );
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (el) => el.textContent?.trim() === "GitHub",
      )!,
    );
    await openDeliveryMenu();
    await click(deliveryMenu("GitHub PRs"));
    expect(onOpenDelivery).toHaveBeenLastCalledWith(
      "existing",
      "pr",
      expect.any(Function),
      "github",
      undefined,
      undefined,
    );
    await openDeliveryMenu();
    await click(deliveryMenu("Azure CI"));
    expect(onOpenDelivery).toHaveBeenLastCalledWith(
      "existing",
      "ci",
      expect.any(Function),
      "azure",
      undefined,
      undefined,
    );
    expect(
      localStorage.getItem("monocode.inboxDeliveryProviders.v2"),
    ).toContain("github");
    await openDeliveryMenu();
    await click(deliveryMenu("Providers…"));
    await click(
      container.querySelector(
        'button[aria-label^="PR provider for project:"]',
      )!,
    );
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (el) => el.textContent?.trim() === "Use ticket provider",
      )!,
    );
    await openDeliveryMenu();
    await click(deliveryMenu("Azure PRs"));
    expect(onOpenDelivery).toHaveBeenLastCalledWith(
      "existing",
      "pr",
      expect.any(Function),
      "azure",
      undefined,
      undefined,
    );
    // Two threads on one working copy share a single delivery chip — the
    // PR/CI belong to the branch, not the conversation. A thread on another
    // copy gets its own.
    await act(async () =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          onOpenDelivery,
          conversationId: "existing",
          sessions: [
            linked,
            {
              id: "s2",
              cwd: "/local/project",
              title: "Second",
              linkedWorkItem: linked.linkedWorkItem,
            },
            {
              id: "s3",
              cwd: "/local/other",
              title: "Other",
              linkedWorkItem: linked.linkedWorkItem,
            },
          ] as import("../lib/sessionStore").SessionSummary[],
          onToggleConversationTicket: onToggle,
          onCloseConversation,
        }),
      ),
    );
    expect(
      container.querySelectorAll('button[aria-label^="Delivery actions for"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector(
        'button[aria-label="Delivery actions for other in other"]',
      ),
    ).not.toBeNull();
    let finishReview: (() => void) | undefined;
    let isCurrent: (() => boolean) | undefined;
    onOpenDelivery.mockImplementationOnce((_id, _kind, current) => {
      isCurrent = current;
      return new Promise<void>((resolve) => {
        finishReview = resolve;
      });
    });
    await openDeliveryMenu();
    await click(deliveryMenu("Azure PRs"));
    expect(isCurrent?.()).toBe(true);
    await click(
      container.querySelector(
        '[aria-label="Custom review work item Bug 142: Ticket 142"]',
      )!,
    );
    expect(isCurrent?.()).toBe(false);
    await act(async () => finishReview?.());
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 142");
    await click(
      container.querySelector(
        '[aria-label^="Custom review work item Bug 141: Ticket 141"]',
      )!,
    );

    await click(container.querySelector('[aria-label="Select tickets"]')!);
    expect(
      container.querySelector('input[aria-label="Filter inbox"]'),
    ).toBeNull();
    const selection = () =>
      container.querySelector(
        'input[aria-label="Select azure Bug 141 Ticket 141"]',
      ) as HTMLInputElement;
    expect(selection().checked).toBe(true);
    holdToggle = true;
    await click(selection());
    expect(selection().checked).toBe(false);
    expect(selection().disabled).toBe(true);
    await act(async () => finishToggle?.());
    holdToggle = false;
    expect(selection().disabled).toBe(false);
    expect(onToggle).toHaveBeenLastCalledWith(
      "existing",
      expect.objectContaining({ id: "141" }),
      false,
    );
    expect(selection().checked).toBe(false);
    expect(container.textContent).toContain("0 linked");
    await click(selection());
    expect(selection().checked).toBe(true);
    expect(container.textContent).toContain("1 linked");
    await click(button("Done"));
    expect(onCloseConversation).not.toHaveBeenCalled();
    expect(
      container.querySelector('input[aria-label="Filter inbox"]'),
    ).not.toBeNull();
    await click(button("Back to conversation"));
    expect(
      container.querySelector('[aria-label="Conversation"]'),
    ).not.toBeNull();
    const conversationPanel = container.querySelector(
      '[aria-label="Conversation"]',
    );
    await click(container.querySelector('[aria-label="Select tickets"]')!);
    await click(button("Done"));
    expect(onCloseConversation).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Conversation"]')).toBe(
      conversationPanel,
    );
    await click(button("Hide issues"));
    expect(
      (container.querySelector("#inbox-ticket-list") as HTMLElement).hidden,
    ).toBe(true);
    expect(container.querySelector('[aria-label="Conversation"]')).toBe(
      conversationPanel,
    );
    await click(button("Show issues"));
    expect(
      (container.querySelector("#inbox-ticket-list") as HTMLElement).hidden,
    ).toBe(false);
    await click(container.querySelector('[aria-label="Select tickets"]')!);
    expect(
      container.querySelector(
        'button[aria-label="Send selected tickets to an agent"]',
      ),
    ).toBeNull();
    await click(button("Done"));

    await act(async () =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          conversationId: "existing",
          target: { ...linked.linkedWorkItem },
        }),
      ),
    );
    expect(container.querySelector('[aria-label="Conversation"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 141");
    const renderVisible = (visible: boolean) =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          visible,
        }),
      );
    await act(async () => renderVisible(true));
    await click(container.querySelector('[aria-label="Select tickets"]')!);
    await click(
      container.querySelector(
        'input[aria-label="Select azure Bug 141 Ticket 141"]',
      )!,
    );
    expect(container.textContent).toContain("1 selected");
    await act(async () => renderVisible(false));
    await act(async () => renderVisible(true));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await click(container.querySelector('[aria-label="Select tickets"]')!);
    expect(container.textContent).toContain("0 selected");
    expect(container.querySelector('[aria-label="Conversation"]')).toBeNull();
    await click(button("Done"));
    await act(async () =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          conversationId: "existing",
          selectionRevision: 1,
        }),
      ),
    );
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Conversation"]'),
    ).not.toBeNull();

    await click(button("GitHub"));
    const target = {
      ...linked.linkedWorkItem,
      number: 142,
      identifier: "Bug 142",
      url: linked.linkedWorkItem.url.replace("141", "142"),
    };
    const renderTarget = (visible: boolean) =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          visible,
          target,
        }),
      );
    await act(async () => renderTarget(false));
    await act(async () => renderTarget(true));
    expect(
      container
        .querySelector('[aria-label="Azure DevOps"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 142");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("hosts a delivery tab on the conversation being viewed, not the first related thread", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.mocked(invoke).mockImplementation(async () => null);
  // An unassigned PR link on the shared checkout counts for either host.
  saveAzurePrAssociation(
    {
      target: {
        site: "https://dev.azure.com/team",
        accountId: "ada",
        project: "Product",
        repository: "repo",
        number: 7,
      },
      account: "Ada",
      cwd: "/work/repo",
      branch: "feature",
      revision: "a:b",
      projectName: "Product",
      repositoryName: "repo",
      pr: {
        pullRequestId: 7,
        title: "PR 7",
        status: "active",
        sourceRefName: "refs/heads/feature",
        targetRefName: "refs/heads/main",
        reviewers: [],
      },
    },
    "/work/repo",
    "feature",
  );
  const onOpenDelivery = vi.fn().mockResolvedValue(undefined);
  const session = (id: string) =>
    ({
      id,
      cwd: "/work/repo",
      harness: "devin",
      model: "",
      runtimeMode: "local",
      title: id,
      branch: "feature",
      createdAt: 1,
      updatedAt: 1,
    }) as never;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(InboxDetail, {
          item: {
            kind: "issue",
            title: "Ticket 142",
            url: "https://dev.azure.com/team/Product/_workitems/edit/142",
            state: "open",
            updatedAt: "2026-09-11",
            labels: [],
            assignees: [],
            draft: false,
            repo: "",
            number: 142,
            projectPath: "/work/repo",
            provider: "azure",
          },
          cwd: "/work/repo",
          revision: 0,
          viewingSessionId: "session-b",
          myWork: {
            tasks: [],
            sessions: [session("session-a"), session("session-b")].map(
              (row) => ({
                sessionId: row.id,
                title: row.title,
                harness: row.harness,
                cwd: row.cwd,
                branch: row.branch,
                state: "idle" as const,
              }),
            ),
            prs: [],
            ci: [],
            attention: [],
            hasWork: true,
          },
          onOpenDelivery,
        }),
      ),
    );
    const hostRow = [
      ...container.querySelectorAll("button"),
    ].find((el) => el.title === "Open conversation: session-b")
      ?.parentElement;
    const badge = hostRow?.querySelector(
      '[aria-label^="1 pull request on"]',
    ) as HTMLElement | null;
    expect(badge).not.toBeNull();
    await act(async () => badge!.click());
    expect(onOpenDelivery).toHaveBeenCalledWith(
      "session-b",
      "pr",
      expect.any(Function),
      "azure",
      undefined,
      undefined,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
