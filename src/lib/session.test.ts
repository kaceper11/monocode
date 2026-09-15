import { expect, it } from "vitest";
import { appendUser } from "./harness/apply";
import { newSession, sessionDecisionHarness } from "./session";

it("keeps pending decisions on their running provider after a next-provider pick", () => {
  const running = appendUser(newSession("muse", "/tmp"), "Inspect this");
  const switched = {
    ...running,
    harness: "codex" as const,
    pendingSwitch: { from: "muse" as const, fromModel: running.model },
  };
  expect(sessionDecisionHarness(switched)).toBe("muse");
  expect(sessionDecisionHarness({ ...switched, activeTurnModel: undefined })).toBe("muse");
  expect(sessionDecisionHarness(newSession("codex", "/tmp"))).toBe("codex");
});
