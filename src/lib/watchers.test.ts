// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { emitAttention, emittedAttention } from "./attention";
import {
  deliveryWatcherFor,
  ensureDeliveryWatcher,
  loadWatchers,
  openWatchSheet,
  removeWatcher,
  saveWatcher,
  setWatcherEnabled,
  unwatchAzurePrDelivery,
  unwatchDeliveryScope,
  updateWatcher,
  watchGithubPrUrl,
  watcherPollKey,
  MAX_WATCHER_SEEN,
  OPEN_WATCH_SHEET,
  type Watcher,
  type WatcherSource,
  type WatchSheetRequest,
} from "./watchers";

const JIRA_SOURCE: WatcherSource = {
  kind: "jira-items",
  site: "https://acme.atlassian.net",
  filter: { project: "ENG", filter: "", assigned: true },
};

const draft = (over: Record<string, unknown> = {}) => ({
  name: "Jira · ENG",
  source: JIRA_SOURCE,
  enabled: true,
  mode: "notify" as const,
  intervalSec: 300,
  cooldownSec: 900,
  ...over,
});

beforeEach(() => localStorage.clear());

it("saves a watcher with cursor state initialized for a first poll", () => {
  const { watcher, error } = saveWatcher(draft());
  expect(error).toBeUndefined();
  expect(watcher).toBeDefined();
  expect(watcher!.seen).toEqual([]);
  expect(watcher!.nextPollAt).toBe(0);
  expect(watcher!.failures).toBe(0);
  expect(loadWatchers()).toHaveLength(1);
});

it("requires an action for draft/run modes and a checkout for run", () => {
  expect(saveWatcher(draft({ mode: "draft" })).error).toMatch(/action/i);
  expect(
    saveWatcher(draft({ mode: "run", actionId: "implement" })).error,
  ).toMatch(/checkout/i);
  expect(
    saveWatcher(
      draft({
        mode: "run",
        actionId: "implement",
        target: { cwd: "/repo", harness: "claude", model: "" },
      }),
    ).error,
  ).toBeUndefined();
});

it("rejects empty names and invalid sources", () => {
  expect(saveWatcher(draft({ name: "  " })).error).toMatch(/name/i);
  expect(
    saveWatcher(draft({ source: { kind: "nope" } })).error,
  ).toMatch(/source/i);
});

it("editing a watcher keeps the cursor when the source is unchanged, resets it when re-pointed", () => {
  const { watcher } = saveWatcher(draft());
  updateWatcher(watcher!.id, (row) => ({
    ...row,
    cursor: "2024-01-01T00:00:00Z",
    seen: ["a", "b"],
  }));
  const renamed = saveWatcher(
    draft({ name: "Renamed", cursor: "2024-01-01T00:00:00Z" }),
    watcher!.id,
  ).watcher!;
  expect(renamed.cursor).toBe("2024-01-01T00:00:00Z");
  expect(renamed.seen).toEqual(["a", "b"]);
  const repointed = saveWatcher(
    draft({
      source: { ...JIRA_SOURCE, filter: { ...JIRA_SOURCE.filter, project: "OPS" } },
    }),
    watcher!.id,
  ).watcher!;
  expect(repointed.cursor).toBeUndefined();
  expect(repointed.seen).toEqual([]);
});

it("removing a watcher clears its emitted rows — nothing can resolve them later", () => {
  const { watcher } = saveWatcher(draft());
  const other = saveWatcher(draft({ name: "Other" })).watcher!;
  for (const id of [watcher!.id, other.id]) {
    emitAttention({
      key: `watcher:${id}:cond`,
      kind: "ticket",
      title: `Row ${id}`,
      urgency: 1,
      at: Date.now(),
      signature: "sig",
      source: { kind: "watcher", id },
    });
  }
  removeWatcher(watcher!.id);
  expect(emittedAttention().map((row) => row.key)).toEqual([
    `watcher:${other.id}:cond`,
  ]);
});

it("re-pointing a watcher clears rows bound to the old source", () => {
  const { watcher } = saveWatcher(draft());
  emitAttention({
    key: `watcher:${watcher!.id}:old`,
    kind: "ticket",
    title: "Old row",
    urgency: 1,
    at: Date.now(),
    signature: "sig",
    source: { kind: "watcher", id: watcher!.id },
  });
  saveWatcher(
    draft({
      source: { ...JIRA_SOURCE, filter: { ...JIRA_SOURCE.filter, project: "OPS" } },
    }),
    watcher!.id,
  );
  expect(emittedAttention()).toEqual([]);
});

it("pause clears backoff and resume polls promptly", () => {
  const { watcher } = saveWatcher(draft());
  updateWatcher(watcher!.id, (row) => ({
    ...row,
    failures: 4,
    nextPollAt: Date.now() + 600_000,
  }));
  setWatcherEnabled(watcher!.id, false);
  expect(loadWatchers()[0].enabled).toBe(false);
  setWatcherEnabled(watcher!.id, true);
  const resumed = loadWatchers()[0];
  expect(resumed.failures).toBe(0);
  expect(resumed.nextPollAt).toBe(0);
});

