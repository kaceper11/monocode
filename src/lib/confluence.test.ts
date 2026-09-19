// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  confluenceMarkdown,
  confluencePageContext,
  confluenceSections,
  type ConfluencePage,
} from "./confluence";
import { MAX_CONTEXT_TEXT } from "./agentContext";

const site = "https://team.atlassian.net";

const page = (storage: string, extra: Partial<ConfluencePage> = {}): ConfluencePage => ({
  id: "123456",
  title: "Rollout plan",
  spaceKey: "ENG",
  spaceName: "Engineering",
  version: 7,
  url: `${site}/wiki/spaces/ENG/pages/123456`,
  storage,
  ...extra,
});

describe("confluenceMarkdown", () => {
  it("converts headings, lists, and code macros to readable markdown", () => {
    const storage = [
      "<h2>Overview</h2>",
      "<p>Ship <strong>phase&nbsp;one</strong></p>",
      "<ul><li>Alpha</li><li>Beta</li></ul>",
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>',
    ].join("");
    const { text, truncated } = confluenceMarkdown(storage);
    expect(truncated).toBe(false);
    expect(text).toContain("## Overview");
    expect(text).toContain("**phase");
    expect(text).toContain("- Alpha");
    expect(text).toContain("const x = 1;");
  });

  it("drops executable markup and unsafe links", () => {
    const storage = [
      "<p>Hi</p><script>exfiltrate()</script><style>body{}</style>",
      '<iframe src="https://tracker.test/x"></iframe>',
      '<a href="javascript:alert(1)">click</a>',
      '<a href="https://safe.test/page">safe</a>',
    ].join("");
    const { text } = confluenceMarkdown(storage);
    expect(text).toContain("Hi");
    for (const unsafe of ["exfiltrate", "tracker.test", "javascript:", "alert(1)"])
      expect(text).not.toContain(unsafe);
    expect(text).toContain("[safe](https://safe.test/page)");
  });

  it("reduces macros to readable bodies and marks large pages truncated", () => {
    const note =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Heads up</p></ac:rich-text-body></ac:structured-macro>';
    const { text } = confluenceMarkdown(note);
    expect(text).toContain("Heads up");
    expect(confluenceMarkdown(`<p>${"a".repeat(300_000)}</p>`).truncated).toBe(
      true,
    );
  });

  it("reads namespaced ri: attributes on links, pages, attachments and users", () => {
    const storage = [
      '<ac:link><ri:url ri:value="https://docs.test/guide" /><ac:link-body>Guide</ac:link-body></ac:link>',
      '<ac:link><ri:page ri:content-title="Runbook" /></ac:link>',
      '<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>',
      '<ri:user ri:userkey="ada" />',
    ].join("");
    const { text } = confluenceMarkdown(storage);
    expect(text).toContain("[Guide](https://docs.test/guide)");
    expect(text).toContain("[Page: Runbook]");
    expect(text).toContain("[Image: diagram.png]");
    expect(text).toContain("@ada");
  });

  it("keeps CDATA code containing > intact and reads task status elements", () => {
    const storage = [
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[if (a > b) { f(); }]]></ac:plain-text-body></ac:structured-macro>',
      '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><span>Done thing</span></ac:task-body></ac:task></ac:task-list>',
    ].join("");
    const { text } = confluenceMarkdown(storage);
    expect(text).toContain("if (a > b) { f(); }");
    expect(text).toContain("- [x] Done thing");
  });
});

