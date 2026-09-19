import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { expect, it } from "vitest";

// Exercise the exact native initialization script, not a copied JS substitute.
const native = readFileSync(new URL("../../src-tauri/src/browser.rs", import.meta.url), "utf8");
const script = native.match(/const PAGE_TAP_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!script) throw new Error("Browser initialization script not found");

it("does not revive a stored recording flag and preserves a trail only on explicit resume", async () => {
  const page = new Window({ url: "https://example.test/new?token=secret" });
  try {
    page.sessionStorage.setItem("monocode.rec", "1");
    page.sessionStorage.setItem("monocode.trail", JSON.stringify([{ at: 1, text: "Previous step" }]));
    page.document.body.innerHTML = '<button>Review</button>';
    page.eval(script);
    const trail = () => page.eval("window.__monocodeTrail") as { text: string }[];
    expect(page.eval("window.__monocodeRec")).toBe(false);
    page.document.querySelector("button")!.click();
    expect(trail().map(step => step.text)).toEqual(["Previous step"]);
    page.eval("window.__monocodeSetRec(true, true)");
    expect(trail()[0].text).toBe("Previous step");
    expect(trail()[1].text).toContain("Opened https://example.test/new");
    expect(trail().at(-1)!.text).toBe('Clicked button "Review"');
    expect(JSON.stringify(trail())).not.toContain("secret");
    page.document.querySelector("button")!.click();
    const beforeHide = trail().length;
    page.dispatchEvent(new page.Event("pagehide"));
    expect(page.eval("window.__monocodeRec")).toBe(false);
    page.document.querySelector("button")!.click();
    expect(trail()).toHaveLength(beforeHide);
    page.eval("window.__monocodeSetRec(true, false)");
    expect(trail()).toHaveLength(1);
    expect(trail()[0].text).not.toBe("Previous step");
  } finally { await page.happyDOM.close(); }
});


it("keeps pre-ack steps private and discards them on stop or a fresh recording", async () => {
  const page = new Window({ url: "https://example.test" });
  try {
    page.sessionStorage.setItem("monocode.rec", "1");
    page.document.body.innerHTML = '<button>Early</button>';
    page.eval(script);
    for (let i = 0; i < 100; i++) page.document.querySelector("button")!.click();
    expect(page.eval("window.__monocodeTrail")).toEqual([]);
    expect(page.sessionStorage.getItem("monocode.trail")).toBeNull();
    page.eval("window.__monocodeSetRec(false); window.__monocodeSetRec(true, true)");
    expect(JSON.stringify(page.eval("window.__monocodeTrail"))).not.toContain("Early");
  } finally { await page.happyDOM.close(); }
});

it("requests recording acknowledgement on BFCache restore and recovers early same-origin steps", async () => {
  const page = new Window({ url: "https://example.test" });
  try {
    const messages: string[] = [];
    (page as unknown as { ipc: { postMessage(value: string): void } }).ipc = { postMessage: value => messages.push(value) };
    page.document.body.innerHTML = '<button>After back</button>';
    page.eval(script);
    expect(messages).toContain("recording-ready");
    page.eval("window.__monocodeSetRec(true)");
    page.dispatchEvent(new page.Event("pagehide"));
    page.sessionStorage.setItem("monocode.trail", JSON.stringify([{ at: 1, text: "Other page step" }]));
    messages.length = 0;
    page.dispatchEvent(Object.assign(new page.Event("pageshow"), { persisted: true }));
    expect(messages).toEqual(["recording-ready"]);
    page.document.querySelector("button")!.click();
    expect(page.eval("window.__monocodeRec")).toBe(false);
    expect(JSON.stringify(page.eval("window.__monocodeTrail"))).not.toContain("After back");
    page.eval("window.__monocodeSetRec(true, true)");
    expect(page.eval("window.__monocodeTrail").map((step: { text: string }) => step.text)).toEqual([
      "Other page step", "Opened https://example.test/", 'Clicked button "After back"',
    ]);
  } finally { await page.happyDOM.close(); }
});
