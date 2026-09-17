// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import {
  appDialogSnapshot,
  ask,
  message,
  subscribeAppDialogs,
} from "./dialogs";

afterEach(() => {
  // Never leak a pending request into the next test.
  for (const request of [...appDialogSnapshot()]) request.settle(false);
});

it("queues requests in order and shows the next only after the first settles", async () => {
  const first = ask("One?");
  const second = ask("Two?");
  expect(appDialogSnapshot().map((request) => request.text)).toEqual([
    "One?",
    "Two?",
  ]);

  appDialogSnapshot()[0]!.settle(true);
  expect(await first).toBe(true);
  expect(appDialogSnapshot().map((request) => request.text)).toEqual([
    "Two?",
  ]);

  appDialogSnapshot()[0]!.settle(false);
  expect(await second).toBe(false);
  expect(appDialogSnapshot()).toHaveLength(0);
});

it("distinguishes confirm and notice modes and applies option defaults", async () => {
  const confirm = ask("Sure?", {
    title: "Careful",
    kind: "warning",
    okLabel: "Do it",
    cancelLabel: "No",
  });
  const request = appDialogSnapshot()[0]!;
  expect(request.mode).toBe("confirm");
  expect(request.title).toBe("Careful");
  expect(request.kind).toBe("warning");
  expect(request.okLabel).toBe("Do it");
  expect(request.cancelLabel).toBe("No");
  request.settle(true);
  expect(await confirm).toBe(true);

  const notice = message("Heads up");
  const noticeRequest = appDialogSnapshot()[0]!;
  expect(noticeRequest.mode).toBe("notice");
  // Defaults mirror the plugin-dialog sheet: app title, info, OK.
  expect(noticeRequest.title).toBe("MonoCode");
  expect(noticeRequest.kind).toBe("info");
  expect(noticeRequest.okLabel).toBe("OK");
  noticeRequest.settle(true);
  await notice;
  expect(appDialogSnapshot()).toHaveLength(0);
});

it("notifies subscribers when the queue changes and settles only once", async () => {
  const seen: number[] = [];
  const off = subscribeAppDialogs(() =>
    seen.push(appDialogSnapshot().length),
  );
  const pending = ask("Pick one");
  const request = appDialogSnapshot()[0]!;
  request.settle(true);
  // A second settle is a no-op — the request is already gone.
  request.settle(false);
  expect(await pending).toBe(true);

  off();
  expect(seen).toEqual([1, 0]);
  expect(appDialogSnapshot()).toHaveLength(0);
});
