import { homeDir } from "../../../../platform/tauri/fs";
import { refreshModelCatalog } from "../../../../features/sessions/model/models";
import {
  killChild,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import { PiRpc } from "./piClient";
import { OMP_FLAVOR, PI_FLAVOR, type PiFlavor } from "./piFlavor";
import { buildPiSpawnArgs, modelsFromRpcData } from "./piProtocol";

const DISCOVERY_TIMEOUT_MS = 45_000;

function refreshCatalog(flavor: PiFlavor): Promise<void> {
  return refreshModelCatalog(flavor.id, () => discoverModels(flavor));
}

async function discoverModels(flavor: PiFlavor, workingDirectory?: string) {
  const { path } = await flavor.resolveBinary();
  const cwd = workingDirectory ?? (await homeDir());
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

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await spawnChild(
      probeId,
      path,
      buildPiSpawnArgs(flavor, { noSession: true, noExtensions: true }),
      cwd,
      undefined,
      flavor.id,
    );
    const response = await Promise.race([
      rpc.request({ type: "get_available_models" }, DISCOVERY_TIMEOUT_MS),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${flavor.label} model discovery timed out`)),
          DISCOVERY_TIMEOUT_MS,
        );
      }),
    ]);
    return modelsFromRpcData(flavor, response.data);
  } finally {
    if (timeout) clearTimeout(timeout);
    await stop();
  }
}

export function refreshPiCatalog(): Promise<void> {
  return refreshCatalog(PI_FLAVOR);
}

export function refreshOmpCatalog(): Promise<void> {
  return refreshCatalog(OMP_FLAVOR);
}

export function discoverPiModels(workingDirectory: string) {
  return discoverModels(PI_FLAVOR, workingDirectory);
}

export function discoverOmpModels(workingDirectory: string) {
  return discoverModels(OMP_FLAVOR, workingDirectory);
}
