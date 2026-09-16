import { describe, expect, it } from "vitest";
import {
  canTabVisitBack,
  canTabVisitForward,
  emptyTabVisitHistory,
  pruneTabVisitHistory,
  recordTabVisit,
  tabVisitBack,
  tabVisitForward,
  type VisitLocation,
} from "./tabVisitHistory";

const tab = (id: string, leaf?: string): VisitLocation =>
  leaf === undefined ? { tab: id } : { tab: id, leaf };
const view = (
  name: "inbox" | "search" | "settings" | "notes",
): VisitLocation => ({
  view: name,
});

describe("tab visit history", () => {
  it("returns to the previous tab", () => {
    let history = recordTabVisit(emptyTabVisitHistory(tab("a")), tab("b"));
    expect(canTabVisitBack(history)).toBe(true);
    expect(canTabVisitForward(history)).toBe(false);

    history = tabVisitBack(history)!;
    expect(history.current).toEqual(tab("a"));
    expect(canTabVisitBack(history)).toBe(false);
    expect(canTabVisitForward(history)).toBe(true);
  });

  it("restores the tab after going back", () => {
    let history = recordTabVisit(emptyTabVisitHistory(tab("a")), tab("b"));
    history = tabVisitBack(history)!;
    history = tabVisitForward(history)!;
    expect(history.current).toEqual(tab("b"));
    expect(canTabVisitForward(history)).toBe(false);
  });

  it("drops the forward stack when visiting a new tab after back", () => {
    let history = recordTabVisit(emptyTabVisitHistory(tab("a")), tab("b"));
    history = tabVisitBack(history)!;
    history = recordTabVisit(history, tab("c"));
    expect(history.current).toEqual(tab("c"));
    expect(canTabVisitForward(history)).toBe(false);
    expect(tabVisitBack(history)?.current).toEqual(tab("a"));
  });

  it("ignores recording the location already current", () => {
    const start = emptyTabVisitHistory(tab("a"));
    expect(recordTabVisit(start, tab("a"))).toBe(start);
  });

  it("records a leaf change inside the same tab", () => {
    let history = recordTabVisit(
      emptyTabVisitHistory(tab("a", "s1")),
      tab("a", "s2"),
    );
    history = tabVisitBack(history)!;
    expect(history.current).toEqual(tab("a", "s1"));
  });

  it("records overlay visits and returns through them", () => {
    let history = recordTabVisit(emptyTabVisitHistory(tab("a")), view("inbox"));
    history = recordTabVisit(history, tab("b"));
    expect(tabVisitBack(history)?.current).toEqual(view("inbox"));
    history = tabVisitBack(history)!;
    history = tabVisitBack(history)!;
    expect(history.current).toEqual(tab("a"));
  });

  it("distinguishes inbox visits by the embedded conversation", () => {
    const inbox = (conversation?: string): VisitLocation =>
      conversation === undefined
        ? view("inbox")
        : { view: "inbox", conversation };
    let history = recordTabVisit(
      emptyTabVisitHistory(view("inbox")),
      inbox("s1"),
    );
    // A conversation switch inside the inbox is a real location change.
    history = recordTabVisit(history, inbox("s2"));
    history = recordTabVisit(history, tab("b"));
    expect(tabVisitBack(history)?.current).toEqual(inbox("s2"));
    history = tabVisitBack(history)!;
    expect(history.current).toEqual(inbox("s2"));
    history = tabVisitBack(history)!;
    expect(history.current).toEqual(inbox("s1"));
    history = tabVisitBack(history)!;
    expect(history.current).toEqual(view("inbox"));
  });

  it("does not keep a closed current tab on the back stack", () => {
    const history = pruneTabVisitHistory(
      recordTabVisit(emptyTabVisitHistory(tab("a")), tab("b")),
      new Set(["a"]),
      tab("a"),
    );
    expect(history).toEqual({ back: [], forward: [], current: tab("a") });
    expect(canTabVisitBack(history)).toBe(false);
  });

  it("skips a closed tab in the middle of the stack", () => {
    let history = recordTabVisit(emptyTabVisitHistory(tab("a")), tab("b"));
    history = recordTabVisit(history, tab("c"));
    history = pruneTabVisitHistory(history, new Set(["a", "c"]), tab("c"));
    expect(tabVisitBack(history)?.current).toEqual(tab("a"));
  });

  it("keeps overlay visits when the tab underneath closes", () => {
    let history = recordTabVisit(
      emptyTabVisitHistory(tab("a")),
      view("search"),
    );
    history = recordTabVisit(history, tab("b"));
    history = pruneTabVisitHistory(history, new Set(["b"]), tab("b"));
    expect(tabVisitBack(history)?.current).toEqual(view("search"));
  });

  it("collapses interior duplicates left by dropped tabs", () => {
    let history = recordTabVisit(emptyTabVisitHistory(tab("a")), tab("b"));
    history = recordTabVisit(history, tab("a"));
    history = recordTabVisit(history, tab("c"));
    history = pruneTabVisitHistory(history, new Set(["a", "c"]), tab("c"));
    expect(history.back).toEqual([tab("a")]);
  });

  it("collapses a round-trip once the other tab closes", () => {
    let history = recordTabVisit(emptyTabVisitHistory(tab("a")), tab("b"));
    history = recordTabVisit(history, tab("a"));
    history = pruneTabVisitHistory(history, new Set(["a"]), tab("a"));
    expect(history).toEqual({ back: [], forward: [], current: tab("a") });
  });
});
