// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SavedProjectDialog } from "./SavedProjectDialog";
import { readSavedProjects } from "../model/savedProjects";
import { pickFolder } from "../../../platform/tauri/fs";
vi.mock("../../../platform/tauri/platform", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/platform")>()),
  IS_WIN: true,
}));
vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  pickFolder: vi.fn(),
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

it("adds picked folders to an existing project", async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(pickFolder)
    .mockReset()
    .mockResolvedValue(["C:/work/api", "D:/work/web"]);
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
    await click("Save changes");
    expect(readSavedProjects()[0].members).toEqual([
      "C:/existing",
      "C:/work/api",
      "D:/work/web",
    ]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("creates a project from picked folders", async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(pickFolder).mockReset().mockResolvedValue(["C:/work/api"]);
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
    await click("Create project");
    expect(readSavedProjects()[0]).toMatchObject({
      name: "Windows",
      members: ["C:/work/api"],
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
