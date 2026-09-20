// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  changeSavedPrompts,
  promptAvailable,
  readSavedPrompts,
  savedPromptsSnapshot,
} from "./savedPrompts";

const key = "monocode.savedPrompts.v1";
const legacyKey = "monocode.agentActions.v1";
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("preserves legacy bytes and custom text, requiring an explicit legacy scope choice", async () => {
  const legacy = JSON.stringify({
    seeded: true,
    actions: [
      {
        id: "custom",
        name: "Review",
        instructions: " My custom task text \n",
        context: ["task"],
        projectId: "old-project",
      },
    ],
  });
  localStorage.setItem(legacyKey, legacy);
  const [prompt] = readSavedPrompts();
  expect(prompt.text).toBe(" My custom task text \n");
  expect(promptAvailable(prompt, "/repo")).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
  await changeSavedPrompts(savedPromptsSnapshot(), (prompts) =>
    prompts.map((p) => ({ ...p, legacyProjectId: undefined, cwd: "/repo" })),
  );
  expect(localStorage.getItem(legacyKey)).toBe(legacy);
  expect(promptAvailable(readSavedPrompts()[0], "/repo")).toBe(true);
  expect(
    promptAvailable(readSavedPrompts()[0], "//wsl.localhost/Ubuntu/repo"),
  ).toBe(false);
});

it("adapts only exact old defaults and respects intentionally empty lists", () => {
  const instructions =
    "Implement the work described in the context. Work in the task's working copies, keep changes focused, and run the relevant checks when you are done.";
  localStorage.setItem(
    legacyKey,
    JSON.stringify({
      seeded: true,
      actions: [{ id: "implement", name: "Implement", instructions }],
    }),
  );
  expect(readSavedPrompts()[0].text).toContain("this conversation");
  localStorage.setItem(
    legacyKey,
    JSON.stringify({
      seeded: true,
      actions: [
        {
          id: "implement",
          name: "Implement",
          instructions: instructions + " Custom.",
        },
      ],
    }),
  );
  expect(readSavedPrompts()[0].text).toBe(instructions + " Custom.");
  localStorage.setItem(
    legacyKey,
    JSON.stringify({ seeded: true, actions: [] }),
  );
  expect(readSavedPrompts()).toEqual([]);
});

it("saves edits and ordering, rejects stale writes, and never reseeds a deleted list", async () => {
  const old = savedPromptsSnapshot();
  await changeSavedPrompts(old, (prompts) => [...prompts].reverse());
  expect(readSavedPrompts().map((p) => p.id)).toEqual([
    "test",
    "review",
    "implement",
  ]);
  await expect(changeSavedPrompts(old, () => [])).rejects.toThrow(
    /another window/,
  );
  await changeSavedPrompts(savedPromptsSnapshot(), () => []);
  expect(readSavedPrompts()).toEqual([]);
});

it("does not overwrite malformed storage or report failed writes as successful", async () => {
  localStorage.setItem(key, "broken JSON");
  await expect(
    changeSavedPrompts(savedPromptsSnapshot(), () => []),
  ).rejects.toThrow(/preserved/);
  expect(localStorage.getItem(key)).toBe("broken JSON");
  localStorage.clear();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  await expect(changeSavedPrompts("", () => [])).rejects.toThrow(
    "Quota exceeded",
  );
  expect(savedPromptsSnapshot()).toBe("");
});

it("compares Windows scopes while preserving WSL case and host identity", () => {
  const prompt = { id: "p", name: "P", text: "text", cwd: "C:\\Repo" };
  expect(promptAvailable(prompt, "c:/repo/")).toBe(true);
  expect(
    promptAvailable(
      { ...prompt, cwd: "//wsl.localhost/Ubuntu/home/Repo" },
      "//wsl$/ubuntu/home/Repo/",
    ),
  ).toBe(true);
  expect(
    promptAvailable(
      { ...prompt, cwd: "//wsl.localhost/Ubuntu/home/Repo" },
      "//wsl.localhost/Ubuntu/home/repo",
    ),
  ).toBe(false);
  expect(
    promptAvailable(
      { ...prompt, cwd: "//wsl.localhost/Ubuntu/home/Repo" },
      "/home/Repo",
    ),
  ).toBe(false);
});

it("rejects malformed legacy scopes instead of making them global", () => {
  for (const projectId of [0, "", null, false]) {
    localStorage.setItem(
      legacyKey,
      JSON.stringify({
        seeded: true,
        actions: [
          { id: "p", name: "P", instructions: "Private prompt", projectId },
        ],
      }),
    );
    expect(() => readSavedPrompts()).toThrow(/one scope/);
  }
});
