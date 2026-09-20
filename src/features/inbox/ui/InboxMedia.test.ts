// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxMedia, TicketImages } from "./InboxMedia";
import type { InboxItem } from "../model/githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
it("loads authenticated jira images separately from agent context and retries failures", async () => {
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private-jira-image");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII="), c => c.charCodeAt(0));
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValue(bytes.buffer);
  const site = "https://team.atlassian.net";
  const item = { provider: "jira", site, account: "account-a", id: "42", url: `${site}/browse/ENG-42` } as InboxItem;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TicketImages, { item, attachments: [{ id: "12", name: "checkout.png", mimeType: "image/png" }, { id: "13", name: "report.pdf", mimeType: "application/pdf" }] })));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("jira_image", { site: item.site, accountId: "account-a", id: "42", attachmentId: "12" });
    expect(container.textContent).toContain("Retry image");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:private-jira-image");
    expect(container.querySelector("img")?.alt).toBe("checkout.png");
    expect(container.textContent).not.toContain("report.pdf");
    expect(vi.mocked(invoke).mock.calls.every(([cmd]) => cmd === "jira_image")).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
  expect(revoke).toHaveBeenCalledWith("blob:private-jira-image");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});


it("keeps the upstream fallback for ordinary Inbox media", async () => {
  vi.mocked(invoke).mockReset().mockRejectedValue(new Error("Unavailable"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(InboxMedia, { src: "https://github.com/user-attachments/assets/example.png", alt: "Original image" })));
    expect(container.textContent).toBe("Original image");
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
