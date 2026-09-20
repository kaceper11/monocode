// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
import { registerBrowserTerminalLinks } from "./browserTerminalLinks";
import { LINK_CHOICE_EVENT } from "./browser";

it("opens links only after activation, binding localhost choices to the current terminal worktree", () => {
  let provider!: ILinkProvider;
  const dispose = vi.fn();
  let cwd = "/repo";
  const text = "Local: http://localhost:3000/app, docs https://example.test/help.";
  const term = {
    cols: 80,
    buffer: { active: { length: 2, getLine: (row: number) => row === 1 ? ({
      translateToString: () => text, length: text.length,
      getCell: (x: number) => ({ getWidth: () => 1, getChars: () => text[x] }),
    }) : undefined } },
    registerLinkProvider: (value: ILinkProvider) => { provider = value; return { dispose }; },
  } as unknown as Terminal;
  const registration = registerBrowserTerminalLinks(term, () => cwd);
  let links: ILink[] = [];
  provider.provideLinks(2, value => { links = value ?? []; });
  expect(links.map(link => link.text)).toEqual(["http://localhost:3000/app", "https://example.test/help"]);
  expect(openUrl).not.toHaveBeenCalled();
  const choice = vi.fn();
  window.addEventListener(LINK_CHOICE_EVENT, choice);
  try {
    cwd = "//wsl.localhost/Ubuntu/home/dev/repo";
    links[0].activate(new MouseEvent("click", { clientX: 12, clientY: 34 }), links[0].text);
    expect(choice).toHaveBeenCalledOnce();
    expect((choice.mock.calls[0][0] as CustomEvent).detail).toEqual({ url: links[0].text, cwd, x: 12, y: 34 });
    expect(openUrl).not.toHaveBeenCalled();
    links[1].activate(new MouseEvent("click"), links[1].text);
    expect(openUrl).toHaveBeenCalledWith(links[1].text);
    expect(choice).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener(LINK_CHOICE_EVENT, choice);
    registration.dispose();
  }
  expect(dispose).toHaveBeenCalledOnce();
});


it("maps wide and combined characters to terminal cells rather than string offsets", async () => {
  const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  let provider!: ILinkProvider;
  vi.spyOn(term, "registerLinkProvider").mockImplementation(value => {
    provider = value;
    return { dispose: () => {} };
  });
  const registration = registerBrowserTerminalLinks(term, () => "/repo");
  try {
    for (const prefix of ["中 ", "e\u0301 ", "🚀 "]) {
      term.reset();
      await new Promise<void>(resolve => term.write(prefix + "http://localhost:3000", resolve));
      const line = term.buffer.active.getLine(0)!;
      let expectedStart = 0;
      for (let x = 0; x < line.length; x++) {
        if (line.getCell(x)!.getChars() === "h") { expectedStart = x + 1; break; }
      }
      let links: ILink[] = [];
      provider.provideLinks(1, value => { links = value ?? []; });
      expect(links).toHaveLength(1);
      expect(links[0].range).toEqual({
        start: { x: expectedStart, y: 1 },
        end: { x: expectedStart + "http://localhost:3000".length - 1, y: 1 },
      });
    }
  } finally {
    registration.dispose();
    term.dispose();
  }
});


it("keeps a wrapped URL intact when activating any of its terminal rows", async () => {
  const term = new Terminal({ cols: 16, rows: 10, allowProposedApi: true });
  let provider!: ILinkProvider;
  vi.spyOn(term, "registerLinkProvider").mockImplementation(value => {
    provider = value;
    return { dispose: () => {} };
  });
  const registration = registerBrowserTerminalLinks(term, () => "/repo");
  try {
    const url = "http://localhost:3000/a-long-path";
    await new Promise<void>(resolve => term.write("中 " + url, resolve));
    for (const row of [1, 2, 3]) {
      let links: ILink[] = [];
      provider.provideLinks(row, value => { links = value ?? []; });
      expect(links.map(link => link.text)).toEqual([url]);
      expect(links[0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: (3 + url.length - 1) % 16 + 1, y: 3 } });
    }
  } finally {
    registration.dispose();
    term.dispose();
  }
});
