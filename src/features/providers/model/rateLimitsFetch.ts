import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "../../../platform/tauri/fs";
import {
  errorRateLimits,
  parseClaudeOAuthUsage,
  parseCodexRateLimits,
  parseCopilotQuota,
  parseMuseUsage,
  parseOpencodeGoUsage,
  unavailableRateLimits,
  type ProviderRateLimits,
} from "./rateLimits";
import {
  killChild,
  resolveCodexBinary,
  resolveCopilotBinary,
  resolveMuseBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../../integrations/harness/core/child";
import { asRecord } from "../../../integrations/harness/providers/codex/codexProtocol";
import { JsonRpcClient } from "../../../integrations/harness/core/jsonRpc";

import {
  museInitializeParams,
  museCheckInitialize,
} from "../../../integrations/harness/providers/muse/museProtocol";
import { readLiveMuseUsage } from "../../../integrations/harness/providers/muse/muse";
import { wslLocation } from "../../../shared/lib/paths";

const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

type OpencodeGoUsageFetch = {
  status: "ok" | "error" | "unavailable" | string;
  httpStatus?: number | null;
  body?: string | null;
  error?: string | null;
};

/**
 * Fetch OpenCode Go 5h / weekly / monthly usage via the official API.
 * Runs through a Tauri command so the webview CORS policy does not apply.
 */
export async function fetchOpencodeGoRateLimits(
  cwd?: string,
): Promise<ProviderRateLimits> {
  if (cwd && wslLocation(cwd))
    return {
      ...unavailableRateLimits(
        "opencode",
        "OpenCode usage is not supported inside WSL yet.",
      ),
      status: "unsupported",
    };
  let result: OpencodeGoUsageFetch;
  try {
    result = await invoke<OpencodeGoUsageFetch>("fetch_opencode_go_usage");
  } catch (error) {
    return errorRateLimits(
      "opencode",
      error instanceof Error ? error.message : "OpenCode Go usage unavailable",
    );
  }
  if (result.status === "ok" && result.body) {
    try {
      const parsed = parseOpencodeGoUsage(JSON.parse(result.body));
      if (parsed.session || parsed.weekly || parsed.monthly) return parsed;
    } catch {
      return errorRateLimits("opencode", "OpenCode Go response was not JSON");
    }
    // A 200 with no usable windows is malformed: report an error so the
    // footer retries instead of sticking in "unavailable" forever.
    return errorRateLimits(
      "opencode",
      "OpenCode Go usage response was unexpected",
    );
  }
  if (result.status === "unavailable") {
    return unavailableRateLimits(
      "opencode",
      result.error?.trim() || "OpenCode Go not connected",
    );
  }
  return errorRateLimits(
    "opencode",
    result.error?.trim() || "OpenCode Go usage unavailable",
  );
}

export type CodexRateLimitResetOutcome =
  "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

type ClaudeUsageFetch = {
  status: "ok" | "error" | "unavailable" | string;
  httpStatus?: number | null;
  body?: string | null;
  error?: string | null;
};

export async function fetchClaudeRateLimits(
  accountId = "default",
  projectCwd?: string,
): Promise<ProviderRateLimits> {
  try {
    const result = await invoke<ClaudeUsageFetch>("fetch_claude_usage", {
      accountId,
      cwd: projectCwd,
    });
    if (result.status === "ok" && result.body) {
      const parsed = parseClaudeOAuthUsage(result.body);
      if (parsed.session || parsed.weekly) return parsed;
      return {
        ...parsed,
        status: parsed.status === "ok" ? "ok" : parsed.status,
      };
    }
    if (result.status === "unavailable") {
      return unavailableRateLimits(
        "claude",
        result.error?.trim() || "Claude not signed in",
      );
    }
    return errorRateLimits(
      "claude",
      result.error?.trim() || "Claude usage unavailable",
    );
  } catch (error) {
    return errorRateLimits(
      "claude",
      error instanceof Error ? error.message : "Claude usage unavailable",
    );
  }
}

export async function fetchCodexRateLimits(
  accountId = "default",
  projectCwd?: string,
): Promise<ProviderRateLimits> {
  let path: string;
  try {
    path = (await resolveCodexBinary(projectCwd)).path;
  } catch (error) {
    if (projectCwd && wslLocation(projectCwd))
      return errorRateLimits(
        "codex",
        error instanceof Error ? error.message : String(error),
      );
    return unavailableRateLimits("codex", "Codex CLI not found");
  }

  const cwd = projectCwd ?? (await homeDir());
  try {
    const result = await requestCodexAccount<unknown>(
      path,
      cwd,
      "account/rateLimits/read",
      {},
      accountId,
    );
    const parsed = parseCodexRateLimits(result);
    if (parsed.session || parsed.weekly || parsed.resetCredits) return parsed;
    const rec = asRecord(result);
    if (rec && !parsed.session && !parsed.weekly) {
      return unavailableRateLimits("codex", "No Codex usage data");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /not signed in|chatgpt authentication required|not authenticated/i.test(
        message,
      )
    ) {
      return unavailableRateLimits("codex", "Codex not signed in");
    }
    if (/ENOENT|not found|could not run/i.test(message)) {
      return unavailableRateLimits("codex", "Codex CLI not found");
    }
    return errorRateLimits("codex", message);
  }
}

export async function consumeCodexRateLimitResetCredit(
  creditId?: string,
  accountId = "default",
  projectCwd?: string,
): Promise<CodexRateLimitResetOutcome> {
  const path = (await resolveCodexBinary(projectCwd)).path;
  const cwd = projectCwd ?? (await homeDir());
  const result = await requestCodexAccount<unknown>(
    path,
    cwd,
    "account/rateLimitResetCredit/consume",
    {
      idempotencyKey: crypto.randomUUID(),
      ...(creditId ? { creditId } : {}),
    },
    accountId,
  );
  const outcome = asRecord(result)?.outcome;
  if (
    outcome === "reset" ||
    outcome === "nothingToReset" ||
    outcome === "noCredit" ||
    outcome === "alreadyRedeemed"
  ) {
    return outcome;
  }
  throw new Error("Codex returned an unknown reset result");
}

async function requestCodexAccount<T>(
  path: string,
  cwd: string,
  method: string,
  params: unknown,
  accountId: string,
): Promise<T> {
  return usageRpc(
    "codex",
    path,
    ["app-server"],
    cwd,
    async (rpc) => {
      await rpc.request(
        "initialize",
        {
          clientInfo: { name: "monocode", title: "MonoCode", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
        REQUEST_TIMEOUT_MS,
      );
      await rpc.notify("initialized", undefined);
      return rpc.request<T>(method, params, REQUEST_TIMEOUT_MS);
    },
    accountId,
  );
}

async function usageRpc<T>(
  provider: "codex" | "copilot" | "muse",
  path: string,
  args: string[],
  cwd: string,
  read: (rpc: JsonRpcClient) => Promise<T>,
  accountId?: string,
): Promise<T> {
  // Separate windows/hosts must never terminate one another's probes or reset.
  const id = `monocode-${provider}-usage-${crypto.randomUUID()}`;
  const rpc = new JsonRpcClient(
    id,
    {
      onRequest: (requestId) => {
        void rpc
          .respondError(requestId, {
            code: -32601,
            message: "Read-only usage probe",
          })
          .catch(() => undefined);
      },
    },
    { includeJsonrpc: provider !== "codex", label: `${provider}-usage` },
  );
  const stop = async () => {
    rpc.close();
    unwatchChild(id);
    await killChild(id).catch(() => undefined);
  };
  watchChild(
    id,
    (line) => rpc.pushLine(line),
    () => rpc.close(new Error(`${provider} usage probe exited`)),
  );
  try {
    await spawnChild(
      id,
      path,
      args,
      cwd,
      provider === "codex"
        ? { provider, id: accountId ?? "default" }
        : undefined,
    );
    return await withTimeout(
      DISCOVERY_TIMEOUT_MS,
      () => read(rpc),
      () => {
        void stop();
      },
    );
  } finally {
    await stop();
  }
}

export async function fetchAdditionalRateLimits(
  provider: "copilot" | "muse" | "devin",
  cwd?: string,
  sessionId?: string,
): Promise<ProviderRateLimits> {
  if (provider === "devin")
    return {
      ...unavailableRateLimits(
        provider,
        "Devin's CLI does not expose account quota through the supported integration. Check usage in Devin; session context is not your account allowance.",
      ),
      status: "unsupported",
    };
  try {
    if (provider === "muse") {
      const live = readLiveMuseUsage(sessionId, cwd);
      if (live) return parseMuseUsage(await live);
      const { path } = await resolveMuseBinary(cwd);
      return parseMuseUsage(
        await usageRpc(
          provider,
          path,
          ["serve"],
          cwd ?? (await homeDir()),
          async (rpc) => {
            museCheckInitialize(
              await rpc.request(
                "initialize",
                museInitializeParams(),
                REQUEST_TIMEOUT_MS,
              ),
            );
            await rpc.notify("initialized");
            return rpc.request("usage/read", {}, REQUEST_TIMEOUT_MS);
          },
        ),
      );
    }
    const { path } = await resolveCopilotBinary(cwd);
    return parseCopilotQuota(
      await usageRpc(
        provider,
        path,
        ["--headless", "--no-auto-update", "--stdio"],
        cwd ?? (await homeDir()),
        async (rpc) => {
          try {
            await rpc.request("connect", {}, REQUEST_TIMEOUT_MS);
          } catch (error) {
            if ((error as { code?: number }).code !== -32601) throw error;
            await rpc.request("ping", {}, REQUEST_TIMEOUT_MS);
          }
          return rpc.request("account.getQuota", {}, REQUEST_TIMEOUT_MS);
        },
      ),
    );
  } catch (error) {
    if ((error as { code?: number }).code === -32601)
      return {
        ...unavailableRateLimits(
          provider,
          `This ${provider} CLI version does not expose account usage. Update the CLI and refresh.`,
        ),
        status: "unsupported",
      };
    return errorRateLimits(
      provider,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function withTimeout<T>(
  ms: number,
  work: () => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = work();
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error("Codex usage probe timed out"));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void pending.catch(() => undefined);
  }
}
