import { invoke } from "@tauri-apps/api/core";
import { invalidateHarnessAvailability } from "../../../integrations/harness/core/availability.ts";
import { invalidateModelCatalogs } from "./models";
import { pathKey, wslLocation, wslPath } from "../../../shared/lib/paths.ts";
import { setWslStatus, wslStatusFor } from "./wslStatus";

/** Long enough to keep the project dialog warm, short enough to notice a distro installed mid-session. */
const DISTRIBUTIONS_TTL_MS = 30_000;

let distributionsProbe: Promise<string[]> | null = null;
let distributionsValue: { at: number; names: string[] } | null = null;

/**
 * Cached `wsl_distributions` probe. The resolved value expires after
 * {@link DISTRIBUTIONS_TTL_MS} — a distro installed mid-session must still
 * surface. A failed probe is not retained; the last good list stays visible
 * via `wslDistributionsPeek`.
 */
export function wslDistributions(refresh = false): Promise<string[]> {
  if (
    !refresh &&
    distributionsValue &&
    Date.now() - distributionsValue.at < DISTRIBUTIONS_TTL_MS
  ) {
    return Promise.resolve(distributionsValue.names);
  }
  if (!refresh && distributionsProbe) return distributionsProbe;
  const probe = invoke<string[]>("wsl_distributions");
  distributionsProbe = probe;
  probe
    .then((names) => {
      // A superseded probe must not overwrite a newer result.
      if (distributionsProbe === probe) {
        distributionsValue = { at: Date.now(), names };
        distributionsProbe = null;
      }
    })
    .catch(() => {
      if (distributionsProbe === probe) distributionsProbe = null;
    });
  return probe;
}

/** Last resolved distribution list without triggering a probe; null if never resolved. */
export function wslDistributionsPeek(): string[] | null {
  return distributionsValue?.names ?? null;
}

/** Default user's Linux home, probed without opening a bridge. */
export function wslHome(distribution: string): Promise<string> {
  return invoke<string>("wsl_home", { distribution });
}

/** @internal test-only: drop the cached probe and value. */
export function __wslDistributionsReset() {
  distributionsProbe = null;
  distributionsValue = null;
}

const generations = new Map<string, number>();
const connectionRequests = new Map<string, symbol>();
export function invalidateWslDiscovery(path: string) {
  invalidateHarnessAvailability(path);
  invalidateModelCatalogs(path);
}

const pendingConnections = new Map<string, Promise<string>>();

/** Each caller can abandon a shared read-only connection without cancelling its peers. */
export async function connectWslProject(
  path: string,
  signal?: AbortSignal,
  refresh = false,
): Promise<string> {
  signal?.throwIfAborted();
  const key = `${pathKey(path)}:${refresh}`;
  let pending = pendingConnections.get(key);
  if (!pending) {
    pending = connectWslProjectRequest(path, refresh).finally(() => {
      if (pendingConnections.get(key) === pending) pendingConnections.delete(key);
    });
    pendingConnections.set(key, pending);
  }
  const canonical = await pending;
  signal?.throwIfAborted();
  return canonical;
}

async function connectWslProjectRequest(path: string, refresh: boolean): Promise<string> {
  const location = wslLocation(path);
  if (!location)
    throw new Error("Choose a folder inside the selected WSL distribution");
  const host = location.distribution.toLowerCase();
  const request = Symbol();
  connectionRequests.set(host, request);
  let connected: { distribution: string; path: string; generation?: number };
  try {
    // Validating another folder on a live bridge is not a reconnect.
    const alive = wslStatusFor(host).state === "connected" &&
      await invoke<boolean>("wsl_connected", { distribution: location.distribution });
    if (connectionRequests.get(host) === request && (!alive || refresh))
      setWslStatus(location.distribution, { state: "connecting" });
    connected = await invoke<{
      distribution: string;
      path: string;
      generation?: number;
    }>("wsl_connect", refresh ? { ...location, refresh: true } : location);
  } catch (error) {
    // A missing folder must not take other projects on this distro offline.
    const alive = await invoke<boolean>("wsl_connected", {
      distribution: location.distribution,
    }).catch(() => false);
    if (connectionRequests.get(host) === request)
      setWslStatus(location.distribution, alive === true
        ? { state: "connected" }
        : { state: "error", error: String(error) });
    if (connectionRequests.get(host) === request) connectionRequests.delete(host);
    throw error;
  }
  const current = connectionRequests.get(host) === request;
  if (current) connectionRequests.delete(host);
  if (
    connected.distribution.toLowerCase() !== location.distribution.toLowerCase()
  ) {
    if (current) setWslStatus(connected.distribution, { state: "connected" });
    if (current) setWslStatus(location.distribution, {
      state: "error",
      error: "WSL returned a different distribution",
    });
    throw new Error(
      "WSL returned a different distribution; the project was not opened",
    );
  }
  if (current && (
    refresh ||
    connected.generation == null ||
    generations.get(host) !== connected.generation
  )) {
    invalidateWslDiscovery(path);
    if (generations.size >= 4)
      generations.delete(generations.keys().next().value!);
    if (connected.generation != null)
      generations.set(host, connected.generation);
  }
  if (current) setWslStatus(connected.distribution, { state: "connected" });
  return wslPath(connected.distribution, connected.path);
}
