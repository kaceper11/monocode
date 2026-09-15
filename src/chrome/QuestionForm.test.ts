// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionForm } from "./QuestionForm";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

async function mount(allowCustom: boolean, error?: string) {
  const host = document.createElement("div");
  const onReply = vi.fn();
  root = createRoot(host);
  await act(async () => root!.render(createElement(QuestionForm, {
    prompt: {
      requestId: 7, error,
      questions: [{ id: "q", prompt: "Pick an option", multiSelect: false, allowCustom, options: [{ id: "other-id", label: "Other" }] }],
    },
    onReply,
  })));
  const other = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Other"))!;
  await act(async () => other.click());
  return { host, onReply };
}

it("submits a provider's Other option without exposing unsupported custom input", async () => {
  const { host, onReply } = await mount(false, "Choose a supported option");
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Choose a supported option");
  const submit = host.querySelector<HTMLButtonElement>('[type="submit"]')!;
  expect(submit.disabled).toBe(false);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onReply).toHaveBeenCalledWith(7, { kind: "answered", answers: { q: ["other-id"] } });
});

it("retains the custom input for providers that support it", async () => {
  const { host } = await mount(true);
  expect(host.querySelector("input")).not.toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
});

it.each(["invalid", "skipped"])("lets users correct an earlier %s numeric answer without losing later answers", async (firstAnswer) => {
  const { acpElicitation, acpElicitationResult } = await import("../lib/harness/acp");
  const form = acpElicitation({ requestedSchema: { type: "object", required: ["count"], properties: {
    count: { type: "integer", minimum: 1, title: "Count" },
    name: { type: "string", title: "Name" },
  } } })!;
  const host = document.createElement("div");
  root = createRoot(host);
  const onReply = vi.fn();
  const render = (error?: string) => act(async () => root!.render(createElement(QuestionForm, {
    prompt: { requestId: 9, questions: form.questions, error }, onReply,
  })));
  const submit = () => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const fill = (value: string) => act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render();
  if (firstAnswer === "invalid") {
    await fill("NaN");
    await submit();
  } else {
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Skip")!.click());
  }
  await fill("example");
  await submit();
  expect(() => acpElicitationResult(onReply.mock.calls[0][1], form.questions, form.fields)).toThrow(firstAnswer === "invalid" ? "Invalid integer" : "Answer the required question");
  await render(firstAnswer === "invalid" ? "Invalid integer answer for count" : "Answer the required question: count");
  const back = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Back")!;
  await act(async () => back.click());
  expect(host.querySelector("input")!.value).toBe(firstAnswer === "invalid" ? "NaN" : "");
  await fill("3");
  await submit();
  expect(host.querySelector("input")!.value).toBe("example");
  await submit();
  expect(acpElicitationResult(onReply.mock.calls.at(-1)![1], form.questions, form.fields)).toEqual({ action: "accept", content: { count: 3, name: "example" } });
});
