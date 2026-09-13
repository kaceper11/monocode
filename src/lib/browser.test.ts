// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserTabLabel,
  isLocalhostUrl,
  normalizeBrowserUrl,
  rememberedBrowserUrl,
  rememberBrowserUrl,
} from "./browser";
import {
  isBrowserTab,
  leaf,
  newBrowserTab,
  newTab,
  updateBrowserTab,
} from "./layout";
import { parseWorkspaceSnapshot } from "./workspaceSnapshot";

describe("normalizeBrowserUrl", () => {
  it("accepts http and https URLs unchanged", () => {
    expect(normalizeBrowserUrl("http://localhost:3000/app")).toBe(
      "http://localhost:3000/app",
    );
    expect(normalizeBrowserUrl("https://example.com/")).toBe(
      "https://example.com/",
    );
  });

  it("adds https to a bare host", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("https://localhost:5173/");
    expect(normalizeBrowserUrl("  example.com/path  ")).toBe(
      "https://example.com/path",
    );
  });

  it.each([
    "file:///etc/passwd",
    "file:///Users/me/secret.txt",
    "ftp://example.com/x",
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "tauri://localhost",
  ])("rejects a non-http(s) scheme: %s", (input) => {
    expect(() => normalizeBrowserUrl(input)).toThrow(/allowed/);
  });

  it("rejects empty and overlong input", () => {
    expect(() => normalizeBrowserUrl("   ")).toThrow();
    expect(() => normalizeBrowserUrl(`http://e.co/${"a".repeat(9000)}`)).toThrow(
      /too long/,
    );
  });
});

describe("isLocalhostUrl", () => {
  it.each([
    "http://localhost:3000",
    "https://app.localhost/",
    "http://127.0.0.1:8080/x",
    "http://[::1]:3000",
    "http://0.0.0.0:4000",
  ])("detects loopback: %s", (url) => {
    expect(isLocalhostUrl(url)).toBe(true);
  });

  it.each([
    "https://example.com",
    "http://localhost.evil.com",
    "https://127.0.0.1.evil.com",
    "not a url",
  ])("rejects non-loopback: %s", (url) => {
    expect(isLocalhostUrl(url)).toBe(false);
  });
});

describe("browserTabLabel", () => {
  it("uses host and port, never credentials", () => {
    expect(browserTabLabel("http://user:pass@localhost:3000/app?q=1")).toBe(
      "localhost:3000",
    );
  });

  it("prefers a trimmed page title", () => {
    expect(browserTabLabel("http://localhost:3000", "  My App  ")).toBe(
      "My App",
    );
    expect(browserTabLabel("http://localhost:3000", "   ")).toBe(
      "localhost:3000",
    );
  });
});

describe("remembered browser URL", () => {
  beforeEach(() => localStorage.clear());

  it("stores and restores per worktree", () => {
    rememberBrowserUrl("/repo/a", "http://localhost:3000/");
    rememberBrowserUrl("/repo/b", "http://localhost:4000/");
    expect(rememberedBrowserUrl("/repo/a")).toBe("http://localhost:3000/");
    expect(rememberedBrowserUrl("/repo/b")).toBe("http://localhost:4000/");
    expect(rememberedBrowserUrl("/repo/c")).toBeUndefined();
  });

  it("keeps host and WSL worktrees apart", () => {
    rememberBrowserUrl("//wsl.localhost/Ubuntu/home/x", "http://localhost:1/");
    expect(rememberedBrowserUrl("/home/x")).not.toBe("http://localhost:1/");
  });

  it("ignores non-http values", () => {
    rememberBrowserUrl("/repo/a", "file:///etc/passwd");
    expect(rememberedBrowserUrl("/repo/a")).toBeUndefined();
  });
});

describe("browser tabs in the layout", () => {
  it("newBrowserTab produces a browser-kind file tab", () => {
    const file = newBrowserTab("/repo", "http://localhost:3000/");
    expect(isBrowserTab(file)).toBe(true);
    expect(file.browser?.url).toBe("http://localhost:3000/");
    expect(file.cwd).toBe("/repo");
    expect(file.path).toBe("http://localhost:3000/");
  });

  it("updateBrowserTab applies url and title patches to the right file", () => {
    const browser = { ...newBrowserTab("/repo", "http://localhost:3000/"), id: "b1" };
    const other = { ...newBrowserTab("/repo", "http://localhost:9999/"), id: "b2" };
    const tab = {
      ...newTab("s1"),
      editorPanes: [
        {
          id: "p1",
          files: [browser, other],
          activeFileId: "b1",
        },
      ],
    };
    const next = updateBrowserTab(tab, "b1", {
      url: "http://localhost:3000/next",
      title: "Next",
    });
    const files = next.editorPanes[0].files;
    expect(files[0].browser?.url).toBe("http://localhost:3000/next");
    expect(files[0].browser?.title).toBe("Next");
    expect(files[0].path).toBe("http://localhost:3000/next");
    expect(files[1].browser?.url).toBe("http://localhost:9999/");
    expect(files[1].browser?.title).toBeUndefined();
  });

  it("updateBrowserTab leaves a title-only patch alone on url", () => {
    const browser = { ...newBrowserTab("/repo", "http://localhost:3000/"), id: "b1" };
    const tab = {
      ...newTab("s1"),
      editorPanes: [
        {
          id: "p1",
          files: [browser],
          activeFileId: "b1",
        },
      ],
    };
    const next = updateBrowserTab(tab, "b1", { title: "Loaded" });
    expect(next.editorPanes[0].files[0].browser?.url).toBe(
      "http://localhost:3000/",
    );
    expect(next.editorPanes[0].files[0].browser?.title).toBe("Loaded");
    expect(next.editorPanes[0].files[0].path).toBe("http://localhost:3000/");
  });
});

describe("browser tabs in the workspace snapshot", () => {
  const snapshotWith = (files: Record<string, unknown>[]) => ({
    tabs: [
      {
        kind: "session",
        id: "t1",
        layout: leaf("p1"),
        focusedId: "p1",
        editorPanes: [
          { id: "p1", activeFileId: "b1", files },
        ],
        terminalPanes: [],
      },
    ],
    sessions: [],
    activeTabId: "t1",
    projectCwd: "/repo",
  });

  it("round-trips a browser tab with url and title", () => {
    const parsed = parseWorkspaceSnapshot(
      snapshotWith([
        {
          id: "b1",
          path: "http://localhost:3000/",
          cwd: "/repo",
          browser: { url: "http://localhost:3000/", title: "App" },
        },
      ]),
    );
    const file = parsed?.tabs[0].editorPanes[0].files[0];
    expect(file?.browser?.url).toBe("http://localhost:3000/");
    expect(file?.browser?.title).toBe("App");
  });

  it.each([
    { browser: { url: "file:///etc/passwd" } },
    { browser: { url: "javascript:alert(1)" } },
    { browser: { url: "x".repeat(9000) } },
    { browser: "oops" },
    {
      browser: { url: "http://localhost:3000/" },
      terminal: true,
    },
    {
      browser: { url: "http://localhost:3000/" },
      review: true,
    },
  ])("drops a browser tab with invalid data: %j", (descriptor) => {
    const parsed = parseWorkspaceSnapshot(
      snapshotWith([
        {
          id: "b1",
          path: "http://localhost:3000/",
          cwd: "/repo",
          ...descriptor,
        },
      ]),
    );
    const file = parsed?.tabs[0].editorPanes[0].files[0];
    expect(file?.browser).toBeUndefined();
  });
});
