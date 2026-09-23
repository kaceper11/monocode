# Harness latency on native Windows

The target is native-CLI responsiveness with the **same** executable, account,
model, reasoning, service tier, instructions, MCP configuration and checkout.
Compare cold, warm and resumed conversations separately. A two-second interactive
CLI response is not a valid baseline for a different model or effort setting.
The latest user observation is that only the first Windows message was slow;
prioritize cold-start comparison rather than assuming a delay on every turn.

## Capture MonoCode timings

Use a release build with main-WebView developer tools enabled on the affected
Windows machine. For a local diagnostic build, run
`npm run tauri -- build --features tauri/devtools --no-bundle`, and open the resulting app.
In the **main application WebView's** developer console (not the Browser side
panel), enable tracing:

```js
localStorage.setItem("monocode.harnessTiming", "true");
```

Send a message, then export the buffer from that same console:

```js
JSON.stringify(monocodeHarnessTiming.read(), null, 2);
```

Save that JSON outside the repository. The buffer retains at most 100 operations
and 128 spans per operation. It includes selected model/settings and protocol
method names, but no prompts, responses, credentials, paths or error messages.
Tracing is off by default and makes no network requests. Clear/disable it with:

```js
monocodeHarnessTiming.clear();
localStorage.removeItem("monocode.harnessTiming");
```

Numbers are milliseconds measured with the renderer's monotonic clock. Spans
may overlap; **do not sum overlapping preparation or protocol spans**.

| Field                                       | Meaning                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `projectLocation` span                      | Pre-submit project identity check, including any shared wait                    |
| `checkpoint`, `attachments`, `prompt` spans | Independent preparation; all must settle before dispatch                        |
| `queued` → `dequeued`                       | Registry queue wait                                                             |
| `authorize` span                            | Native checkout authorization                                                   |
| `adapterStart` → `promptWriteStarted`       | Adapter preparation, resolution, startup and settings                           |
| `spawn` span                                | Native process spawn IPC; initialization is separate                            |
| `rpc:*` spans                               | Protocol requests, including initialization and configuration                   |
| `write:*` spans                             | Stdin write and acknowledgement, including IPC in the app                       |
| `writeQueue:*` spans                        | Time waiting behind earlier writes to the same child                            |
| `promptWriteStarted` / `promptWritten`      | Bounds on prompt delivery, not a server acceptance timestamp                    |
| `firstStdout`                               | First stdout line received by the renderer; may be a control response           |
| `firstReasoning`, `firstText`               | First normalized reasoning/answer event received by the app                     |
| `firstTextApplied`                          | First answer batch applied to transcript state                                  |
| `firstTextCommitted`                        | React layout effect for the visible conversation; not a browser paint timestamp |
| `firstMessageCompleted`                     | First assistant message completed; the provider may still have work             |
| `providerTurnCompleted`                     | Codex/Muse turn-completed notification received before adapter handling         |
| `settled`, `outcome`                        | Adapter operation finished; not task acceptance or merge readiness              |

Responses can arrive before native write acknowledgements. A missing mark means
the stage was not observed, never zero milliseconds. Hidden conversations do
not count toward visible-render latency. Steering and cancellation have separate
operation records; their wire writes also appear on the active turn. Provider
acknowledgement/completion is distinct from dispatch latency.

## Native protocol baseline

The opt-in test below runs the production adapters over Node stdio, bypassing
MonoCode's project preparation, Tauri IPC and UI. It is an **adapter-over-stdio**
baseline, not an independent provider implementation. Normal test runs skip it.
It sends 3 cold, 10 warm and 3 resumed greetings, uses the CLI's existing login,
and can consume provider usage. It denies tool approvals and skips questions.

PowerShell example (replace the executable, model and settings with your actual
configuration; `codex:default` explicitly requests the provider default):

```powershell
$env:MONOCODE_LATENCY_HARNESS = 'codex'
$env:MONOCODE_LATENCY_COMMAND = '["C:\\path\\to\\codex.exe"]'
$env:MONOCODE_LATENCY_CWD = 'C:\work\project'
$env:MONOCODE_LATENCY_MODEL = 'codex:default'
$env:MONOCODE_LATENCY_SETTINGS = '{}'
$env:MONOCODE_LATENCY_OUTPUT = "$env:TEMP\monocode-codex-latency.json"
npx vitest run src/integrations/harness/core/latency.real.test.ts
```