it("updateWatcher bounds the seen ring and history", () => {
  const { watcher } = saveWatcher(draft());
  updateWatcher(watcher!.id, (row) => ({
    ...row,
    seen: Array.from({ length: MAX_WATCHER_SEEN + 50 }, (_, i) => `k${i}`),
    history: Array.from({ length: 40 }, (_, i) => ({
      at: i,
      kind: "event" as const,
      text: `event ${i}`,
    })),
  }));
  const saved = loadWatchers()[0];
  expect(saved.seen.length).toBe(MAX_WATCHER_SEEN);
  expect(saved.seen[0]).toBe("k50"); // oldest evicted
  expect(saved.history.length).toBe(20);
});

it("malformed persisted watchers are dropped", () => {
  localStorage.setItem(
    "monocode.watchers.v1",
    JSON.stringify([
      { id: "", name: "", source: null },
      {
        id: "w1",
        name: "ok",
        source: JIRA_SOURCE,
        intervalSec: 1, // below the floor — clamped
        seen: "not-an-array",
      },
    ]),
  );
  const watchers = loadWatchers();
  expect(watchers).toHaveLength(1);
  expect(watchers[0].intervalSec).toBe(60);
  expect(watchers[0].seen).toEqual([]);
});

it("poll key shares fetches only across identical bindings", () => {
  const base: Watcher = saveWatcher(draft()).watcher!;
  const same = saveWatcher(draft({ name: "Second" })).watcher!;
  expect(watcherPollKey(base)).toBe(watcherPollKey(same));
  const prSource: WatcherSource = {
    kind: "github-pr",
    cwd: "/repo",
    repo: "acme/app",
    number: 4,
  };
  const a = saveWatcher(draft({ source: prSource })).watcher!;
  const b = saveWatcher(
    draft({ source: { ...prSource, sessionId: "s1" } }),
  ).watcher!;
  expect(watcherPollKey(a)).not.toBe(watcherPollKey(b));
});

