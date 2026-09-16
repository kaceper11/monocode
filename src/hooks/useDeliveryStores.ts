import { useEffect, useMemo, useState } from "react";
import { AZURE_PR_ASSOCIATIONS_CHANGED } from "../lib/azureRepos";
import { AZURE_CI_SOURCES_CHANGED } from "../lib/azurePipelines";
import {
  deliveryStores,
  type DeliveryStores,
} from "../lib/taskDelivery";

/** Saved Azure PR/CI link stores, re-read whenever either store signals a
 * change. `extraEvents` folds other delivery signals (GitLab, providers,
 * storage) into the same tick for panels that depend on them too. */
export function useDeliveryStores(
  extraEvents: readonly string[] = [],
): DeliveryStores {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    const events = [
      AZURE_PR_ASSOCIATIONS_CHANGED,
      AZURE_CI_SOURCES_CHANGED,
      ...extraEvents,
    ];
    for (const name of events) window.addEventListener(name, bump);
    return () => {
      for (const name of events) window.removeEventListener(name, bump);
    };
    // extraEvents is a stable literal at each call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useMemo(
    () => deliveryStores(),
    // The tick is the real invalidation signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  );
}
