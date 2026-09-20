import { homeDir } from "../../../../platform/tauri/fs";
import { refreshModelCatalog } from "../../../../features/sessions/model/models";
import { execChild, resolveFxBinary } from "../../core/child";
import {
  mergeFxCatalogModels,
  modelFromFxStatusOutput,
  modelsFromFxOutput,
} from "./fxProtocol";

export function refreshFxCatalog(cwd?: string): Promise<void> {
  return refreshModelCatalog("fx", cwd, discoverFxModels);
}

async function discoverFxModels(projectCwd?: string) {
  const { path } = await resolveFxBinary(projectCwd);
  const cwd = projectCwd ?? await homeDir();
  const [modelsOutput, statusOutput] = await Promise.all([
    execChild(path, ["models", "--json"], cwd),
    execChild(path, ["status", "--json"], cwd).catch(() => ""),
  ]);
  return mergeFxCatalogModels(
    modelsFromFxOutput(modelsOutput),
    modelFromFxStatusOutput(statusOutput),
  );
}
