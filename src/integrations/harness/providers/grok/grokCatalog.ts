import { wslLocation } from "../../../../shared/lib/paths";
import { homeDir } from "../../../../platform/tauri/fs";
import { refreshModelCatalog } from "../../../../features/sessions/model/models";
import { AcpClient } from "../../core/acp";
import {
  execChild,
  killChild,
  resolveGrokBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  fallbackGrokModels,
  grokAuthMethodId,
  grokSpawnArgs,
  modelsFromGrokModelsOutput,
  modelsFromInitialize,
  modelsFromSessionNew,
} from "./grokProtocol";

const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export function refreshGrokCatalog(cwd?: string): Promise<void> {
  return refreshModelCatalog("grok", cwd, discoverGrokModels);
}

async function discoverGrokModels(projectCwd?: string) {
  const fromAcp = await discoverViaAcp(projectCwd).catch((error: unknown) => {
    console.debug("[monocode] grok ACP catalog failed", error);
    return [];
  });
  if (fromAcp.length > 0) return fromAcp;
  const fromCli = await discoverViaCli(projectCwd).catch((error: unknown) => {
    console.debug("[monocode] grok CLI catalog failed", error);
    return [];
  });
  if (fromCli.length > 0) return fromCli;
  if (projectCwd && wslLocation(projectCwd)) throw new Error("Grok model discovery failed. Check the Linux CLI account and retry.");
  return fallbackGrokModels();
}

async function discoverViaAcp(projectCwd?: string) {
  const { path } = await resolveGrokBinary(projectCwd);
  const cwd = projectCwd ?? await homeDir();
  const PROBE_ID = `monocode-grok-probe-${crypto.randomUUID()}`;
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
    () => acp.close(new Error("Grok Build probe exited")),
  );

  try {
    await spawnChild(PROBE_ID, path, grokSpawnArgs({ model: "" }), cwd);
    return await withTimeout(DISCOVERY_TIMEOUT_MS, async () => {
      const init = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        REQUEST_TIMEOUT_MS,
      );
      const fromInit = modelsFromInitialize(init);
      if (fromInit.length > 0) return fromInit;

      const methodId = grokAuthMethodId(init);
      if (methodId) {
        await acp
          .request(
            "authenticate",
            { methodId, _meta: { headless: true } },
            REQUEST_TIMEOUT_MS,
          )
          .catch(() => undefined);
      }
      const created = await acp.request(
        "session/new",
        { cwd, mcpServers: [] },
        REQUEST_TIMEOUT_MS,
      );
      return modelsFromSessionNew(created);
    }, () => {
      void stop();
    });
  } finally {
    await stop();
  }
}

async function discoverViaCli(projectCwd?: string) {
  const { path } = await resolveGrokBinary(projectCwd);
  const cwd = projectCwd ?? await homeDir();
  const stdout = await execChild(path, ["models"], cwd);
  return modelsFromGrokModelsOutput(stdout);
}

function withTimeout<T>(
  ms: number,
  run: () => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("Grok Build catalog probe timed out"));
    }, ms);
    run()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
