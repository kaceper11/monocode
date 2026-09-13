import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "./session";
import {
  upsertSession,
  getSession,
  shouldPersistSession,
  isPersistableId,
  persistFingerprint,
  sanitizeSessionForPersist,
} from "./sessionStore";

describe("isPersistableId", () => {
  it("accepts alphanumeric ids with hyphens and underscores", () => {
    expect(isPersistableId("acp-session-1")).toBe(true);
    expect(isPersistableId("abc_123")).toBe(true);
  });

  it("rejects filesystem paths", () => {
    expect(isPersistableId("/Users/me/.pi/agent/sessions/abc.jsonl")).toBe(
      false,
    );
  });
});

describe("persisting a subagent's trail", () => {
  const withRun = (steps: Block["agentRun"]) => {
    const session = newSession("claude", "/tmp/project");
    session.blocks = [
      {
        id: "a1",
        role: "tool",
        text: "Correctness review",
        tool: { callId: "agent-1", kind: "agent", status: "completed" },
        agentRun: steps,
      },
    ];
    return sanitizeSessionForPersist(session)?.blocks[0].agentRun;
  };

  it("keeps the run so a reopened session can still be inspected", () => {
    expect(
      withRun({
        name: "Correctness review",
        agentType: "code-reviewer",
        steps: [
          {
            id: "s1",
            kind: "tool",
            text: "Read src/App.tsx",
            toolKind: "read",
            status: "completed",
          },
          { id: "s2", kind: "message", text: "Nothing to flag." },
        ],
      }),
    ).toEqual({
      name: "Correctness review",
      agentType: "code-reviewer",
      steps: [
        {
          id: "s1",
          kind: "tool",
          text: "Read src/App.tsx",
          toolKind: "read",
          status: "completed",
        },
        { id: "s2", kind: "message", text: "Nothing to flag." },
      ],
    });
  });

  it("drops steps a provider left malformed", () => {
    expect(
      withRun({
        name: "Correctness review",
        steps: [
          { id: "", kind: "tool", text: "Read" },
          { id: "s2", kind: "bogus", text: "Read" },
          { id: "s3", kind: "tool", text: "Read src/App.tsx" },
        ] as never,
      })?.steps,
    ).toEqual([{ id: "s3", kind: "tool", text: "Read src/App.tsx" }]);
  });

  it("keeps only the tail of a long run", () => {
    const steps = Array.from({ length: 260 }, (_, index) => ({
      id: `s${index}`,
      kind: "tool" as const,
      text: `Read file-${index}.ts`,
    }));
    const saved = withRun({ name: "Correctness review", steps });
    expect(saved?.steps).toHaveLength(100);
    expect(saved?.steps[99].id).toBe("s259");
  });
});