describe("produced-delivery auto watchers", () => {
  const GH_PR: WatcherSource = {
    kind: "github-pr",
    cwd: "/repo",
    repo: "acme/app",
    number: 9,
    sessionId: "s1",
  };
  const AZURE_TARGET = {
    site: "https://dev.azure.com/team",
    accountId: "a",
    project: "p",
    repository: "r",
    number: 7,
  };
  const AZURE_PR: WatcherSource = {
    kind: "azure-pr",
    target: AZURE_TARGET,
    projectName: "P",
    repositoryName: "R",
    cwd: "/repo",
    branch: "feat",
    sessionId: "s1",
  };
  const CI_TARGET = {
    site: "https://dev.azure.com/team",
    accountId: "a",
    project: "p",
    definition: 5,
    repositoryId: "r",
    repositoryType: "TfsGit",
    repositoryUrl: "https://dev.azure.com/team/p/_git/r",
  };
  const CI: WatcherSource = {
    kind: "azure-ci",
    target: CI_TARGET,
    definitionName: "Tests",
    remote: CI_TARGET.repositoryUrl,
    cwd: "/repo",
    branch: "feat",
    sessionId: "s1",
  };
  it("registers a notify watcher marked auto for each delivery kind", () => {
    for (const source of [GH_PR, AZURE_PR, CI]) ensureDeliveryWatcher(source);
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(3);
    for (const watcher of watchers) {
      expect(watcher.auto).toBe(true);
      expect(watcher.mode).toBe("notify");
      expect(watcher.enabled).toBe(true);
    }
    expect(watchers[0].source).toEqual(GH_PR);
    expect(watchers[1].source).toEqual(AZURE_PR);
    expect(watchers[2].source).toEqual(CI);
  });

  it("dedupes a re-save and a hand-made watcher for the same delivery", () => {
    ensureDeliveryWatcher(GH_PR);
    ensureDeliveryWatcher({ ...GH_PR, sessionId: "other" });
    expect(loadWatchers()).toHaveLength(1);
    // A manually created watcher for the same PR blocks the auto one.
    localStorage.clear();
    saveWatcher(draft({ source: GH_PR }));
    ensureDeliveryWatcher(GH_PR);
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].auto).toBeUndefined();
    // And a paused auto watcher is not duplicated either.
    localStorage.clear();
    ensureDeliveryWatcher(GH_PR);
    setWatcherEnabled(loadWatchers()[0].id, false);
    ensureDeliveryWatcher(GH_PR);
    expect(loadWatchers()).toHaveLength(1);
  });

  it("parses a created GitHub PR URL into a watcher and ignores issues", () => {
    watchGithubPrUrl("/repo", "https://github.com/Acme/App/pull/42", "s1");
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source).toEqual({
      kind: "github-pr",
      cwd: "/repo",
      repo: "Acme/App",
      number: 42,
      sessionId: "s1",
    });
    watchGithubPrUrl("/repo", "https://github.com/acme/app/issues/42");
    expect(loadWatchers()).toHaveLength(1);
  });

  it("lifts auto watchers bound to a gone task scope, sparing hand-made and unrelated ones", () => {
    ensureDeliveryWatcher(GH_PR); // session s1, cwd /repo
    ensureDeliveryWatcher({ ...GH_PR, sessionId: "s2", cwd: "/other" });
    saveWatcher(draft({ source: GH_PR, name: "Manual" }));
    unwatchDeliveryScope({ sessionIds: ["s1"], cwds: [] });
    let watchers = loadWatchers();
    expect(watchers).toHaveLength(2); // manual /repo + auto /other
    expect(watchers.map((watcher) => watcher.name)).toContain("Manual");
    unwatchDeliveryScope({ cwds: ["/other"] });
    watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].name).toBe("Manual");
  });

  it("unwatchAzurePrDelivery lifts the delivery at that checkout+branch, any session", () => {
    ensureDeliveryWatcher(AZURE_PR);
    ensureDeliveryWatcher({ ...AZURE_PR, sessionId: undefined, branch: "main" });
    expect(loadWatchers()).toHaveLength(2);
    unwatchAzurePrDelivery(AZURE_TARGET, "/repo", "feat");
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source).toMatchObject({ branch: "main" });
    // Callers gate on stored-link coverage — a leftover watcher under another
    // branch or checkout is untouched.
    unwatchAzurePrDelivery(AZURE_TARGET, "/repo", "main");
    expect(loadWatchers()).toHaveLength(0);
  });

  it("ignores azure sources without a branch — detached checkouts link but don't watch", () => {
    ensureDeliveryWatcher({ ...AZURE_PR, branch: "" });
    ensureDeliveryWatcher({ ...CI, branch: "" });
    expect(loadWatchers()).toHaveLength(0);
  });

  it("scope teardown keeps a watcher still linked elsewhere and rebinds its owner", () => {
    ensureDeliveryWatcher(AZURE_PR); // bound s1
    const watcher = loadWatchers()[0];
    updateWatcher(watcher.id, (row) => ({
      ...row,
      cursor: "c1",
      seen: ["k1"],
    }));
    unwatchDeliveryScope({ sessionIds: ["s1"] }, () => ({
      sessionId: "s2",
    }));
    const kept = loadWatchers();
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(watcher.id);
    // Same watcher, watermark included — only the dead owner was rebound.
    expect(kept[0].source).toMatchObject({ sessionId: "s2" });
    expect(kept[0].seen).toEqual(["k1"]);
    expect(kept[0].cursor).toBe("c1");
    // No surviving link → lifted.
    unwatchDeliveryScope({ sessionIds: ["s2"] }, () => false);
    expect(loadWatchers()).toHaveLength(0);
  });

  it("scope teardown without a coverage predicate lifts every bound auto watcher", () => {
    ensureDeliveryWatcher(AZURE_PR);
    unwatchDeliveryScope({ sessionIds: ["s1"] });
    expect(loadWatchers()).toHaveLength(0);
  });

  it("openWatchSheet edits the watcher already covering a delivery", () => {
    ensureDeliveryWatcher(AZURE_PR);
    const watcher = loadWatchers()[0];
    const requests: WatchSheetRequest[] = [];
    const listener = (event: Event) =>
      requests.push((event as CustomEvent<WatchSheetRequest>).detail);
    window.addEventListener(OPEN_WATCH_SHEET, listener);
    try {
      // Same delivery, another session — still the same watcher.
      openWatchSheet({
        source: { ...AZURE_PR, sessionId: "s9" },
        name: "Watch reviews",
      });
      expect(requests[0].existing?.id).toBe(watcher.id);
      // Non-delivery sources never dedupe this way.
      openWatchSheet({ source: JIRA_SOURCE, name: "Jira" });
      expect(requests[1].existing).toBeUndefined();
      // A different delivery doesn't attach it either.
      openWatchSheet({
        source: { ...AZURE_PR, branch: "main" },
        name: "Other",
      });
      expect(requests[2].existing).toBeUndefined();
    } finally {
      window.removeEventListener(OPEN_WATCH_SHEET, listener);
    }
  });

  it("deliveryWatcherFor finds manual and auto watchers alike", () => {
    expect(deliveryWatcherFor(AZURE_PR)).toBeUndefined();
    saveWatcher(draft({ source: AZURE_PR }));
    expect(deliveryWatcherFor(AZURE_PR)?.name).toBe("Jira · ENG");
    expect(deliveryWatcherFor(JIRA_SOURCE)).toBeUndefined();
  });
});
