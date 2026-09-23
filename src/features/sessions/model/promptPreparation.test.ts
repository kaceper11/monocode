import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareAttachments: vi.fn(),
  beginSessionTurn: vi.fn(),
  applyFileMentionsToTurn: vi.fn(),
  applyNotesToTurn: vi.fn(),
  applySkillsToTurn: vi.fn(),
  events: [] as string[],
  warmNativeSkills: vi.fn(),
}));

vi.mock("../../files/model/fileMentions", () => ({
  applyFileMentionsToTurn: mocks.applyFileMentionsToTurn,
}));

vi.mock("../../notes", () => ({
  applyNotesToTurn: mocks.applyNotesToTurn,
}));

vi.mock("../../skills/model/skills", () => ({
  applySkillsToTurn: mocks.applySkillsToTurn,
  warmNativeSkills: mocks.warmNativeSkills,
  isNativeCommandPrompt: (text: string, harness: string) =>
    harness === "omp" && text.startsWith("/"),
}));

vi.mock("./attachments", () => ({
  prepareAttachments: mocks.prepareAttachments,
}));
vi.mock("./checkpoint", () => ({ beginSessionTurn: mocks.beginSessionTurn }));

import { preparePrompt, prepareTurn } from "./promptPreparation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.events.length = 0;
  mocks.prepareAttachments.mockReset().mockResolvedValue([]);
  mocks.beginSessionTurn.mockReset().mockResolvedValue(undefined);
  mocks.applyFileMentionsToTurn.mockReset();
  mocks.applyNotesToTurn.mockReset();
  mocks.applyNotesToTurn.mockImplementation(async (text: string) => text);
  mocks.applySkillsToTurn.mockReset();
  mocks.warmNativeSkills.mockReset();
  mocks.warmNativeSkills.mockImplementation(() => {
    mocks.events.push("warm");
  });
});

describe("preparePrompt", () => {
  it.each([
    "/workflow foo @README.md",
    "/Review_Code a:b",
    "/omp:compact custom instructions",
  ])("preserves native command arguments: %s", async (text) => {
    await expect(
      preparePrompt(text, { harness: "omp", cwd: "/repo" }),
    ).resolves.toBe(text.replace("/omp:compact", "/compact"));
    expect(mocks.applyFileMentionsToTurn).not.toHaveBeenCalled();
    expect(mocks.applyNotesToTurn).not.toHaveBeenCalled();
    expect(mocks.applySkillsToTurn).not.toHaveBeenCalled();
  });
  it("starts warmup before awaiting file mentions", async () => {
    const files = deferred<string>();
    mocks.applyFileMentionsToTurn.mockImplementation(() => {
      mocks.events.push("files");
      return files.promise;
    });
    mocks.applySkillsToTurn.mockResolvedValue("prepared");

    const preparation = preparePrompt("hello", {
      harness: "pi",
      cwd: "/repo",
    });
    expect(mocks.events).toEqual(["warm", "files"]);

    files.resolve("with files");
    await expect(preparation).resolves.toBe("prepared");
    expect(mocks.applyNotesToTurn).toHaveBeenCalledWith("with files");
    expect(mocks.applySkillsToTurn).toHaveBeenCalledWith("with files", {
      harness: "pi",
      cwd: "/repo",
    });
  });
});

describe("prepareTurn", () => {
  const context = { harness: "codex" as const, sessionId: "s", cwd: "/repo" };

  it("overlaps independent preparation but waits for the durable snapshot", async () => {
    const checkpoint = deferred<void>();
    const attachments = deferred<[]>();
    const prompt = deferred<string>();
    mocks.beginSessionTurn.mockReturnValue(checkpoint.promise);
    mocks.prepareAttachments.mockReturnValue(attachments.promise);
    mocks.applyFileMentionsToTurn.mockReturnValue(prompt.promise);
    mocks.applySkillsToTurn.mockImplementation(async (text: string) => text);
    let submitted = false;
    const ready = prepareTurn("HI", [], context, { checkpoint: true }).then(
      (value) => {
        submitted = true;
        return value;
      },
    );
    expect(mocks.beginSessionTurn).toHaveBeenCalledWith("s", "/repo");
    expect(mocks.prepareAttachments).toHaveBeenCalled();
    expect(mocks.applyFileMentionsToTurn).toHaveBeenCalled();
    attachments.resolve([]);
    prompt.resolve("prepared");
    await Promise.resolve();
    expect(submitted).toBe(false);
    checkpoint.resolve();
    await expect(ready).resolves.toEqual({ text: "prepared", attachments: [] });
  });

  it("preserves literal build prompts and does not checkpoint steering", async () => {
    await expect(
      prepareTurn("approved plan", [], context, { literal: true }),
    ).resolves.toEqual({ text: "approved plan", attachments: [] });
    expect(mocks.applyFileMentionsToTurn).not.toHaveBeenCalled();
    expect(mocks.beginSessionTurn).not.toHaveBeenCalled();
  });

  it("preserves checkpoint failure behavior but rejects attachment failures", async () => {
    mocks.beginSessionTurn.mockRejectedValue(new Error("no repository"));
    await expect(
      prepareTurn("HI", [], context, { literal: true, checkpoint: true }),
    ).resolves.toMatchObject({ text: "HI" });
    mocks.prepareAttachments.mockRejectedValue(new Error("wrong host"));
    await expect(
      prepareTurn("HI", [], context, { literal: true, checkpoint: true }),
    ).rejects.toThrow("wrong host");
  });
});
