export const BROWSER_CONTEXT_ADDED = "monocode:browser-context-added";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AgentContext } from "./agentContext";
import type { HarnessId } from "./session";

export type BrowserContextTarget = {
  sessionId: string;
  cwd: string;
  harness: HarnessId;
  accept: (context: AgentContext) => void;
};
const targets = new Map<string, BrowserContextTarget>();
const listeners = new Set<() => void>();
let snapshot: readonly BrowserContextTarget[] = [];
function changed() {
  snapshot = [...targets.values()];
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function useBrowserContextTargets() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** An open composer accepts reviewed browser material as a draft, never a turn. */
export function useBrowserContextTarget(
  sessionId: string | undefined,
  cwd: string,
  harness: HarnessId,
  enabled: boolean,
  accept: (context: AgentContext) => void,
) {
  const current = useRef({ sessionId, cwd, harness, enabled, accept });
  current.current = { sessionId, cwd, harness, enabled, accept };
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const target: BrowserContextTarget = {
      sessionId, cwd, harness,
      accept: context => {
        const next = current.current;
        if (targets.get(sessionId) !== target || !next.enabled || next.sessionId !== sessionId || next.cwd !== cwd || next.harness !== harness)
          throw new Error("The conversation or execution host changed. Select the destination again.");
        next.accept(context);
      },
    };
    targets.set(sessionId, target);
    changed();
    return () => {
      if (targets.get(sessionId) === target) { targets.delete(sessionId); changed(); }
    };
  }, [sessionId, cwd, harness, enabled]);
}