Supported harness IDs: `codex`, `claude`, `devin`, `copilot`, `omp`, `muse`.
The command is a JSON argv array, never a shell string. For npm/Bun scripts use
the actual runtime executable plus entrypoint, such as
`["C:\\path\\node.exe","C:\\path\\cli.js"]`, rather than a `.cmd` shim.
The runner uses supervised/default interaction mode; match that in the other
two measurements. For named MonoCode accounts, select equivalent CLI credentials
explicitly before running; the runner does not copy account profiles.

Use `Get-Command codex -All` (substitute each CLI) and its `--version` to document
the executable/version. Run the interactive CLI with the same prompt:
`Reply with exactly HI. Do not use tools.` Use three fresh conversations, ten
warm follow-ups in the first conversation, and three process restarts/resumes.
Use that exact prompt and sequence in MonoCode. Keep the app foregrounded.

Unset the `MONOCODE_LATENCY_*` variables before routine full test runs. Native
provider session records remain in the CLI's own storage; the runner stops only
the processes it created. Measurements are written to the supplied path or the
OS temporary directory, including partial results if a sample fails.

## Acceptance and interpreting results

Record CPU/RAM, Windows build, WebView2 version, app commit/build, CLI versions,
repository size and selected settings alongside the three sets of measurements.
Record app/backend/WebView costs separately from provider/child processes.

- Warm MonoCode overhead target: median ≤200 ms, p95 ≤500 ms.
- Foreground text receipt to visible transcript commit target: p95 ≤100 ms.
  Check actual paint/input responsiveness with WebView profiling as well.
- Steering/cancel dispatch target: ≤100 ms; report acknowledgement separately.
- Include one short coding task, a long answer, a mid-stream steer, cancellation,
  settings changes and resume. These interactive cases require native app testing.
- Treat p95 from ten warm samples as a screening result; repeat a failing case
  before assigning a root cause. Compare distributions, not a single subtraction.

Large `projectLocation`/preparation/queue/write spans point to app-side work.
Fast prompt delivery followed by slow first text in both the stdio baseline and
MonoCode points toward provider/protocol/configuration behavior. Fast first text
but slow commit points toward rendering. Do not lower reasoning or disable
permissions to make the numbers pass.

The implementation overlaps independent preparation while retaining the snapshot
barrier, and defers optional title generation until the foreground reply ends.
Unit tests establish ordering/cancellation behavior, not native Windows latency.
Windows before/after acceptance remains required; no measured 16-to-2-second
improvement is claimed by this document.

## Local verification, 2026-09-23

Authenticated adapter-over-stdio runs on macOS 26.6.2, Apple M5 Pro, 24 GiB RAM,
in the MonoCode checkout, using provider-default models and empty model-setting
overrides. Each run contained 3 cold, 10 warm and 3 resumed greetings. This is
a protocol baseline, **not a Windows or before/after application comparison**.

| CLI | Warm first text, median | Warm first text, p95 | Warm completion, median |
| --- | ---: | ---: | ---: |
| Codex 0.156.1 | 2.12 s | 5.75 s | 2.66 s |
| Devin 3000.11.1 | 2.58 s | 3.55 s | 2.62 s |
| OMP 18.2.8 | 2.37 s | 10.37 s | 2.51 s |
| Muse 1.3.0 | 1.96 s | 4.85 s | 12.60 s |

Median warm prompt delivery was below 1 ms for all four. Muse's long interval
after first text also occurs in this run without Tauri or React; first answer
and operation completion must remain separate measurements. Do not infer a
safe early-completion policy from this observation. Claude Code and Copilot
were not on the local PATH, so their authenticated baselines remain unverified.
App/backend/WebView CPU and memory were not measured in these stdio runs.

## Follow-up review

Concurrent availability, catalog and session-start executable lookups now share
the pending resolver request. Completed results and failures are not cached;
guest workspace and provider boundaries remain separate. Regression tests show
three overlapping native lookups becoming one IPC request for each of the six
requested providers. This can avoid duplicate CLI verification processes, but
the Windows cold-start time saved has not been measured.

Transcript flushes now fold consecutive text/reasoning chunks before copying
the block array. Snapshot merging stays sequential and every non-text event
retains its position. This uses the existing frame schedule without adding a
streaming delay. A local Node/Vite-node microbenchmark (same Mac as above,
2,000 blocks, 10,000 text events, 100 events per batch, median of ten samples
after two warmups) measured 7.53 ms with individual reductions versus 1.84 ms
with batched reduction. This measures reducer CPU only, not release-WebView
rendering or provider latency. The regression test also verifies one block-array
copy for 100 consecutive text updates and equivalence across batch boundaries.
