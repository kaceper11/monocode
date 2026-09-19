import { homeDir } from "../fs";
import { refreshModelCatalog } from "../models";
import {
  killChild,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import { PiRpc } from "./piClient";
import { OMP_FLAVOR, PI_FLAVOR, type PiFlavor } from "./piFlavor";
import { buildPiSpawnArgs, modelsFromRpcData } from "./piProtocol";

const DISCOVERY_TIMEOUT_MS = 45_000;

function refreshCatalog(flavor: PiFlavor, cwd?: string): Promise<void> {
  return refreshModelCatalog(flavor.id, cwd, (projectCwd) => discoverModels(flavor, projectCwd));
}

async function discoverModels(flavor: PiFlavor, projectCwd?: string) {
  const { path } = await flavor.resolveBinary(projectCwd);
  const cwd = projectCwd ?? await homeDir();
  const probeId = `${flavor.probeChildId}-${crypto.randomUUID()}`;
  const rpc = new PiRpc(probeId, () => undefined, flavor.label);

  const stop = async () => {
    rpc.close();
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  };

  watchChild(
    probeId,
    (line) => rpc.pushLine(line),
    () => rpc.close(new Error(`${flavor.label} catalog probe exited`)),
  );

  try {
    await spawnChild(
      probeId,
      path,
      buildPiSpawnArgs(flavor, { noSession: true, noExtensions: true }),
      cwd,
    );
    const response = await Promise.race([
      rpc.request({ type: "get_available_models" }, DISCOVERY_TIMEOUT_MS),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`${flavor.label} model discovery timed out`)),
          DISCOVERY_TIMEOUT_MS,
        );
      }),
    ]);
    return modelsFromRpcData(flavor, response.data);
  } finally {
    await stop();
  }
}

export function refreshPiCatalog(cwd?: string): Promise<void> {
  return refreshCatalog(PI_FLAVOR, cwd);
}

export function refreshOmpCatalog(cwd?: string): Promise<void> {
  return refreshCatalog(OMP_FLAVOR, cwd);
}
