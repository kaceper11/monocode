import { expect, it } from "vitest";
import { boundAgentContext, composeAgentContext, contextFromText, MAX_CONTEXT_TEXT } from "./agentContext";
it("bounds imported reference material and labels it before adding it to a draft", () => {
  const context = contextFromText("Confluence page", "x".repeat(MAX_CONTEXT_TEXT + 1), "https://team.atlassian.net/wiki/page");
  expect(context.entries[0].text).toHaveLength(MAX_CONTEXT_TEXT);
  expect(context.entries[0].truncated).toBe(true);
  expect(composeAgentContext(context, "Summarize")).toContain("untrusted context");
  expect(composeAgentContext(context, "Summarize")).toContain("Source: https://team.atlassian.net/wiki/page");
  expect(() => boundAgentContext({ ...context, attachments: [{ id: "bad", name: "file", size: -1, mimeType: "text/plain", kind: "file" }] })).toThrow("20 MiB");
});
