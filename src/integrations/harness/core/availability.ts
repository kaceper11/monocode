import type { HarnessId } from "../../../features/sessions/model/session";
import { HARNESSES } from "../../../features/sessions/model/session";
import {
  resolveAntigravityBinary,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveCursorBinary,
  resolveCopilotBinary,
  resolveDevinBinary,
  resolveFxBinary,
  resolveGrokBinary,
  resolveHermesBinary,
  resolveMuseBinary,
  resolveOmpBinary,
  resolveOpenCodeBinary,
  resolvePiBinary,
} from "./child";
import { isLiveHarness } from "./registry";
import {
  emitHarnessAvailability,
  markHarnessAvailabilityProbed,
  setHarnessAvailability,
  type HarnessAvailability,
} from "./availabilityState";

export type { HarnessAvailability } from "./availabilityState";
export {
  getHarnessAvailabilitySnapshot,
  subscribeHarnessAvailability,
} from "./availabilityState";

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
  hermes: {
    name: "Hermes Agent CLI",
    install:
      "Install from hermes-agent.nousresearch.com, then run hermes model",
  },
  devin: { name: "Devin CLI" },
  copilot: {
    name: "GitHub Copilot CLI",
    install: "npm i -g @github/copilot",
  },
  muse: { name: "Muse CLI" },
  antigravity: { name: "Antigravity ACP server (agy_acp_server.par)" },
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
  hermes: false,
  devin: false,
  copilot: false,
  muse: false,
  antigravity: false,
};
const SIGN_IN: Partial<Record<HarnessId, string>> = {
  claude: "claude auth login",
  codex: "codex login",
  cursor: "agent login",
  grok: "grok login",
  fx: "fx login",
  devin: "devin auth login",
  copilot: "copilot login",
  muse: "muse auth set --api-key-stdin",
};

type Probe = {
  availability: HarnessAvailability;
  authenticated: Partial<Record<HarnessId, boolean>>;
  errors: Partial<Record<HarnessId, string>>;
  probedAt: number;
  inflight: Promise<void> | null;
};
const probe: Probe = {
  availability: { ...emptyAvailability },
  authenticated: {},
  errors: {},
  probedAt: 0,
  inflight: null,
};

/**
 * A probe stats ~100 paths across the per-provider resolvers. The model picker and the
 * providers pane both probe on open, so without a TTL every open pays for it
 * again to learn what it already knows. Installing a CLI mid-session is rare,
 * and `force` covers it.
 */
const PROBE_TTL_MS = 30_000;

export function hasProbedHarnessAvailability(): boolean {
  return probe.probedAt > 0;
}

export function isHarnessAvailable(id: HarnessId): boolean {
  return probe.availability[id] ?? false;
}

export function invalidateHarnessAvailability() {
  probe.probedAt = 0;
  emitHarnessAvailability();
}

export function harnessProbeError(): string | undefined {
  return Object.values(probe.errors).find(Boolean);
}

export function harnessUnavailableHint(id: HarnessId): string {
  const error = probe.errors[id];
  if (error) return error;
  const { name, install } = CLI[id];
  const how = install ? ` (\`${install}\`)` : "";
  return `${name} not found${how}. Install it, or restart MonoCode if it is already installed.`;
}

/** Sign-in guidance when the provider is installed but provably signed out. */
export function harnessAuthHint(id: HarnessId): string | undefined {
  if (probe.authenticated[id] !== false) return undefined;
  const command = SIGN_IN[id];
  const how = command
    ? `Run \`${command}\`, then refresh.`
    : `Sign in to the provider, then refresh.`;
  return `${CLI[id].name} is installed but not signed in. ${how}`;
}

export function probeHarnessAvailability(options?: {
  force?: boolean;
}): Promise<void> {
  if (probe.inflight) return probe.inflight;
  if (
    !options?.force &&
    probe.probedAt > 0 &&
    Date.now() - probe.probedAt < PROBE_TTL_MS
  )
    return Promise.resolve();
  probe.errors = {};
  probe.authenticated = {};
  const resolvers: Record<HarnessId, () => Promise<unknown>> = {
    cursor: resolveCursorBinary,
    claude: resolveClaudeBinary,
    codex: resolveCodexBinary,
    opencode: resolveOpenCodeBinary,
    pi: resolvePiBinary,
    omp: resolveOmpBinary,
    fx: resolveFxBinary,
    hermes: resolveHermesBinary,
    grok: resolveGrokBinary,
    devin: resolveDevinBinary,
    copilot: resolveCopilotBinary,
    muse: resolveMuseBinary,
    antigravity: resolveAntigravityBinary,
  };
  probe.inflight = Promise.all(
    HARNESSES.map(async (id) => {
      if (!isLiveHarness(id)) return [id, false] as const;
      try {
        await resolvers[id]();
        return [id, true] as const;
      } catch {
        return [id, false] as const;
      }
    }),
  )
    .then((entries) => {
      probe.availability = {
        ...emptyAvailability,
        ...Object.fromEntries(entries),
      };
    })
    .finally(() => {
      probe.probedAt = Date.now();
      probe.inflight = null;
      setHarnessAvailability(probe.availability);
      markHarnessAvailabilityProbed();
      emitHarnessAvailability();
    });
  return probe.inflight;
}
