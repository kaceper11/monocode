// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useSessionState } from "./useSessionState";
import { appendUser, applyHarnessEvents } from "../lib/harness/apply";
import type { Session } from "../lib/session";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("retains consecutive sends when provider events arrive before a render", async () => {
  const initial = {
    id: "s",
    harness: "muse",
    model: "muse:default",
    blocks: [],
    busy: false,
  } as unknown as Session;
  let state!: ReturnType<typeof useSessionState>;
  function Probe() {
    state = useSessionState(() => [initial]);
    return createElement(
      "div",
      null,
      state[0][0].blocks.map((b) => b.text).join("|"),
    );
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
  await act(async () => {
    for (const text of ["first", "second", "third"]) {
      state[1]((prev) => prev.map((s) => appendUser(s, text)));
      expect(state[2].current[0].busy).toBe(true);
      // Same immediate snapshot used by the native event bridge.
      state[1](
        state[2].current.map((s) =>
          applyHarnessEvents(s, [
            { type: "message.delta", text: "rep" },
            { type: "message.delta", text: "ly" },
            { type: "message.completed" },
          ]),
        ),
      );
    }
  });
  expect(
    state[0][0].blocks.filter((b) => b.role === "user").map((b) => b.text),
  ).toEqual(["first", "second", "third"]);
  expect(host.textContent).toContain("third|reply");
  await act(async () => root.unmount());
});
