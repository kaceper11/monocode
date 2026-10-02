// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SavedProjectDialog } from "./SavedProjectDialog";
import { readSavedProjects } from "../model/savedProjects";
import { pickFolder } from "../../../platform/tauri/fs";
import {
  connectWslProject,
  wslDistributions,
  wslDistributionsPeek,
} from "../../sessions/model/wsl";
vi.mock("../../../platform/tauri/platform", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/platform")>()),
  IS_WIN: true,
}));
vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  pickFolder: vi.fn(),
}));
vi.mock("../../sessions/model/wsl", async (original) => ({
  ...(await original<typeof import("../../sessions/model/wsl")>()),
  wslDistributions: vi.fn(),
  wslDistributionsPeek: vi.fn(),
  connectWslProject: vi.fn(),
  wslHome: vi.fn(async () => "/home/me"),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (value: string) => value,
}));
it("creates a repository preset from staged membership and saves it with the project", async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === text,
    )!;
  try {
    await act(async () =>
      root.render(
        createElement(SavedProjectDialog, {
          project: {
            id: "services",
            name: "Services",
            members: ["/api", "/web"],
            presets: [],
          },
          recents: [],
          onClose: close,
        }),
      ),
    );
    await act(async () => button("New preset").click());
    const name = document.querySelector<HTMLInputElement>(
      'input[aria-label="Preset name"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(name, "Backend");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[aria-label="web"]')!
        .click(),
    );
    expect(readSavedProjects()).toEqual([]);
    await act(async () => button("Save changes").click());
    expect(readSavedProjects()[0]).toMatchObject({
      members: ["/api", "/web"],
      presets: [{ name: "Backend", members: ["/api"] }],
    });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("drops removed repositories from staged presets immediately", async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(SavedProjectDialog, {
          project: {
            id: "services",
            name: "Services",
            members: ["/api", "/web"],
            presets: [
              { id: "backend", name: "Backend", members: ["/api", "/web"] },
            ],
          },
          recents: [],
          onClose: vi.fn(),
        }),
      ),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Remove web"]')!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent?.trim() === "Save changes")!
        .click(),
    );
    expect(readSavedProjects()[0]).toMatchObject({
      members: ["/api"],
      presets: [{ name: "Backend", members: ["/api"] }],
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["absent", "discovery failed"])(
  "adds native Windows folders when WSL is %s",
  async (state) => {
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(wslDistributions).mockReset();
    if (state === "absent") vi.mocked(wslDistributions).mockResolvedValue([]);
    else
      vi.mocked(wslDistributions).mockRejectedValue(
        new Error("WSL unavailable"),
      );
    vi.mocked(wslDistributionsPeek).mockReturnValue([]);
    vi.mocked(pickFolder)
      .mockReset()
      .mockResolvedValue(["C:/work/api", "D:/work/web"]);
    vi.mocked(connectWslProject).mockClear();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host),
      close = vi.fn();
    const click = async (text: string) =>
      act(async () =>
        [...document.querySelectorAll("button")]
          .find((node) => node.textContent?.trim() === text)!
          .click(),
      );
    try {
      await act(async () =>
        root.render(
          createElement(SavedProjectDialog, {
            project: {
              id: "windows",
              name: "Windows",
              members: ["C:/existing"],
              presets: [],
            },
            recents: [],
            onClose: close,
          }),
        ),
      );
      await click("Browse…");
      expect(pickFolder).toHaveBeenCalledOnce();
      expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
      await click("Save changes");
      expect(readSavedProjects()[0].members).toEqual([
        "C:/existing",
        "C:/work/api",
        "D:/work/web",
      ]);
      expect(connectWslProject).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);

it("adds canonical WSL folders through the existing themed host chooser", async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(wslDistributions).mockReset().mockResolvedValue(["Ubuntu"]);
  vi.mocked(wslDistributionsPeek).mockReturnValue(["Ubuntu"]);
  vi.mocked(connectWslProject)
    .mockReset()
    .mockImplementation(async (path) =>
      path.replace("/home/me/link", "/home/me/api"),
    );
  vi.mocked(pickFolder).mockClear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    close = vi.fn();
  const click = async (text: string) =>
    act(async () =>
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent?.trim() === text)!
        .click(),
    );
  try {
    await act(async () =>
      root.render(
        createElement(SavedProjectDialog, {
          project: {
            id: "wsl",
            name: "Linux",
            members: ["//wsl.localhost/Ubuntu/home/me/existing"],
            presets: [],
          },
          recents: [],
          onClose: close,
        }),
      ),
    );
    await click("Browse…");
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(2);
    expect(document.querySelector("select")).toBeNull();
    const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, "/home/me/link\n/home/me/web");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(connectWslProject).toHaveBeenCalledTimes(2);
    expect(pickFolder).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await click("Save changes");
    expect(readSavedProjects()[0].members).toEqual([
      "//wsl.localhost/Ubuntu/home/me/existing",
      "//wsl.localhost/Ubuntu/home/me/api",
      "//wsl.localhost/Ubuntu/home/me/web",
    ]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("creates a native Windows project even when WSL is installed", async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(wslDistributions).mockReset().mockResolvedValue(["Ubuntu"]);
  vi.mocked(wslDistributionsPeek).mockReturnValue(["Ubuntu"]);
  vi.mocked(pickFolder).mockReset().mockResolvedValue(["C:/work/api"]);
  vi.mocked(connectWslProject).mockClear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = async (text: string) =>
    act(async () =>
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent?.trim() === text)!
        .click(),
    );
  try {
    await act(async () =>
      root.render(
        createElement(SavedProjectDialog, { recents: [], onClose: vi.fn() }),
      ),
    );
    const name = document.querySelector<HTMLInputElement>(
      '[aria-label="Project name"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(name, "Windows");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Browse…");
    expect(document.body.textContent).toContain("This Windows PC");
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await click("Create project");
    expect(readSavedProjects()[0]).toMatchObject({
      name: "Windows",
      members: ["C:/work/api"],
    });
    expect(connectWslProject).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
