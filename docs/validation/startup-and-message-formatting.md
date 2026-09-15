# Home workspace startup and follow-up formatting

Validation date: 2026-09-15, `perf/agent-harness-reliability`.

## Reproduced failures and changes

The isolated macOS app retained `~` as its empty-workspace path. Finder launches the app at `/`, which the frontend rejects as a project. The native child launcher expanded `~`, but Muse's `session/start.workspaceRoot` still received the literal alias and rejected it as non-absolute.

- The backend default-directory command now returns home for root-directory launches and preserves project directories. The frontend deliberately keeps a non-project home workspace displayed as `~` to avoid indexing the whole home directory; outgoing protocol translation handles that alias.
- The shared native harness write boundary expands home aliases in top-level protocol `params.cwd` and `params.workspaceRoot`, matching child startup. Prompt text, nested tool data and response payloads are untouched. Existing absolute paths do not trigger home lookup or translation.
- WSL translation now includes Muse's `workspaceRoot`, validates both execution fields, and rejects a different distribution. Host identity remains unchanged outside the protocol message.

User message rendering previously enabled Markdown only for triple-backtick fences or a special reference header. Ordinary lists, emphasis, inline code and tilde fences in follow-ups displayed literally. All user messages now use the existing Markdown renderer, with soft paragraph line breaks preserved. Code blocks keep their existing copy control. Long messages remain expandable and remote images still require explicit attachment.

## Evidence

- A new opt-in Rust test uses installed/authenticated Muse and the actual native path translation helper: the literal `~` request reproduces the exact absolute-path error; the translated request successfully creates a session. No model turn or tool action is sent.
- Regression tests cover native home aliases, home subdirectories with spaces, untouched prompts/nested data, WSL field translation and host mismatch, root-launch fallback, preserved project cwd, and follow-up Markdown.
- `npm run check`: 2,967 web tests passed, 2 skipped; TypeScript passed. Rust formatting and Clippy passed; 441 Rust tests passed, 4 ignored. The opt-in live Muse test was run separately and passed.
- The isolated macOS release app was rebuilt and relaunched successfully as **MonoCode Harness Check**.
- Chromium check of the actual transcript component and `appendSteerUser`: bold text, list items, inline code, tilde-fenced TypeScript and two plain-text lines render correctly. Computed paragraph whitespace is `pre-wrap`; the code copy control is present. Screenshot: `/tmp/monocode-followup-format.png`. Native IO was not used by this browser fixture; the fixture and browser were removed/closed afterward.

Reproduce the real Muse startup check:

```sh
cargo test native_muse_home_session_start --lib -- --ignored
```

Live Windows/WSL acceptance and native WebView visual verification remain outstanding. The browser check and Rust protocol smoke cover different boundaries; neither alone establishes complete app/CLI parity.
