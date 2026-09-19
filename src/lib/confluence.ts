import type { JiraStatus } from "./jira";
import { invoke } from "@tauri-apps/api/core";
import { boundAgentContext, MAX_CONTEXT_TEXT, type AgentContext } from "./agentContext";

type ConfluenceConnection = Pick<JiraStatus, "site" | "accountId">;

export type ConfluenceSpace = { key: string; name: string };

export type ConfluencePageSummary = {
  id: string;
  title: string;
  spaceKey: string;
  spaceName: string;
  version: number;
  url: string;
};

export type ConfluencePage = ConfluencePageSummary & {
  /** Storage-format XHTML — untrusted provider content, render only. */
  storage: string;
};

export type ConfluenceSection = {
  id: string;
  title: string;
  level: number;
  /** Markdown text for this section, without its child sections. */
  text: string;
};

export function confluenceSpaces(connection: ConfluenceConnection): Promise<ConfluenceSpace[]> {
  return invoke<{ spaces?: ConfluenceSpace[] }>("confluence_spaces", {
    ...connection,
  }).then((result) => (result.spaces ?? []).slice(0, 100));
}

export function confluenceSearch(
  connection: ConfluenceConnection,
  query: { text: string; space: string; cursor?: string; cursorParam?: string },
): Promise<{ results: ConfluencePageSummary[]; next: string; nextParam: string }> {
  return invoke<{ results?: unknown[]; next?: string; nextParam?: string }>(
    "confluence_search",
    {
      ...connection,
      query: query.text,
      space: query.space,
      cursor: query.cursor ?? "",
      cursorParam: query.cursorParam ?? "",
    },
  ).then((result) => ({
    results: (result.results ?? [])
      .slice(0, 25)
      .flatMap((row) => {
        const page = pageSummary(connection.site, row);
        return page ? [page] : [];
      }),
    next: typeof result.next === "string" ? result.next : "",
    nextParam: typeof result.nextParam === "string" ? result.nextParam : "",
  }));
}

export function confluencePage(connection: ConfluenceConnection, id: string): Promise<ConfluencePage | null> {
  return invoke<unknown>("confluence_page", { ...connection, id }).then((raw) => {
    const page = pageSummary(connection.site, raw);
    if (!page || page.id !== id) return null;
    const storage =
      raw && typeof raw === "object"
        ? (raw as { body?: { storage?: { value?: unknown } } }).body?.storage
            ?.value
        : "";
    return { ...page, storage: typeof storage === "string" ? storage : "" };
  });
}

type RawPage = {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  space?: { key?: unknown; name?: unknown };
  version?: { number?: unknown };
  _links?: { webui?: unknown };
};

function pageSummary(site: string, raw: unknown): ConfluencePageSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as RawPage;
  if (row.status && row.status !== "current") return null;
  const id = typeof row.id === "string" && /^\d{1,30}$/.test(row.id) ? row.id : "";
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (!id || !title) return null;
  const webui =
    typeof row._links?.webui === "string" ? row._links.webui : "";
  return {
    id,
    title,
    spaceKey:
      typeof row.space?.key === "string" ? row.space.key : "",
    spaceName:
      typeof row.space?.name === "string" ? row.space.name : "",
    version:
      typeof row.version?.number === "number" && row.version.number > 0
        ? row.version.number
        : 0,
    url: webui ? `${site}/wiki${webui}` : "",
  };
}

const MAX_STORAGE = 256_000;
const MAX_MARKDOWN = 64_000;

/**
 * Storage-format XHTML → bounded Markdown. The input is untrusted provider
 * content: parsed into an inert template, scripts/styles/frames dropped,
 * macros reduced to their readable bodies. Never attached to the document.
 */
