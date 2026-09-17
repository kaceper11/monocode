import { HARNESSES } from "./session";
import { modelsFor } from "./models";
import {
  isHarnessAvailable,
  probeHarnessAvailability,
} from "./harness/availability";
import { refreshHarnessCatalogs } from "./harness/registry";
import { validateOrchestrationSettings } from "./orchestrationPlan";

/** Discover worker choices only when the user sends an orchestration request. */
export async function discoverOrchestrationSettings() {
  await probeHarnessAvailability();
  const installed = HARNESSES.filter((harness) => isHarnessAvailable(harness));
  await refreshHarnessCatalogs(installed);
  return validateOrchestrationSettings({
    maxWorkers: 2,
    choices: installed
      .filter((harness) => isHarnessAvailable(harness))
      .flatMap((harness) =>
        modelsFor(harness).map(({ id, name }) => ({
          harness,
          model: id,
          name,
        })),
      ),
  });
}
