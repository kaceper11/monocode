import { describe, expect, it } from "vitest";
import type { LinkedWorkItem } from "./session";
import type { InboxItem } from "./githubTasks";
import type { SessionSummary } from "./sessionStore";
import {
  linkedSessionUpdateIds,
  linkedSessionUpdates,
  linkedWorkItemTargets,
  linkedWorkItemUpdateKey,
} from "./linkedSessionUpdates";

const linked: LinkedWorkItem = {
  kind: "pr",
  repo: "Acme/App",
  number: 42,
  url: "https://github.com/Acme/App/pull/42",
};

function remote(updatedAt: number, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...linked,
    provider: "github",
    projectPath: "",
    title: "Update sidebar activity",
    state: "open",
    updatedAt: new Date(updatedAt).toISOString(),
    labels: [],
    assignees: [],
    draft: false,
    ...overrides,
  };
}

function session(
  id: string,
  updatedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    cwd: "/tmp/app",
    harness: "codex",
    model: "gpt-5",
    runtimeMode: "supervised",
    title: `codex · ${id}`,
    createdAt: 1,
    updatedAt,
    linkedWorkItem: linked,
    ...overrides,
  };
}

describe("linked session updates", () => {
  it("marks a session when its linked item changed after the local session", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    expect([
      ...linkedSessionUpdateIds([session("old", 100)], snapshots),
    ]).toEqual(["old"]);
  });

  it("clears naturally once the session advances past the remote update", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    expect(
      linkedSessionUpdateIds([session("continued", 201)], snapshots).size,
    ).toBe(0);
  });

  it("tracks related sessions independently and ignores archived sessions", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    const ids = linkedSessionUpdateIds(
      [
        session("stale", 100),
        session("current", 250),
        session("archived", 100, { archived: true }),
        session("unlinked", 100, { linkedWorkItem: undefined }),
      ],
      snapshots,
    );
    expect([...ids]).toEqual(["stale"]);
  });

  it("normalizes repository case and deduplicates lookup targets", () => {
    const lower = { ...linked, repo: "acme/app" };
    const snapshots = new Map([[linkedWorkItemUpdateKey(lower), remote(200)]]);
    expect(
      linkedSessionUpdateIds([session("same", 100)], snapshots).has("same"),
    ).toBe(true);
    expect(
      linkedWorkItemTargets([
        session("first", 100),
        session("second", 150, { linkedWorkItem: lower }),
      ]),
    ).toHaveLength(1);
  });

  it("flags a session when a secondary linked item changes", () => {
    const secondary: LinkedWorkItem = {
      provider: "jira",
      account: "original-account",
      kind: "issue",
      repo: "",
      number: 123,
      url: "https://acme.atlassian.net/browse/PROJ-123",
      identifier: "PROJ-123",
      site: "https://acme.atlassian.net",
      id: "10042",
    };
    const snapshots = new Map([
      [
        linkedWorkItemUpdateKey(secondary),
        remote(200, {
          provider: "jira",
          account: "original-account",
          kind: "jira",
          repo: "",
          url: secondary.url,
          identifier: "PROJ-123",
          id: "10042",
          site: secondary.site,
        }),
      ],
    ]);
    const target = session("multi", 100, {
      linkedWorkItem: { ...linked, additionalItems: [secondary] },
    });
    const updates = linkedSessionUpdates([target], snapshots);
    expect(updates.get("multi")?.item.provider).toBe("jira");
  });

  it("reports the most recently updated link when several changed", () => {
    const other: LinkedWorkItem = {
      kind: "issue",
      repo: "Acme/App",
      number: 9,
      url: "https://github.com/Acme/App/issues/9",
    };
    const snapshots = new Map([
      [linkedWorkItemUpdateKey(linked), remote(200)],
      [
        linkedWorkItemUpdateKey(other),
        remote(300, { kind: "issue", number: 9, url: other.url }),
      ],
    ]);
    const target = session("multi", 100, {
      linkedWorkItem: { ...linked, additionalItems: [other] },
    });
    expect(linkedSessionUpdates([target], snapshots).get("multi")?.updatedAt)
      .toBe(300);
  });

  it("uses the acknowledged snapshot as the next activity baseline", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    expect(
      linkedSessionUpdateIds([session("read", 100)], snapshots, () => 200).size,
    ).toBe(0);
    expect(
      linkedSessionUpdateIds([session("newer", 100)], snapshots, () => 150).has(
        "newer",
      ),
    ).toBe(true);
  });
});

describe("provider-aware update keys", () => {
  const jiraLinked: LinkedWorkItem = {
    provider: "jira",
    account: "original-account",
    kind: "issue",
    repo: "",
    number: 123,
    url: "https://acme.atlassian.net/browse/PROJ-123",
    identifier: "PROJ-123",
    site: "https://acme.atlassian.net",
    id: "10042",
  };

  it("keys non-GitHub items by provider and URL, not colliding numbers", () => {
    const other = { ...jiraLinked, identifier: "OTHER-123", url: "https://acme.atlassian.net/browse/OTHER-123" };
    expect(linkedWorkItemUpdateKey(jiraLinked)).not.toBe(
      linkedWorkItemUpdateKey(other),
    );
    const gitlabLinked: LinkedWorkItem = {
      provider: "gitlab",
      kind: "issue",
      repo: "group/app",
      number: 123,
      url: "https://gitlab.example.com/group/app/-/issues/123",
    };
    // Same kind/number as the GitHub link — different providers, different keys.
    expect(linkedWorkItemUpdateKey(gitlabLinked)).not.toBe(
      linkedWorkItemUpdateKey({ ...linked, number: 123 }),
    );
  });

  it("scopes identical links by account", () => {
    const scoped: LinkedWorkItem = { ...jiraLinked, account: "work-account" };
    expect(linkedWorkItemUpdateKey(jiraLinked)).not.toBe(
      linkedWorkItemUpdateKey(scoped),
    );
    expect(
      linkedWorkItemTargets([
        session("a", 100, { linkedWorkItem: jiraLinked }),
        session("b", 100, { linkedWorkItem: scoped }),
      ]),
    ).toHaveLength(2);
  });

  it("matches a Jira snapshot stored under its own key", () => {
    const item = remote(200, {
      provider: "jira",
      account: "original-account",
      kind: "jira",
      repo: "",
      url: jiraLinked.url,
      identifier: "PROJ-123",
      id: "10042",
      site: jiraLinked.site,
    });
    const snapshots = new Map([[linkedWorkItemUpdateKey(jiraLinked), item]]);
    expect(
      linkedSessionUpdateIds(
        [session("jira", 100, { linkedWorkItem: jiraLinked })],
        snapshots,
      ).has("jira"),
    ).toBe(true);
  });
});


it.each(["jira", "azure"] as const)("ignores unbound legacy %s targets and any old unscoped activity cache", provider => {
  const legacy = { ...linked, provider, account: undefined };
  const saved = session("legacy", 100, { linkedWorkItem: legacy });
  const snapshots = new Map([[linkedWorkItemUpdateKey(legacy), remote(200, { provider, account: "current-account" })]]);
  expect(linkedWorkItemTargets([saved])).toEqual([]);
  expect(linkedSessionUpdates([saved], snapshots).size).toBe(0);
});
