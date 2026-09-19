import { HARNESSES } from "./session";
import { modelsFor } from "./models";
import {
  isHarnessAvailable,
  probeHarnessAvailability,
} from "./harness/availability";
import { refreshHarnessCatalogs } from "./harness/registry";
import { validateOrchestrationSettings } from "./orchestrationPlan";

/** Discover worker choices only when the user sends an orchestration request. */
export async function discoverOrchestrationSettings(cwd?: string) {
  await probeHarnessAvailability(cwd ? { cwd } : undefined);
  const installed = HARNESSES.filter((harness) => isHarnessAvailable(harness, cwd));
  await refreshHarnessCatalogs(installed, cwd);
  return validateOrchestrationSettings({
    maxWorkers: 2,
    choices: installed
      .filter((harness) => isHarnessAvailable(harness, cwd))
      .flatMap((harness) =>
        modelsFor(harness, cwd).map(({ id, name }) => ({
          harness,
          model: id,
          name,
        })),
      ),
  });
}