describe("sanitizeSessionForPersist", () => {
  it("persists model provenance recorded on a user turn", () => {
    const session = newSession("claude", "/tmp/project", "claude:opus-5");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "remember this",
        turnModel: {
          harness: "claude",
          id: "claude:opus-5",
          name: "Claude Opus 5",
        },
      },
    ];

    expect(sanitizeSessionForPersist(session).blocks[0]?.turnModel).toEqual({
      harness: "claude",
      id: "claude:opus-5",
      name: "Claude Opus 5",
    });
  });

  it("persists a canonical GitHub work-item identity", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [{ id: "u1", role: "user", text: "fix PR #42" }];
    session.linkedWorkItem = {
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      url: "https://example.com/not-trusted",
    };

    expect(sanitizeSessionForPersist(session).linkedWorkItem).toEqual({
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      url: "https://github.com/openai/codex/pull/42",
    });
  });

  it("omits a path-like provider session id so upsert can still snapshot git", () => {
    const session = newSession("pi", "/tmp/project");
    session.providerSessionId = "/Users/me/.pi/agent/sessions/abc.jsonl";
    session.blocks = [{ id: "u1", role: "user", text: "hey" }];

    expect(
      sanitizeSessionForPersist(session).providerSessionId,
    ).toBeUndefined();
  });

  it("keeps a UUID provider session id", () => {
    const session = newSession("pi", "/tmp/project");
    session.providerSessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    session.blocks = [{ id: "u1", role: "user", text: "hey" }];

    expect(sanitizeSessionForPersist(session).providerSessionId).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });

  it("keeps a handoff divider and settles a preparing one", () => {
    const session = newSession("cursor", "/tmp/project");
    session.blocks = [
      { id: "u1", role: "user", text: "hey" },
      {
        id: "h1",
        role: "handoff",
        text: "",
        handoff: { from: "cursor", to: "claude", status: "preparing" },
      },
    ];
    const persisted = sanitizeSessionForPersist(session);
    expect(persisted.blocks[1]).toMatchObject({
      role: "handoff",
      handoff: { from: "cursor", to: "claude", status: "ready", pending: true },
    });
  });

  it("keeps a second-opinion card on the user turn", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "Second opinion",
        secondOpinion: {
          from: "claude",
          to: "codex",
          request: "fix the footer",
          files: 2,
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[0]).toMatchObject({
      role: "user",
      text: "Second opinion",
      secondOpinion: {
        from: "claude",
        to: "codex",
        request: "fix the footer",
        files: 2,
      },
    });
  });

  it("keeps a handoff card kind on the user turn", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "Handoff",
        secondOpinion: {
          from: "claude",
          to: "codex",
          kind: "handoff",
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[0]).toMatchObject({
      role: "user",
      text: "Handoff",
      secondOpinion: { from: "claude", to: "codex", kind: "handoff" },
    });
  });

  it("keeps a note card on the user turn without the note body", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "hi",
        noteCard: {
          id: "n1",
          slug: "overview",
          title: "agent-os project overview",
          sourceCwd: "/tmp/project",
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[0]).toEqual({
      id: "u1",
      role: "user",
      text: "hi",
      noteCard: {
        id: "n1",
        slug: "overview",
        title: "agent-os project overview",
        sourceCwd: "/tmp/project",
      },
    });
  });

  it("keeps edited and approved plan metadata", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      { id: "u1", role: "user", text: "plan this" },
      {
        id: "p1",
        role: "plan",
        text: "# Edited plan",
        plan: {
          key: "turn:1",
          status: "built",
          originalText: "# Original plan",
          approvedText: "# Edited plan",
          edited: true,
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[1]).toMatchObject({
      role: "plan",
      text: "# Edited plan",
      plan: {
        key: "turn:1",
        status: "built",
        originalText: "# Original plan",
        approvedText: "# Edited plan",
        edited: true,
      },
    });
  });

  it("keeps the action run evidence on the user turn", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "Action: Review\n\nCheck the diff.",
        action: { actionId: "review", name: "Review", revision: "0a1b2c3d" },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[0]).toMatchObject({
      role: "user",
      action: { actionId: "review", name: "Review", revision: "0a1b2c3d" },
    });
  });

  it("drops malformed action evidence instead of persisting it", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "hi",
        action: { name: "Review" } as unknown as Block["action"],
      },
    ];
    expect(
      sanitizeSessionForPersist(session).blocks[0].action,
    ).toBeUndefined();
  });

  it("keeps structured task lists", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      { id: "u1", role: "user", text: "fix it" },
      {
        id: "tasks1",
        role: "tasks",
        text: "[x] Inspect\n[~] Implement",
        taskList: {
          key: "turn_1",
          explanation: "Inspection complete.",
          items: [
            { id: "1", text: "Inspect", status: "completed" },
            { id: "2", text: "Implement", status: "in_progress" },
          ],
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[1]).toEqual(
      session.blocks[1],
    );
  });
});

