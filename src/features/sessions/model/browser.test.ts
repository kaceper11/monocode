// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserAgentContext,
  browserClipboardUrl,
  browserFavorites,
  browserTabLabel,
  isBrowserCommandRequest,
  isBrowserFavorite,
  isLocalhostUrl,
  normalizeBrowserUrl,
  rememberedBrowserUrl,
  rememberBrowserUrl,
  removeBrowserFavorite,
  requestBrowserCommand,
  sanitizeCaptureUrl,
  subscribeBrowserFavorites,
  toggleBrowserFavorite,
  updateBrowserFavorite,
  type BrowserCapture,
} from "./browser";
import {
  isBrowserTab,
  isFilesystemTab,
  editorTabKey,
  leaf,
  newTab,
  newFileTab,
  openEditorTab,
  leafIds,
} from "../../workspace/model/layout.ts";
import { newBrowserTab, updateBrowserTab, restoreBrowserTab, openBrowserTab, closeBrowserTabs, browserDockBand } from "./browserWorkspace";
import { parseWorkspaceSnapshot } from "../../workspace/model/workspaceSnapshot.ts";

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

describe("browserClipboardUrl", () => {
  it("returns a bare http(s) URL", () => {
    expect(browserClipboardUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/",
    );
    expect(browserClipboardUrl("  https://example.com/app  ")).toBe(
      "https://example.com/app",
    );
  });

  it("extracts a URL from a dev-server output line", () => {
    expect(
      browserClipboardUrl("➜  Local:   http://localhost:5173/app"),
    ).toBe("http://localhost:5173/app");
  });

  it("strips trailing sentence punctuation", () => {
    expect(browserClipboardUrl("see http://localhost:3000, then go")).toBe(
      "http://localhost:3000/",
    );
    expect(browserClipboardUrl("(http://localhost:3000)")).toBe(
      "http://localhost:3000/",
    );
  });

  it.each([
    "",
    "no url here",
    "file:///etc/passwd",
    "localhost:3000",
    "ftp://example.com",
  ])("rejects clipboard text without an http(s) URL: %j", (text) => {
    expect(browserClipboardUrl(text)).toBe("");
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

  it("never persists embedded credentials", () => {
    rememberBrowserUrl("/repo/a", "http://user:hunter2@localhost:3000/app");
    expect(rememberedBrowserUrl("/repo/a")).toBe("http://localhost:3000/app");
    expect(localStorage.getItem("monocode.browserUrls")).not.toContain(
      "hunter2",
    );
  });
});

describe("browser bookmarks", () => {
  beforeEach(() => localStorage.clear());

  it("toggles a page in and out", () => {
    expect(toggleBrowserFavorite("http://localhost:3000/", "Dev App")).toBe(
      true,
    );
    expect(isBrowserFavorite("http://localhost:3000/")).toBe(true);
    expect(browserFavorites()[0]).toMatchObject({
      url: "http://localhost:3000/",
      title: "Dev App",
    });
    expect(toggleBrowserFavorite("http://localhost:3000/")).toBe(false);
    expect(browserFavorites()).toHaveLength(0);
  });

  it("renames and re-points a bookmark", () => {
    toggleBrowserFavorite("http://localhost:3000/", "Dev App");
    const id = browserFavorites()[0].id;
    updateBrowserFavorite(id, { title: "  Dashboard  ", url: "localhost:4000" });
    expect(browserFavorites()[0]).toMatchObject({
      id,
      title: "Dashboard",
      url: "https://localhost:4000/",
    });
  });

  it("keeps the edited entry when its new URL collides", () => {
    toggleBrowserFavorite("http://a.test/", "A");
    toggleBrowserFavorite("http://b.test/", "B");
    const [b, a] = browserFavorites();
    expect(b.url).toBe("http://b.test/");
    updateBrowserFavorite(b.id, { url: "http://a.test/" });
    const list = browserFavorites();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);
    expect(list[0].title).toBe("B");
    expect(a.id).not.toBe(list[0].id);
  });

  it("keeps the old URL when the edit is invalid", () => {
    toggleBrowserFavorite("http://localhost:3000/", "Dev");
    const id = browserFavorites()[0].id;
    updateBrowserFavorite(id, { url: "file:///etc/passwd" });
    expect(browserFavorites()[0].url).toBe("http://localhost:3000/");
  });

  it("notifies subscribers on write and foreign storage", () => {
    const seen: number[] = [];
    const unsub = subscribeBrowserFavorites(() =>
      seen.push(browserFavorites().length),
    );
    toggleBrowserFavorite("http://localhost:3000/", "Dev");
    removeBrowserFavorite(browserFavorites()[0].id);
    unsub();
    expect(seen).toEqual([1, 0]);
  });

  it("drops malformed or non-http entries when reading", () => {
    localStorage.setItem(
      "monocode.browserFavorites",
      JSON.stringify([
        { id: "ok", url: "http://localhost:3000/", title: "Dev" },
        { id: "bad", url: "file:///etc/passwd", title: "Nope" },
        { url: "http://localhost:4000/" },
        "garbage",
      ]),
    );
    expect(browserFavorites()).toEqual([
      { id: "ok", url: "http://localhost:3000/", title: "Dev" },
    ]);
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

  it("updateBrowserTab toggles expanded without touching url or title", () => {
    const browser = {
      ...newBrowserTab("/repo", "http://localhost:3000/"),
      id: "b1",
    };
    const tab = {
      ...newTab("s1"),
      editorPanes: [{ id: "p1", files: [browser], activeFileId: "b1" }],
    };
    const expanded = updateBrowserTab(tab, "b1", { expanded: true });
    const entry = expanded.editorPanes[0].files[0];
    expect(entry.browser?.expanded).toBe(true);
    expect(entry.browser?.url).toBe("http://localhost:3000/");

    // A later navigation patch keeps the expanded flag.
    const navigated = updateBrowserTab(expanded, "b1", {
      url: "http://localhost:3000/next",
    });
    expect(navigated.editorPanes[0].files[0].browser?.expanded).toBe(true);

    const restored = updateBrowserTab(navigated, "b1", { expanded: false });
    expect(
      restored.editorPanes[0].files[0].browser?.expanded,
    ).toBeUndefined();
  });

  it("updateBrowserTab stores the private flag and keeps it through later patches", () => {
    const browser = { ...newBrowserTab("/repo", "http://localhost:3000/"), id: "b1" };
    const tab = {
      ...newTab("s1"),
      editorPanes: [{ id: "p1", files: [browser], activeFileId: "b1" }],
    };
    let next = updateBrowserTab(tab, "b1", { persist: false });
    let entry = next.editorPanes[0].files[0];
    expect(entry.browser?.persist).toBe(false);

    // A title patch keeps the flag.
    next = updateBrowserTab(next, "b1", { title: "App" });
    entry = next.editorPanes[0].files[0];
    expect(entry.browser?.persist).toBe(false);
    expect(entry.browser?.title).toBe("App");
  });

  it("updateBrowserTab keeps the url on an empty patch and normalizes persist:true", () => {
    const browser = { ...newBrowserTab("/repo", "http://localhost:3000/"), id: "b1" };
    const tab = {
      ...newTab("s1"),
      editorPanes: [{ id: "p1", files: [browser], activeFileId: "b1" }],
    };
    // An empty url must not blank the tab or its file path — transient
    // page events can report one during a load handoff.
    let next = updateBrowserTab(tab, "b1", { url: "", title: "Loading" });
    let entry = next.editorPanes[0].files[0];
    expect(entry.browser?.url).toBe("http://localhost:3000/");
    expect(entry.path).toBe("http://localhost:3000/");
    expect(entry.browser?.title).toBe("Loading");

    // persist is the default — a true patch must not serialize it.
    next = updateBrowserTab(next, "b1", { persist: false });
    entry = next.editorPanes[0].files[0];
    expect(entry.browser?.persist).toBe(false);
    next = updateBrowserTab(next, "b1", { persist: true });
    entry = next.editorPanes[0].files[0];
    expect(entry.browser?.persist).toBeUndefined();
  });

  it("newBrowserTab marks a private tab", () => {
    const file = newBrowserTab("/repo", "http://localhost:3000/", false);
    expect(file.browser?.persist).toBe(false);
    expect(newBrowserTab("/repo", "http://localhost:3000/").browser?.persist).toBeUndefined();
  });
});

describe("browser command requests", () => {
  it("dispatches a labelled command event", () => {
    const seen: string[] = [];
    const onEvent = (event: Event) => {
      if (isBrowserCommandRequest(event)) {
        seen.push(`${event.detail.label}:${event.detail.command}`);
      }
    };
    window.addEventListener("monocode:browser-command", onEvent);
    try {
      requestBrowserCommand("browser-1", "find");
      requestBrowserCommand("browser-2", "devtools");
    } finally {
      window.removeEventListener("monocode:browser-command", onEvent);
    }
    expect(seen).toEqual(["browser-1:find", "browser-2:devtools"]);
  });

  it("rejects non-command events", () => {
    expect(isBrowserCommandRequest(new Event("x"))).toBe(false);
    expect(
      isBrowserCommandRequest(
        new CustomEvent("x", { detail: { label: "browser-1" } }),
      ),
    ).toBe(false);
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

  it("round-trips the expanded flag only when true", () => {
    const parsed = parseWorkspaceSnapshot(
      snapshotWith([
        {
          id: "b1",
          path: "http://localhost:3000/",
          cwd: "/repo",
          browser: {
            url: "http://localhost:3000/",
            expanded: true,
          },
        },
        {
          id: "b2",
          path: "http://localhost:4000/",
          cwd: "/repo",
          browser: { url: "http://localhost:4000/", expanded: "yes" },
        },
      ]),
    );
    const files = parsed?.tabs[0].editorPanes[0].files;
    expect(files?.[0].browser?.expanded).toBe(true);
    expect(files?.[1].browser?.expanded).toBeUndefined();
  });

  it("round-trips the private flag, sanitizing bad values", () => {
    const parsed = parseWorkspaceSnapshot(
      snapshotWith([
        {
          id: "b1",
          path: "http://localhost:3000/",
          cwd: "/repo",
          browser: {
            url: "http://localhost:3000/",
            persist: false,
          },
        },
        {
          id: "b2",
          path: "http://localhost:4000/",
          cwd: "/repo",
          browser: { url: "http://localhost:4000/", persist: "no" },
        },
      ]),
    );
    const files = parsed?.tabs[0].editorPanes[0].files;
    expect(files?.[0].browser?.persist).toBe(false);
    // A non-boolean persist falls back to the persistent default.
    expect(files?.[1].browser?.persist).toBeUndefined();
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

describe("sanitizeCaptureUrl", () => {
  it("strips embedded credentials", () => {
    expect(sanitizeCaptureUrl("http://user:hunter2@localhost:3000/app")).toBe(
      "http://localhost:3000/app",
    );
  });

  it("leaves a plain URL and a non-URL untouched", () => {
    expect(sanitizeCaptureUrl("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1",
    );
    expect(sanitizeCaptureUrl("not a url")).toBe("not a url");
  });
});

describe("browserAgentContext", () => {
  const capture = (over: Partial<BrowserCapture> = {}): BrowserCapture => ({
    url: "http://localhost:3000/app",
    title: "Dev App",
    text: "Dashboard content",
    controls: ["a: /settings", "button: Deploy"],
    console: [{ level: "error", text: "boom" }],
    steps: [],
    headings: [],
    ...over,
  });

  it("carries URL, worktree and host in the origin line", () => {
    const context = browserAgentContext(capture(), "/repo/app");
    const entry = context.entries[0];
    expect(entry.title).toBe("Browser: Dev App");
    expect(entry.origin).toContain("http://localhost:3000/app");
    expect(entry.origin).toContain("/repo/app");
    expect(entry.origin).toContain("native host");
  });

  it("marks WSL worktrees in the origin line", () => {
    const context = browserAgentContext(
      capture(),
      "//wsl.localhost/Ubuntu/home/me/app",
    );
    expect(context.entries[0].origin).toContain("WSL Ubuntu");
  });

  it("sanitizes credentials out of the captured URL", () => {
    const context = browserAgentContext(
      capture({ url: "http://user:pw@localhost:3000/app" }),
      "/repo/app",
    );
    expect(context.entries[0].origin).not.toContain("user:pw");
    expect(context.entries[0].origin).toContain("http://localhost:3000/app");
  });

  it("attaches the screenshot as a vision image when present", () => {
    const png = Buffer.from("fake-png").toString("base64");
    const context = browserAgentContext(capture({ screenshot: png }), "/repo");
    expect(context.attachments).toHaveLength(1);
    expect(context.attachments[0].mimeType).toBe("image/png");
    expect(context.attachments[0].kind).toBe("image");
    expect(context.attachments[0].data).toBe(png);
    expect(context.attachments[0].size).toBe(8);
  });

  it("works text-only when the platform has no screenshot", () => {
    const context = browserAgentContext(
      capture({ screenshot: undefined }),
      "/repo",
    );
    expect(context.attachments).toHaveLength(0);
    expect(context.entries[0].text).toContain("Dashboard content");
    expect(context.entries[0].text).toContain("- a: /settings");
    expect(context.entries[0].text).toContain("- [error] boom");
  });

  it("still produces an entry for a blank page", () => {
    const context = browserAgentContext(
      capture({ text: "", controls: [], console: [], title: "" }),
      "/repo",
    );
    expect(context.entries).toHaveLength(1);
    expect(context.entries[0].text).toContain("no visible text");
    expect(context.entries[0].title).toBe("Browser: localhost:3000");
  });

  it("describes what is on screen", () => {
    const context = browserAgentContext(
      capture({
        viewport: { width: 1200, height: 800, scrollY: 400, pageHeight: 1600 },
        focused: 'input "Search"',
        selection: "error boundary",
        headings: ["h1 Dashboard", "h2 Deploys"],
      }),
      "/repo",
    );
    const text = context.entries[0].text;
    expect(text).toContain("### On screen");
    expect(text).toContain("Viewport 1200×800 — 50% down the page");
    expect(text).toContain('Focused element: input "Search"');
    expect(text).toContain('Selected text: "error boundary"');
    expect(text).toContain("Visible headings: h1 Dashboard › h2 Deploys");
  });

  it("clamps scroll depth when the page shrank after scrolling", () => {
    const context = browserAgentContext(
      capture({
        viewport: { width: 1200, height: 800, scrollY: 900, pageHeight: 1200 },
      }),
      "/repo",
    );
    expect(context.entries[0].text).toContain("100% down the page");
  });

  it("omits the on-screen section when nothing was captured", () => {
    const context = browserAgentContext(
      capture({ viewport: undefined, focused: "", selection: "  " }),
      "/repo",
    );
    expect(context.entries[0].text).not.toContain("On screen");
  });

  it("renders recent steps only when asked", () => {
    const steps = [
      { at: 1000, text: "Opened http://localhost:3000/" },
      { at: 2500, text: 'Clicked button "Deploy"' },
      { at: 4000, text: 'Typed "fix" in input "Search"' },
    ];
    const withSteps = browserAgentContext(capture({ steps }), "/repo", true);
    const text = withSteps.entries[0].text;
    expect(text).toContain(
      "### Recent steps — began 1970-01-01T00:00:01.000Z",
    );
    expect(text).toContain("1. +0.0s Opened http://localhost:3000/");
    expect(text).toContain('2. +1.5s Clicked button "Deploy"');
    expect(text).toContain('3. +3.0s Typed "fix" in input "Search"');

    const plain = browserAgentContext(capture({ steps }), "/repo");
    expect(plain.entries[0].text).not.toContain("Recent steps");
    expect(plain.entries[0].text).not.toContain("Clicked button");
  });

  it("strips embedded credentials inside step text", () => {
    const steps = [
      {
        at: 0,
        text: "Opened http://user:hunter2@localhost:3000/app",
      },
    ];
    const context = browserAgentContext(capture({ steps }), "/repo", true);
    expect(context.entries[0].text).not.toContain("hunter2");
    expect(context.entries[0].text).toContain(
      "Opened http://localhost:3000/app",
    );
  });
});

it("keeps browser pages out of filesystem operations and private tabs apart", () => {
  const persistent = newBrowserTab("/repo", "https://example.test");
  const privateTab = newBrowserTab("/repo", "https://example.test", false);
  expect(isFilesystemTab(persistent)).toBe(false);
  expect(editorTabKey(persistent)).not.toBe(editorTabKey(privateTab));
});

it("restores blank browser tabs and owning worktree metadata", () => {
  const raw = { ...newBrowserTab("/repo/worktree", "", false), projectCwd: "/repo" };
  expect(restoreBrowserTab(raw)).toEqual(raw);
});

it.each([{ agent: { sessionId: "s", leadId: "l", harness: "codex" } }, { changeKind: "staged" }])("rejects conflicting browser snapshot kinds: %j", conflict => {
  expect(restoreBrowserTab({ ...newBrowserTab("/repo", "https://example.test"), ...conflict })).toBeNull();
});

it("rejects malformed persisted web addresses", () => {
  expect(restoreBrowserTab({ ...newBrowserTab("/repo", "https://[broken") })).toBeNull();
});


describe("browser workspace isolation", () => {
  it("keeps existing file identity and restores session focus when closing a browser-only pane", () => {
    const original = newTab("conversation");
    const browser = newBrowserTab("/repo", "https://example.test");
    const opened = openBrowserTab(original, browser);
    expect(leafIds(opened.layout)).toContain("conversation");
    const closed = closeBrowserTabs(opened)!;
    expect(closed.layout).toEqual(original.layout);
    expect(closed.focusedId).toBe("conversation");
    expect(closed.terminalPanes).toBe(original.terminalPanes);
    expect(closed.editorPanes).toEqual([]);

    const file = newFileTab("/repo/a.ts", "/repo");
    const withFile = openEditorTab(original, file, { pin: true });
    const mixed = openBrowserTab(withFile, browser);
    const result = closeBrowserTabs(mixed)!;
    expect(result.editorPanes[0].files).toEqual([file]);
    expect(result.editorPanes[0].files[0]).toBe(file);
    expect(result.editorPanes[0].activeFileId).toBe(file.id);
    expect(result.layout).toBe(mixed.layout);
  });

  it("keeps unrelated empty panes and permits more than one blank browser tab", () => {
    const original = newTab("conversation");
    const first = newBrowserTab("/repo", "");
    const second = newBrowserTab("/repo", "");
    const opened = openBrowserTab(openBrowserTab(original, first), second);
    expect(opened.editorPanes[0].files).toEqual([first, second]);
    const empty = { id: "empty", activeFileId: "", files: [] };
    const withEmpty = { ...original, layout: leaf("empty"), focusedId: "empty", editorPanes: [empty] };
    expect(closeBrowserTabs(withEmpty)?.editorPanes[0]).toBe(empty);
    expect(closeBrowserTabs({ ...opened, layout: leaf(opened.focusedId) })).toBeNull();
  });

  it("keeps the conversation on its existing edge when expanding the browser", () => {
    const left = browserDockBand({ x: 0, y: 0, w: 0.5, h: 1 }, { w: 1200, h: 800 });
    expect(left.side).toBe("left");
    expect(left.agent).toEqual({ x: 0, y: 0, w: 0.32, h: 1 });
    expect(left.rest.x).toBe(left.agent.w);
    expect(left.rest.w + left.agent.w).toBeCloseTo(1);
    const bottom = browserDockBand({ x: 0, y: 0.7, w: 1, h: 0.3 }, { w: 800, h: 600 });
    expect(bottom.side).toBe("bottom");
    expect(bottom.agent.h).toBe(0.3);
    expect(bottom.agent.y + bottom.agent.h).toBe(1);
    expect(bottom.rest.h + bottom.agent.h).toBe(1);
  });
});
