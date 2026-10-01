import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  harnessHttp: vi.fn(),
  openHarnessSse: vi.fn(),
}));

vi.mock("../../core/child", () => ({
  closeHarnessSse: vi.fn(),
  harnessHttp: mocks.harnessHttp,
  openHarnessSse: mocks.openHarnessSse,
  watchSse: vi.fn(),
}));

import { OpenCodeClient } from "./opencodeClient";

describe("OpenCodeClient.summarizeSession", () => {
  beforeEach(() => {
    mocks.harnessHttp.mockReset();
    mocks.harnessHttp.mockResolvedValue({ status: 200, body: "true" });
  });

  it("calls the native session summarize endpoint with the selected model", async () => {
    const client = new OpenCodeClient("http://127.0.0.1:4096", "/repo");

    await client.summarizeSession("session/a", {
      providerID: "openai",
      modelID: "gpt-5.4",
    });

    expect(mocks.harnessHttp).toHaveBeenCalledWith({
      url: "http://127.0.0.1:4096/session/session%2Fa/summarize?directory=%2Frepo",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": "%2Frepo",
      },
      body: JSON.stringify({ providerID: "openai", modelID: "gpt-5.4" }),
      timeoutMs: 30 * 60_000,
    });
  });
});


describe("OpenCode guest transport", () => {
  const cwd = "//wsl.localhost/Ubuntu/home/me/project";
  beforeEach(() => {
    mocks.harnessHttp.mockReset().mockResolvedValue({ status: 200, body: "{}" });
    mocks.openHarnessSse.mockClear();
  });

  it("uses Linux API directories and authenticates HTTP and SSE", async () => {
    const client = new OpenCodeClient("http://127.0.0.1:4567", cwd, "owned-password");
    await client.createSession({});
    const request = mocks.harnessHttp.mock.calls[0][0];
    expect(new URL(request.url).searchParams.get("directory")).toBe("/home/me/project");
    expect(request.headers).toMatchObject({ "x-opencode-directory": "%2Fhome%2Fme%2Fproject", Authorization: `Basic ${btoa("opencode:owned-password")}` });
    await client.subscribeEvents("thread", () => {});
    expect(mocks.openHarnessSse).toHaveBeenCalledWith("thread", expect.stringContaining("directory=%2Fhome%2Fme%2Fproject"), expect.objectContaining({ Authorization: request.headers.Authorization, "x-opencode-directory": request.headers["x-opencode-directory"] }));
  });

  it("qualifies resumed sessions and sends Linux fork destinations", async () => {
    const client = new OpenCodeClient("http://127.0.0.1:4567", cwd);
    mocks.harnessHttp.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ id: "same-id", directory: "/home/me/project" }) });
    await expect(client.getSession("same-id")).resolves.toEqual({ id: "same-id", directory: cwd });
    await client.forkSession("same-id", "//wsl.localhost/Ubuntu/home/me/worktree");
    expect(new URL(mocks.harnessHttp.mock.calls.at(-1)![0].url).searchParams.get("directory")).toBe("/home/me/worktree");
    const calls = mocks.harnessHttp.mock.calls.length;
    await expect(client.forkSession("same-id", "//wsl.localhost/Debian/home/me/project")).rejects.toThrow("another WSL distribution");
    expect(mocks.harnessHttp).toHaveBeenCalledTimes(calls);
  });

  it("refuses endpoint authentication failures before any write", async () => {
    const client = new OpenCodeClient("http://127.0.0.1:4567", cwd, "owned-password");
    mocks.harnessHttp.mockResolvedValue({ status: 401, body: "denied" });
    await expect(client.waitUntilReady(() => true)).rejects.toThrow("did not authenticate");
    expect(mocks.harnessHttp.mock.calls.map(call => call[0].method)).toEqual(["GET"]);
    mocks.harnessHttp.mockClear();
    await expect(client.waitUntilReady(() => false)).rejects.toThrow("localhost forwarding");
    expect(mocks.harnessHttp).not.toHaveBeenCalled();
  });

  it("checks readiness with a bounded read", async () => {
    const client = new OpenCodeClient("http://127.0.0.1:4567", cwd, "owned-password");
    mocks.harnessHttp.mockResolvedValue({ status: 200, body: '{"healthy":true}' });
    await client.waitUntilReady(() => true);
    expect(mocks.harnessHttp).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", timeoutMs: 500, url: expect.stringContaining("/global/health") }));
  });
});