describe("persistFingerprint", () => {
  const user: Block = { id: "u1", role: "user", text: "hi" };
  const answer: Block = { id: "a1", role: "assistant", text: "done" };

  // One base session: `newSession` mints a fresh id, and the id is part of the
  // fingerprint, so variants have to be spread off a single session.
  const base = (blocks: Block[] = [user, answer]): Session => ({
    ...newSession("codex", "/tmp/project"),
    blocks,
  });

  it("is stable while nothing changes", () => {
    const session = base();
    expect(persistFingerprint(session)).toBe(persistFingerprint(session));
  });

  it("matches a copy holding the same blocks", () => {
    const session = base();
    expect(persistFingerprint({ ...session })).toBe(
      persistFingerprint(session),
    );
  });

  it("changes when a block in the middle is replaced", () => {
    const tool: Block = {
      id: "t1",
      role: "tool",
      text: "run",
      tool: { status: "running" },
    };
    const before = base([user, tool, answer]);
    const after = {
      ...before,
      blocks: [user, { ...tool, tool: { status: "completed" } }, answer],
    };
    expect(persistFingerprint(after)).not.toBe(persistFingerprint(before));
  });

  it("changes when an approval is decided", () => {
    const approval: Block = {
      id: "p1",
      role: "approval",
      text: "allow?",
      approval: { requestId: 1 },
    };
    const before = base([user, approval]);
    const after = {
      ...before,
      blocks: [
        user,
        { ...approval, approval: { requestId: 1, decided: "allow" as const } },
      ],
    };
    expect(persistFingerprint(after)).not.toBe(persistFingerprint(before));
  });

  it("changes when a block is appended", () => {
    const before = base([user]);
    expect(persistFingerprint({ ...before, blocks: [user, answer] })).not.toBe(
      persistFingerprint(before),
    );
  });

  it("changes when a persisted field changes", () => {
    const before = base();
    expect(persistFingerprint({ ...before, title: "Renamed" })).not.toBe(
      persistFingerprint(before),
    );
  });

  it("ignores state that is never written", () => {
    const before = base();
    expect(persistFingerprint({ ...before, busy: true })).toBe(
      persistFingerprint(before),
    );
  });

  it("treats a path-like provider session id as absent", () => {
    const session = base();
    expect(
      persistFingerprint({
        ...session,
        providerSessionId: "/Users/me/.pi/agent/sessions/abc.jsonl",
      }),
    ).toBe(persistFingerprint(session));
  });

  it("matches persist for a zero context window", () => {
    const session = base();
    expect(
      persistFingerprint({ ...session, context: { used: 10, window: 0 } }),
    ).toBe(persistFingerprint({ ...session, context: { used: 10 } }));
  });
});

it("retains every explicit ticket link without requiring an initial prompt", () => {
  const session = newSession("codex", "/tmp/project");
  session.linkedWorkItem = { kind: "issue", repo: "a/b", number: 8, url: "https://github.com/a/b/issues/8", additionalItems: [{ kind: "issue", repo: "a/b", number: 13, url: "https://github.com/a/b/issues/13" }] };
  expect(shouldPersistSession(session)).toBe(true);
  expect(sanitizeSessionForPersist(session).linkedWorkItem).toEqual(session.linkedWorkItem);
  expect(sanitizeSessionForPersist(session).blocks).toEqual([]);
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
it("can clear the last persisted ticket without manufacturing a user message", async () => {
  const session = newSession("codex", "/tmp/project");
  vi.mocked(invoke).mockResolvedValue(null);
  await upsertSession(session);
  expect(invoke).not.toHaveBeenCalled();
  await upsertSession(session, { allowEmpty: true });
  expect(invoke).toHaveBeenCalledWith("session_upsert", { session: expect.objectContaining({ id: session.id, blocks: [] }) });
  expect((vi.mocked(invoke).mock.calls[0][1] as { session: object }).session).not.toHaveProperty("linkedWorkItem");
});


it("restores saved issue descriptions and legacy links when reopening a conversation", async () => {
  const session = newSession("codex", "/tmp/project");
  session.linkedWorkItem = { kind: "issue", repo: "a/b", number: 8, url: "https://github.com/a/b/issues/8", title: "Saved issue", context: "Original description", additionalItems: [{ provider: "jira", account: "alice", kind: "issue", repo: "ENG", number: 13, url: "https://team.atlassian.net/browse/ENG-13", identifier: "ENG-13", title: "Second issue", context: "Jira description" }, { kind: "issue", repo: "a/b", number: 1, url: "https://github.com/a/b/issues/1" }] };
  const record = sanitizeSessionForPersist(session);
  vi.mocked(invoke).mockResolvedValueOnce(record);
  const restored = await getSession(session.id);
  expect(restored?.linkedWorkItem).toEqual(session.linkedWorkItem);
  expect(restored?.contextDraft).toBeUndefined();
});
