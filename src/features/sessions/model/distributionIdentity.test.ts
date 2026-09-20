import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

describe("distribution boundary", () => {
  it("keeps packaged identity, local data namespace and macOS dev identity aligned", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(config.identifier).toBe("com.kaceper11.monocode");
    expect(config.productName).toBe("MonoCode");
    expect(config.app.windows[0].title).toBe(config.productName);
    const macos = read("src-tauri/src/macos.rs");
    expect(macos).toContain(
      `const DEV_BUNDLE_ID: &str = "${config.identifier}"`,
    );
    expect(macos).toContain(`<string>${config.identifier}</string>`);
    expect(macos).toContain(`const DEV_BUNDLE_DEFAULT_NAME: &str = "${config.productName}"`);
    expect(macos).not.toContain("com.monocode.desktop");
  });

  it("keeps release credentials out of development builds and publishes from this repository", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(config.plugins.updater.endpoints).toEqual([]);
    expect(config.plugins.updater.pubkey).toBe("");
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).not.toContain("R2_");
    expect(workflow).toContain(
      "https://github.com/kaceper11/monocode/releases/latest/download/latest.json",
    );
    for (const job of ["release", "linux", "windows"]) {
      const start = workflow.indexOf(`\n  ${job}:\n`);
      expect(start).toBeGreaterThan(-1);
      const next = workflow.slice(start + 1).search(/\n  [\w-]+:\n/);
      const block =
        next < 0
          ? workflow.slice(start)
          : workflow.slice(start, start + 1 + next);
      expect(block).toContain("if: github.repository == 'kaceper11/monocode'");
    }
  });
});
