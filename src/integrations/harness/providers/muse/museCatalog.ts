import { homeDir } from "../../../../platform/tauri/fs.ts";
import { refreshModelCatalog, type AgentModel } from "../../../../features/sessions/model/models.ts";
import {
  killChild,
  resolveMuseBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child.ts";
import { JsonRpcClient } from "../../core/jsonRpc.ts";
import {
  MUSE_AUTH_HELP,
  museCheckInitialize,
  museInitializeParams,
  museModelsFromList,
} from "./museProtocol";

const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

export function refreshMuseCatalog(cwd?: string): Promise<void> {
  return refreshModelCatalog("muse", cwd, discoverMuseModels);
}

/**
 * One short-lived `muse serve` host that answers initialize + model/list.
 * Live sessions warm the catalog from their own connection instead, so this
 * probe only runs for the picker before any session exists.
 */
async function discoverMuseModels(projectCwd?: string): Promise<AgentModel[]> {
  const { path } = await resolveMuseBinary(projectCwd);
  const cwd = projectCwd ?? (await homeDir());
  const probeId = `monocode-muse-probe-${crypto.randomUUID()}`;
  const rpc = new JsonRpcClient(
    probeId,
    {
      onRequest: (id) => {
        void rpc.respond(id, {}).catch(() => undefined);
      },
    },
    { includeJsonrpc: true, label: "muse-probe" },
  );

  const stop = async () => {
    rpc.close();
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  };

  watchChild(
    probeId,
    (line) => rpc.pushLine(line),
    () => rpc.close(new Error("Muse probe exited")),
  );

  try {
    await spawnChild(probeId, path, ["serve"], cwd);
    return await withTimeout(
      DISCOVERY_TIMEOUT_MS,
      async () => {
        const init = await rpc.request(
          "initialize",
          museInitializeParams(),
          REQUEST_TIMEOUT_MS,
        );
        museCheckInitialize(init);
        await rpc.notify("initialized");
        const result = await rpc.request(
          "model/list",
          {},
          REQUEST_TIMEOUT_MS,
        );
        return museModelsFromList(result);
      },
      () => {
        void stop();
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/timed out|initialize/i.test(detail)) {
      throw new Error(`Muse did not answer the catalog probe. ${MUSE_AUTH_HELP}`);
    }
    throw error;
  } finally {
    await stop();
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
          reject(new Error("Muse model discovery timed out"));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void pending.catch(() => undefined);
  }
}
