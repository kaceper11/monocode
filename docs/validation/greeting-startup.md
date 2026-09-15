# Greeting startup and local MCP configuration — 2026-09-15

## Changes

- Restored home-directory sessions can prewarm; a pending provider switch cannot prewarm against the outgoing host.
- After submission and outgoing-host retirement, provider startup overlaps prompt, attachment and checkpoint preparation. The actual turn still waits for the checkpoint; model, effort, permissions and configured tools are preserved.
- A live turn with no output shows “Waiting for [model] response” with elapsed time. It clears on output and completion.
- Muse turn-start reminder bookkeeping is silent. Its real end-of-turn drain settles the visible turn once only bookkeeping children remain; the host still owns terminal completion, and a follow-up Send is admitted with `ifBusy:"queue"` until bookkeeping finishes.
- Devin Extensions inventory includes local overrides when the workspace is the home directory. The regression uses a generic server fixture.

## Live measurements

Apple M5 Pro, 24 GiB RAM, macOS 26.6.2. Authenticated installed CLIs driven through the TypeScript adapters in Vitest, cwd home, supervised mode; excludes native Tauri IPC/WebView costs. Prompts in order: `hey`, `how are you`, `thanks`, in one fresh provider session per run. No model/effort reduction. Three samples are diagnostics, not a controlled performance comparison.

| Provider/model | Turn | First text | Completion |
| --- | --- | ---: | ---: |
| Astra, medium | 1 | 8.74s | 9.30s |
| Astra, medium | 2 | 2.71s | 3.12s |
| Astra, medium | 3 | 2.21s | 2.41s |
| SWE-2 High | 1 | 7.08s | 7.09s |
| SWE-2 High | 2 | 3.50s | 3.94s |
| SWE-2 High | 3 | 4.70s | 4.77s |

Astra prewarming took 0.93s separately. Its first prompt was written in 0.32ms after send began, but first text still took 8.74s. Total prewarm plus first-text time was 9.67s. Thus prewarming did **not** remove first-turn context preparation. Warm follow-ups were 2.71s and 2.21s to first text.

The reported original Astra handoff took 9.69s to completion, including a 6.12s interval before the user prompt was recorded. Original Devin provider metrics reported 11.53s and 22.61s to first token. These persisted provider timestamps differ from the new adapter measurements; do not infer a measured code speedup from their difference. Provider variability and different conversation history remain uncontrolled. The overlap change has no isolated release-build speedup measurement.

## Local configuration repair

Devin CLI identified the home-workspace registration as supplied by Cursor, overriding its disabled user-scope entry. A disabled local override was added with native `devin mcp add ... --scope local` and `devin mcp disable ... --scope local` in the home directory. `devin mcp get` confirmed disabled. Other applications’ registrations were preserved. A fresh Devin greeting run did not connect the unwanted server or reproduce its banner. This workstation incident is not encoded as an application-specific server test. Existing conversation history can retain earlier text.

## Validation

- `npm run check:web`: 3,161 passed, 2 opt-in tests skipped; TypeScript passed.
- `npm run check:rust`: 454 passed, 4 ignored; format and Clippy passed. Generic MCP fixture rerun passed after removing workstation-specific naming.
- Six live greeting/follow-up turns completed without adapter errors.
- Browser interaction checked waiting state, advancing elapsed time, response arrival and disappearance of the waiting state using the real transcript component; screenshots `/tmp/greeting-waiting.png` and `/tmp/greeting-answer.png`. This used a component fixture, not authenticated WebView interaction.
- Release app bundle built. No Windows/WSL live acceptance or all-provider performance claim from this check.
