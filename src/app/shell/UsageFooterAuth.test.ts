// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  loginHarness: vi.fn<(_harness: string) => Promise<void>>(),
}));
const rateLimitsFetch = vi.hoisted(() => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchClaudeRateLimits: vi.fn(),
  fetchCodexRateLimits: vi.fn(),
}));

vi.mock("../../integrations/harness/core/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../integrations/harness/core/auth")>()),
  loginHarness: auth.loginHarness,
}));
vi.mock("../../features/providers/model/rateLimitsFetch", () => rateLimitsFetch);

import type { ProviderRateLimits, RateLimitProvider } from "../../features/providers/model/rateLimits";
import { UsageFooter } from "./UsageFooter";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  auth.loginHarness.mockReset();
  rateLimitsFetch.consumeCodexRateLimitResetCredit.mockReset();
  rateLimitsFetch.fetchClaudeRateLimits.mockReset();
  rateLimitsFetch.fetchCodexRateLimits.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}

function signedOutLimits(provider: RateLimitProvider): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt: Date.now(),
    error: `${provider} is not signed in`,
    status: "error",
  };
}

function connectedLimits(provider: RateLimitProvider): ProviderRateLimits {
  return {
    ...signedOutLimits(provider),
    error: null,
    status: "ok",
  };
}

describe("UsageFooter provider authentication", () => {
  it("keeps a healthy Grok provider label non-interactive", () => {
    act(() =>
      root.render(
        createElement(UsageFooter, {
          providers: [],
          session: {
            id: "grok-session",
            harness: "grok",
            authRequired: false,
          },
        }),
      ),
    );

    expect(container.textContent).toContain("grok");
    expect(container.textContent).not.toContain("sign in");
    expect(container.querySelector("button")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens Grok sign-in from its footer provider popover", async () => {
    let finishLogin: (() => void) | undefined;
    auth.loginHarness.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLogin = resolve;
        }),
    );
    act(() =>
      root.render(
        createElement(UsageFooter, {
          providers: [],
          session: {
            id: "grok-session",
            harness: "grok",
            authRequired: true,
          },
        }),
      ),
    );

    expect(container.textContent).toContain("grok");
    expect(container.textContent).toContain("sign in");
    act(() => button("Grok Build sign-in required").click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Authentication required");
    expect(dialog?.querySelector(".size-9")).not.toBeNull();

    act(() => button("Sign in to Grok Build").click());
    expect(auth.loginHarness).toHaveBeenCalledWith("grok", undefined, undefined);
    expect(dialog?.textContent).toContain("Waiting for browser…");

    await act(async () => finishLogin?.());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("sign in");
  });

  it("starts a waiting recovery after another provider login fails", async () => {
    let rejectClaude: ((error: Error) => void) | undefined;
    auth.loginHarness.mockImplementation((harness) => {
      if (harness === "claude") {
        return new Promise<void>((_resolve, reject) => {
          rejectClaude = reject;
        });
      }
      return Promise.resolve();
    });
    rateLimitsFetch.fetchClaudeRateLimits.mockResolvedValue(
      signedOutLimits("claude"),
    );
    rateLimitsFetch.fetchCodexRateLimits
      .mockResolvedValueOnce(signedOutLimits("codex"))
      .mockResolvedValueOnce(connectedLimits("codex"));

    await act(async () => {
      root.render(
        createElement(UsageFooter, {
          providers: ["claude", "codex"],
        }),
      );
    });

    act(() => button("Claude Code usage details").click());
    act(() => button("Sign in to Claude Code").click());
    await vi.waitFor(() =>
      expect(auth.loginHarness).toHaveBeenCalledWith("claude", "default", undefined),
    );

    act(() => button("Codex usage details").click());
    act(() => button("Sign in to Codex").click());
    expect(auth.loginHarness).not.toHaveBeenCalledWith("codex", "default", undefined);

    await act(async () => rejectClaude?.(new Error("Claude login failed")));
    await vi.waitFor(() =>
      expect(auth.loginHarness).toHaveBeenCalledWith("codex", "default", undefined),
    );
  });
});

it("discards native usage after switching to a WSL worktree and keeps account actions guest-scoped", async () => {
  let finishNative!: (value: ProviderRateLimits) => void;
  rateLimitsFetch.fetchCodexRateLimits.mockImplementationOnce(() => new Promise(resolve => { finishNative = resolve; }));
  const usage = (usedPercent: number): ProviderRateLimits => ({ ...connectedLimits("codex"), session: { usedPercent, windowMinutes: 300, resetsAt: Date.now() + 60_000 } });
  const render = (cwd: string) => root.render(createElement(UsageFooter, { providers: ["codex"], project: cwd, session: { id: "same-session", harness: "codex", cwd } }));
  await act(async () => render("C:/repo"));
  rateLimitsFetch.fetchCodexRateLimits.mockResolvedValue(usage(20));
  const cwd = "//wsl.localhost/Ubuntu/home/me/worktree";
  await act(async () => render(cwd));
  expect(rateLimitsFetch.fetchCodexRateLimits).toHaveBeenLastCalledWith("default", cwd);
  await act(async () => finishNative(usage(99)));
  expect(container.textContent).toContain("20%");
  expect(container.textContent).not.toContain("99%");
  act(() => button("Codex usage details").click());
  act(() => button("Switch Codex account").click());
  expect(document.body.textContent).toContain("Ubuntu account");
  expect(document.body.textContent).not.toContain("Add account");
});

it("does not consume a queued reset after its host changes", async () => {
  const limits: ProviderRateLimits = { ...connectedLimits("codex"), resetCredits: { availableCount: 1, credits: [{ id: "credit-1", resetType: "codexRateLimits", status: "available", grantedAt: null, expiresAt: Date.now() + 86_400_000, title: "Reset", description: null }] } };
  rateLimitsFetch.fetchCodexRateLimits.mockResolvedValue(limits);
  const render = (cwd: string) => root.render(createElement(UsageFooter, { providers: ["codex"], project: cwd, session: { id: "session", harness: "codex", cwd } }));
  await act(async () => render("C:/repo"));
  let completeRefresh!: (value: ProviderRateLimits) => void;
  rateLimitsFetch.fetchCodexRateLimits.mockImplementationOnce(() => new Promise(resolve => { completeRefresh = resolve; }));
  act(() => button("Refresh usage").click());
  act(() => button("Codex usage details").click());
  act(() => button("Use reset").click());
  act(() => button("Confirm").click());
  await act(async () => render("//wsl.localhost/Debian/home/me/repo"));
  await act(async () => completeRefresh(limits));
  expect(rateLimitsFetch.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
});
