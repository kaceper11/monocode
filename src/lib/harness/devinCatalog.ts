import { homeDir } from "../fs";
import { refreshModelCatalog } from "../models";
import { AcpClient } from "./acp";
import {
  execChild,
  killChild,
  resolveDevinBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  DEVIN_CLIENT_CAPABILITIES,
  asRecord,
  devinConfigOptions,
  devinModelsFromConfig,
  devinModelsFromOutput,
  devinSpawnArgs,
} from "./devinProtocol";

const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

export function refreshDevinCatalog(cwd?: string): Promise<void> {
  return refreshModelCatalog("devin", cwd, () => discoverDevinModels(cwd));
}

/**
 * `devin models list --format json` is the cheap account catalog and does not
 * create a session. The ACP `model` config option is the fallback for older
 * CLIs without the list command.
 */
async function discoverDevinModels(projectCwd?: string) {
  const fromCli = await discoverViaCli(projectCwd).catch((error: unknown) => {
    console.debug("[monocode] devin CLI catalog failed", error);
    return [];
  });
  if (fromCli.length > 0) return fromCli;
  return discoverViaAcp(projectCwd);
}

async function discoverViaCli(projectCwd?: string) {
  const { path } = await resolveDevinBinary(projectCwd);
  const cwd = projectCwd ?? (await homeDir());
  const stdout = await execChild(path, ["models", "list", "--format", "json"], cwd);
  return devinModelsFromOutput(stdout);
}

async function discoverViaAcp(projectCwd?: string) {
  const { path } = await resolveDevinBinary(projectCwd);
  const cwd = projectCwd ?? (await homeDir());
  const PROBE_ID = `monocode-devin-probe-${crypto.randomUUID()}`;
  const acp = new AcpClient(PROBE_ID, {
    onRequest: (id) => {
      void acp.respond(id, {}).catch(() => undefined);
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
    () => acp.close(new Error("Devin catalog probe exited")),
  );

  try {
    await spawnChild(PROBE_ID, path, devinSpawnArgs(), cwd);
    return await withTimeout(
      DISCOVERY_TIMEOUT_MS,
      async () => {
        await acp.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: DEVIN_CLIENT_CAPABILITIES,
            clientInfo: { name: "monocode", version: "0.1.0" },
          },
          REQUEST_TIMEOUT_MS,
        );
        const created = await acp.request(
          "session/new",
          { cwd, mcpServers: [] },
          REQUEST_TIMEOUT_MS,
        );
        return devinModelsFromConfig(
          devinConfigOptions(asRecord(created)?.configOptions),
        );
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
      reject(new Error("Devin catalog probe timed out"));
    }, ms);
    run()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
