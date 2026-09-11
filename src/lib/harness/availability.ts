import { wslLocation } from "../paths";
import type { HarnessId } from "../session";
import { HARNESSES } from "../session";
import {
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveCursorBinary,
  resolveDevinBinary,
  resolveFxBinary,
  resolveGrokBinary,
  resolveOmpBinary,
  resolveOpenCodeBinary,
  resolvePiBinary,
  resolveWslAgents,
} from "./child";
import { isLiveHarness } from "./registry";

export type HarnessAvailability = Record<HarnessId, boolean>;

/**
 * Availability only means the binary exists; authentication is reported
 * separately so an installed but signed-out provider is not mislabelled as
 * missing. A missing auth signal means the provider's credential location is
 * unknown, not that it is signed out.
 */
const CLI: Record<HarnessId, { name: string; install?: string }> = {
  claude: { name: "Claude Code CLI" },
  codex: { name: "Codex CLI" },
  cursor: { name: "Cursor CLI" },
  grok: {
    name: "Grok Build CLI",
    install: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
  opencode: { name: "OpenCode CLI" },
  pi: { name: "Pi CLI", install: "npm i -g @earendil-works/pi-coding-agent" },
  omp: { name: "omp CLI", install: "curl -fsSL https://omp.sh/install | sh" },
  fx: { name: "fx CLI", install: "curl -fsSL https://fx.sh/setup.sh | bash" },
  devin: { name: "Devin CLI" },
};

const emptyAvailability: HarnessAvailability = {
  claude: false,
  codex: false,
  cursor: false,
  grok: false,
  opencode: false,
  pi: false,
  omp: false,
  fx: false,
  devin: false,
};
const SIGN_IN: Partial<Record<HarnessId, string>> = {
  claude: "claude auth login",
  codex: "codex login",
  cursor: "agent login",
  grok: "grok login",
  fx: "fx login",
  devin: "devin auth login",
};

type Probe = {
  availability: HarnessAvailability;
  authenticated: Partial<Record<HarnessId, boolean>>;
  errors: Partial<Record<HarnessId, string>>;
  probedAt: number;
  inflight: Promise<void> | null;
};
const probes = new Map<string, Probe>();
function hostKey(cwd?: string): string {
  return cwd && wslLocation(cwd)
    ? `wsl:${wslLocation(cwd)!.distribution.toLowerCase()}`
    : "native";
}
let version = 0;
const listeners = new Set<() => void>();

/**
 * A probe stats ~100 paths across eight resolvers. The model picker and the
 * providers pane both probe on open, so without a TTL every open pays for it
 * again to learn what it already knows. Installing a CLI mid-session is rare,
 * and `force` covers it.
 */
const PROBE_TTL_MS = 30_000;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeHarnessAvailability(
  onStoreChange: () => void,
): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getHarnessAvailabilitySnapshot(): number {
  return version;
}

export function hasProbedHarnessAvailability(cwd?: string): boolean {
  return (probes.get(hostKey(cwd))?.probedAt ?? 0) > 0;
}

export function isHarnessAvailable(id: HarnessId, cwd?: string): boolean {
  return probes.get(hostKey(cwd))?.availability[id] ?? false;
}

export function invalidateHarnessAvailability(cwd: string) {
  probes.delete(hostKey(cwd));
  emit();
}

export function harnessProbeError(cwd?: string): string | undefined {
  return Object.values(probes.get(hostKey(cwd))?.errors ?? {}).find(Boolean);
}

export function harnessUnavailableHint(id: HarnessId, cwd?: string): string {
  const error = probes.get(hostKey(cwd))?.errors[id];
  if (error) return error;
  if (cwd && wslLocation(cwd)) {
    if (id === "opencode")
      return "OpenCode HTTP is not supported in WSL yet. Choose a stdio agent such as Claude or Codex.";
    return `${CLI[id].name} is unavailable in ${wslLocation(cwd)!.distribution}. Install its Linux CLI, reconnect WSL and retry.`;
  }
  const { name, install } = CLI[id];
  const how = install ? ` (\`${install}\`)` : "";
  return `${name} not found${how}. Install it, or restart MonoCode if it is already installed.`;
}

/** Sign-in guidance when the provider is installed but provably signed out. */
export function harnessAuthHint(id: HarnessId, cwd?: string): string | undefined {
  const location = cwd ? wslLocation(cwd) : undefined;
  if (probes.get(hostKey(cwd))?.authenticated[id] !== false) return undefined;
  const where = location ? ` in ${location.distribution}` : "";
  const command = SIGN_IN[id];
  const how = command
    ? `Run \`${command}\`${location ? " inside the distribution" : ""}, then refresh.`
    : `Sign in to the provider${where}, then refresh.`;
  return `${CLI[id].name} is installed${where} but not signed in. ${how}`;
}

export function probeHarnessAvailability(options?: {
  force?: boolean;
  cwd?: string;
}): Promise<void> {
  const key = hostKey(options?.cwd);
  let probe = probes.get(key);
  if (!probe) {
    // One native host plus four WSL distributions; discard only cached probes.
    if (probes.size >= 5) {
      const oldest = [...probes]
        .filter(([host, value]) => host !== "native" && !value.inflight)
        .sort((a, b) => a[1].probedAt - b[1].probedAt)[0];
      if (!oldest) return Promise.resolve();
      probes.delete(oldest[0]);
    }
    probe = {
      availability: { ...emptyAvailability },
      authenticated: {},
      errors: {},
      probedAt: 0,
      inflight: null,
    };
    probes.set(key, probe);
  }
  if (probe.inflight) return probe.inflight;
  if (
    !options?.force &&
    probe.probedAt > 0 &&
    Date.now() - probe.probedAt < PROBE_TTL_MS
  )
    return Promise.resolve();
  const current = probe;
  current.errors = {};
  current.authenticated = {};
  const finish = () => {
    current.probedAt = Date.now();
    current.inflight = null;
    emit();
  };
  const location = options?.cwd ? wslLocation(options.cwd) : undefined;
  if (options?.cwd && location) {
    const cwd = options.cwd;
    // One bridged round trip replaces eight serialized resolver requests.
    current.inflight = resolveWslAgents(cwd)
      .then((resolved) => {
        if (probes.get(key) !== current) return;
        for (const id of HARNESSES) {
          const entry = resolved[id];
          current.availability[id] = isLiveHarness(id) && Boolean(entry?.path);
          if (entry?.path) {
            if (entry.authenticated != null)
              current.authenticated[id] = entry.authenticated;
          } else {
            current.errors[id] =
              entry?.error ??
              `${CLI[id].name} is unavailable in ${location.distribution}.`;
          }
        }
      })
      .catch((error: unknown) => {
        if (probes.get(key) !== current) return;
        const message = String(error);
        for (const id of HARNESSES) {
          current.availability[id] = false;
          current.errors[id] = message;
        }
      })
      .finally(finish);
    return current.inflight;
  }
  const resolvers = {
    cursor: resolveCursorBinary,
    claude: resolveClaudeBinary,
    codex: resolveCodexBinary,
    opencode: resolveOpenCodeBinary,
    pi: resolvePiBinary,
    omp: resolveOmpBinary,
    fx: resolveFxBinary,
    grok: resolveGrokBinary,
    devin: resolveDevinBinary,
  };
  current.inflight = Promise.all(
    HARNESSES.map(async (id) => {
      if (!isLiveHarness(id)) return [id, false] as const;
      try {
        if (options?.cwd) await resolvers[id](options.cwd);
        else await resolvers[id]();
        return [id, true] as const;
      } catch (error) {
        current.errors[id] = String(error);
        return [id, false] as const;
      }
    }),
  )
    .then((entries) => {
      if (probes.get(key) !== current) return;
      current.availability = {
        ...emptyAvailability,
        ...Object.fromEntries(entries),
      };
    })
    .finally(finish);
  return current.inflight;
}