export function confluenceMarkdown(storage: string): { text: string; truncated: boolean } {
  if (typeof storage !== "string" || !storage.trim()) {
    return { text: "", truncated: false };
  }
  const template = document.createElement("template");
  // HTML parsing ends a bogus <![CDATA[ comment at the first `>`, so lift
  // CDATA bodies into marker-delimited text before parsing.
  template.innerHTML = storage
    .slice(0, MAX_STORAGE)
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/g,
      (_match, text: string) =>
        `\uE000${text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}\uE001`,
    )
    // HTML ignores `/` on non-void tags — expand self-closing ac:/ri:
    // elements so they cannot swallow following siblings as children.
    .replace(
      /<(ac|ri):([A-Za-z-]+)((?:"[^"]*"|'[^']*'|[^>"'])*)\/>/g,
      "<$1:$2$3></$1:$2>",
    );
  let nodes = 0;
  let truncated = storage.length > MAX_STORAGE;
  const escape = (value: string) =>
    value.replace(/[\\`*_{}\[\]<>#|~+-]/g, "\\$&");
  const stripMarkers = (value: string) => value.replace(/[\uE000\uE001]/g, "");
  const attr = (node: Element, name: string) =>
    node.getAttribute(name) ??
    node.getAttribute(`ac:${name}`) ??
    node.getAttribute(`ri:${name}`) ??
    "";
  const find = (node: Element, tag: string): Element | undefined =>
    Array.from(node.getElementsByTagName("*")).find(
      (el) => el.tagName.toLowerCase() === tag,
    );
  // Only http(s) hrefs without embedded credentials are safe to keep.
  const safeHref = (value: string): string | null => {
    try {
      const url = new URL(value);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return null;
      return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
    } catch {
      return null;
    }
  };
  const render = (node: Node, depth: number): string => {
    if (++nodes > 10_000 || depth > 32) {
      truncated = true;
      return "";
    }
    if (node.nodeType === 3) return escape(stripMarkers(node.textContent ?? ""));
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    if (
      [
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "svg",
        "math",
        "template",
        "ac:parameter",
        "ri:body",
      ].includes(tag)
    )
      return "";
    if (tag === "ac:structured-macro") {
      const name = attr(node, "name") || attr(node, "macro-id");
      if (name === "code" || name === "noformat") {
        const plain = find(node, "ac:plain-text-body");
        const raw = stripMarkers(plain?.textContent ?? "");
        truncated ||= raw.length > 32_000;
        const code = raw.slice(0, 32_000);
        return `\`\`\`\n${code.replace(/```/g, "ˋˋˋ")}\n\`\`\`\n\n`;
      }
      if (name === "children" || name === "toc" || name === "pagetree")
        return "";
      // info/note/warning/panel/status and unknown macros keep their body text.
      const rich = find(node, "ac:rich-text-body");
      if (rich) {
        const inner = Array.from(rich.childNodes)
          .map((child) => render(child, depth + 1))
          .join("")
          .trim();
        return inner ? `> ${inner.replace(/\n/g, "\n> ")}\n\n` : "";
      }
      return "";
    }
    if (tag === "ac:plain-text-body") return "";
    if (tag === "ac:link") {
      const link = find(node, "ri:url");
      // ri:url is not void in HTML parsing — `<ri:url/>` swallows the
      // following ac:link-body as its own child, so find it anywhere inside.
      const linkBody = find(node, "ac:link-body");
      const body = linkBody
        ? Array.from(linkBody.childNodes)
            .map((child) => render(child, depth + 1))
            .join("")
        : Array.from(node.childNodes)
            .filter(
              (child) =>
                !(
                  child instanceof Element &&
                  child.tagName.toLowerCase() === "ri:url"
                ),
            )
            .map((child) => render(child, depth + 1))
            .join("");
      if (!link) return body;
      const href = safeHref(attr(link, "value"));
      if (!href) return body;
      return `[${body.trim() || escape(new URL(href).hostname)}](${href})`;
    }
    if (tag === "ac:link-body")
      return Array.from(node.childNodes)
        .map((child) => render(child, depth + 1))
        .join("");
    if (tag === "ac:image") {
      const attachment = find(node, "ri:attachment");
      const alt =
        (attachment ? attr(attachment, "filename") : "") ||
        attr(node, "alt") ||
        "attachment";
      return `[Image: ${escape(alt)}]`;
    }
    if (tag === "ri:page")
      return `[Page: ${escape(attr(node, "content-title") || "untitled")}]`;
    if (tag === "ri:url") {
      const href = safeHref(attr(node, "value"));
      return href ? `[${escape(new URL(href).hostname)}](${href})` : "";
    }
    if (tag === "ri:attachment") return `[Attachment: ${escape(attr(node, "filename") || "file")}]`;
    if (tag === "ri:user") return `@${escape(attr(node, "userkey") || "user")}`;
    if (tag === "ac:emoticon" || tag === "ac:placeholder") return "";
    if (tag === "ac:task") {
      const status =
        find(node, "ac:task-status")?.textContent?.trim() === "complete"
          ? "x"
          : " ";
      const taskBody = find(node, "ac:task-body");
      const body = taskBody
        ? Array.from(taskBody.childNodes)
            .map((child) => render(child, depth + 1))
            .join("")
            .trim()
        : "";
      return `- [${status}] ${body}\n`;
    }
    if (tag === "ac:task-body" || tag === "ac:task-id" || tag === "ac:task-status")
      return "";
    if (tag === "img")
      return `[Image: ${escape(node.getAttribute("alt") || "attachment")}]`;
    const body = Array.from(node.childNodes)
      .map((child) => render(child, depth + 1))
      .join("");
    if (tag === "br") return "\n";
    if (["p", "div", "section", "table", "tr", "ul", "ol", "ac:layout", "ac:layout-section", "ac:layout-cell", "ac:adf-content", "ac:task-list"].includes(tag))
      return `${body}\n\n`;
    if (tag === "li") return `- ${body.trim()}\n`;
    if (tag === "td" || tag === "th") return `${body.trim()} | `;
    if (["strong", "b"].includes(tag)) return `**${body}**`;
    if (["em", "i"].includes(tag)) return `_${body}_`;
    if (tag === "u" || tag === "span" || tag === "time") return body;
    if (tag === "pre" || tag === "code") {
      const text = stripMarkers(node.textContent ?? "");
      if (tag === "pre") {
        truncated ||= text.length > 32_000;
        return `\`\`\`\n${text.slice(0, 32_000).replace(/```/g, "ˋˋˋ")}\n\`\`\`\n\n`;
      }
      return `\`${text.replace(/`/g, "ˋ")}\``;
    }
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${body.trim()}\n\n`;
    if (tag === "a") {
      const href = safeHref(node.getAttribute("href") ?? "");
      if (href)
        return `[${body || escape(new URL(href).hostname)}](${href})`;
      return body;
    }
    if (tag === "blockquote") return `> ${body.trim().replace(/\n/g, "\n> ")}\n\n`;
    if (tag === "hr") return "\n---\n";
    return body;
  };
  const text = Array.from(template.content.childNodes)
    .map((node) => render(node, 0))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  truncated ||= text.length > MAX_MARKDOWN || nodes > 10_000;
  return { text: text.slice(0, MAX_MARKDOWN), truncated };
}

/**
 * Split converted Markdown into heading-bounded sections. Section text stays
 * inside the page's own bounds; callers cap selections through #8 limits.
 */
export function confluenceSections(markdown: string): ConfluenceSection[] {
  const sections: ConfluenceSection[] = [];
  const lines = markdown.split("\n");
  let current: { title: string; level: number; body: string[] } | null = null;
  let fenced: string | null = null;
  let index = 0;
  const flush = () => {
    if (!current) return;
    sections.push({
      id: `s${index++}`,
      title: current.title,
      level: current.level,
      text: current.body.join("\n").trim(),
    });
    current = null;
  };
  for (const line of lines) {
    // `#` lines inside fenced code are code, not headings. A fence only
    // closes on the same marker that opened it — `~~~` inside a ``` block
    // (or vice versa) is content.
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenced === null) fenced = fence[1][0];
      else if (fence[1][0] === fenced) fenced = null;
    }
    const heading = fenced ? null : /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      current = {
        title: heading[2].replace(/\\([\\`*_{}\[\]<>#|~+\-])/g, "$1").trim(),
        level: heading[1].length,
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return sections;
}

function pageOrigin(site: string, page: ConfluencePageSummary): string {
  return [
    "Confluence",
    site,
    page.spaceKey ? `space ${page.spaceKey}` : "",
    `page ${page.id}`,
    page.version ? `v${page.version}` : "",
    page.url,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Build bounded agent-context entries for selected pages/sections. */
export function confluencePageContext(
  connection: ConfluenceConnection,
  pages: readonly { page: ConfluencePage; sections: readonly string[] | null }[],
): AgentContext {
  const { site, accountId } = connection;
  const entries = pages.flatMap(({ page, sections }) => {
    const { text, truncated } = confluenceMarkdown(page.storage);
    const origin = `Account ${accountId} · ${pageOrigin(site, page)}`;
    if (!sections) {
      return [
        {
          id: `confluence:${site}:${accountId}:${page.id}`,
          title: page.spaceKey ? `${page.spaceKey}: ${page.title}` : page.title,
          origin,
          text,
          truncated,
        },
      ];
    }
    const picked = confluenceSections(text).filter((section) =>
      sections.includes(section.id),
    );
    if (picked.length !== new Set(sections).size)
      throw new Error("Selected Confluence sections changed. Preview and select them again.");
    const body = picked
      .map((section) => `${"#".repeat(section.level)} ${section.title}\n\n${section.text}`)
      .join("\n\n");
    return [
      {
        id: `confluence:${site}:${accountId}:${page.id}:sections`,
        title: page.spaceKey ? `${page.spaceKey}: ${page.title}` : page.title,
        origin: `${origin} · ${picked.length} ${picked.length === 1 ? "section" : "sections"}`,
        text: body.slice(0, MAX_CONTEXT_TEXT),
        truncated: truncated || body.length > MAX_CONTEXT_TEXT,
      },
    ];
  });
  return boundAgentContext({
    id: crypto.randomUUID(),
    entries,
    attachments: [],
  });
}