describe("confluenceSections", () => {
  it("splits markdown into heading-bounded sections without child duplication", () => {
    const markdown = [
      "# Intro",
      "",
      "Intro body",
      "",
      "## Detail",
      "",
      "Detail body",
      "",
      "### Sub",
      "",
      "Sub body",
      "",
      "# Other",
      "",
      "Other body",
    ].join("\n");
    const sections = confluenceSections(markdown);
    expect(sections.map((section) => section.title)).toEqual([
      "Intro",
      "Detail",
      "Sub",
      "Other",
    ]);
    expect(sections[1].text).toBe("Detail body");
    expect(sections[1].level).toBe(2);
    expect(sections[2].level).toBe(3);
  });

  it("ignores #-lines inside fenced code blocks", () => {
    const markdown = [
      "# Real",
      "",
      "```",
      "# just a comment",
      "## also not a heading",
      "```",
      "",
      "tail",
    ].join("\n");
    const sections = confluenceSections(markdown);
    expect(sections.map((section) => section.title)).toEqual(["Real"]);
    expect(sections[0].text).toContain("# just a comment");
  });

  it("only closes a fence on the same marker that opened it", () => {
    const markdown = [
      "# Real",
      "",
      "```",
      "~~~",
      "# still code",
      "```",
      "",
      "# After",
    ].join("\n");
    const sections = confluenceSections(markdown);
    expect(sections.map((section) => section.title)).toEqual([
      "Real",
      "After",
    ]);
    expect(sections[0].text).toContain("# still code");
  });

  it("escapes tildes so page text cannot inject a fence", () => {
    const { text } = confluenceMarkdown("<p>~~~</p><p># fake</p>");
    expect(text).toContain("\\~\\~\\~");
    expect(text).toContain("\\# fake");
    expect(confluenceSections(text).map((s) => s.title)).toEqual([]);
  });

  it("strips private-use markers from provider text", () => {
    const { text } = confluenceMarkdown("<p>before\uE000after\uE001</p>");
    expect(text).toBe("beforeafter");
  });

  it("does not let a self-closing ri:url swallow following siblings", () => {
    const { text } = confluenceMarkdown(
      '<p><ri:url ri:value="https://docs.test/guide"/><ac:emoticon ac:name="tick"/></p><p>tail</p>',
    );
    expect(text).toContain("[docs.test](https://docs.test/guide)");
    expect(text).toContain("tail");
  });
});

describe("confluencePageContext", () => {
  it("records site/space/page/version/URL provenance per entry", () => {
    const context = confluencePageContext({ site, accountId: "email:ada@example.test" }, [
      { page: page("<p>Body</p>"), sections: null },
    ]);
    const entry = context.entries[0];
    expect(entry.title).toBe("ENG: Rollout plan");
    for (const part of [
      site,
      "email:ada@example.test",
      "space ENG",
      "page 123456",
      "v7",
      page("").url,
    ])
      expect(entry.origin).toContain(part);
    expect(entry.text).toContain("Body");
    expect(entry.truncated).toBe(false);
  });

  it("keeps only selected sections and notes the section count", () => {
    const context = confluencePageContext({ site, accountId: "email:ada@example.test" }, [
      {
        page: page("<h2>Keep</h2><p>Keep body</p><h2>Skip</h2><p>Skip body</p>"),
        sections: ["s0"],
      },
    ]);
    const entry = context.entries[0];
    expect(entry.origin).toContain("1 section");
    expect(entry.text).toContain("Keep body");
    expect(entry.text).not.toContain("Skip body");
  });

  it("bounds entry text and marks truncation", () => {
    const context = confluencePageContext({ site, accountId: "email:ada@example.test" }, [
      { page: page(`<p>${"x".repeat(MAX_CONTEXT_TEXT + 100)}</p>`), sections: null },
    ]);
    const entry = context.entries[0];
    expect(entry.truncated).toBe(true);
    expect(entry.text.length).toBeLessThanOrEqual(MAX_CONTEXT_TEXT);
  });
});


it("does not silently clip a selected section before the shared context budget", () => {
  const context = confluencePageContext({ site, accountId: "email:ada@example.test" }, [
    { page: page(`<h2>Long</h2><p>${"x".repeat(20_000)}</p>`), sections: ["s0"] },
  ]);
  expect(context.entries[0].text).toContain("x".repeat(20_000));
  expect(context.entries[0].truncated).toBe(false);
  expect(confluenceMarkdown(`<pre>${"x".repeat(33_000)}</pre>`).truncated).toBe(true);
  expect(() => confluencePageContext({ site, accountId: "a" }, [{ page: page("<p>No sections</p>"), sections: ["s0"] }])).toThrow("sections changed");
});
