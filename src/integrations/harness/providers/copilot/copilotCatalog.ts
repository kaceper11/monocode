import { homeDir } from "../../../../platform/tauri/fs.ts";
import { refreshModelCatalog } from "../../../../features/sessions/model/models.ts";
import { AcpClient } from "../../core/acp.ts";
import {
  killChild,
  resolveCopilotBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child.ts";
import {
  COPILOT_CLIENT_CAPABILITIES,
  copilotModelsFromSetup,
  copilotSpawnArgs,
} from "./copilotProtocol";

const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

export function refreshCopilotCatalog(cwd?: string): Promise<void> {
  return refreshModelCatalog("copilot", cwd, discoverCopilotModels);
}

/**
 * Copilot has no machine-readable `models` command; a throwaway ACP session
 * advertises the account's catalog in `session/new` (`models.availableModels`,
 * falling back to the `model` config option).
 */
async function discoverCopilotModels(projectCwd?: string) {
  const { path } = await resolveCopilotBinary(projectCwd);
  const cwd = projectCwd ?? (await homeDir());
  const PROBE_ID = `monocode-copilot-probe-${crypto.randomUUID()}`;
  const acp = new AcpClient(PROBE_ID, {
    onRequest: (id, method) => {
      const result =
        method === "session/request_permission"
          ? { outcome: { outcome: "cancelled" } }
          : method === "elicitation/create"
            ? { action: "cancel" }
            : {};
      void acp.respond(id, result).catch(() => undefined);
    },
  });

  const stop = async () => {
    acp.close();
    unwatchChild(PROBE_ID);
    await killChild(PROBE_ID).catch(() => undefined);
  };

  watchChild(
    PROBE_ID,
    (line) => acp.pushLine(line),
    () => acp.close(new Error("Copilot catalog probe exited")),
  );

  try {
    await spawnChild(PROBE_ID, path, copilotSpawnArgs(), cwd);
    return await withTimeout(
      DISCOVERY_TIMEOUT_MS,
      async () => {
        await acp.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: COPILOT_CLIENT_CAPABILITIES,
            clientInfo: { name: "monocode", version: "0.1.0" },
          },
          REQUEST_TIMEOUT_MS,
        );
        const created = await acp.request(
          "session/new",
          { cwd, mcpServers: [] },
          REQUEST_TIMEOUT_MS,
        );
        return copilotModelsFromSetup(created);
      },
      () => {
        void stop();
      },
    );
  } finally {
    await stop();
  }
}

function withTimeout<T>(
  ms: number,
  run: () => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("Copilot catalog probe timed out"));
    }, ms);
    run()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
