import { useCallback, useRef, useState, type SetStateAction } from "react";
import type { Session } from "../lib/session";

/** Submissions and provider events share the latest state before React renders. */
export function useSessionState(initial: () => Session[]) {
  const [sessions, renderSessions] = useState(initial);
  const current = useRef(sessions);
  const setSessions = useCallback((update: SetStateAction<Session[]>) => {
    const next =
      typeof update === "function" ? update(current.current) : update;
    current.current = next;
    renderSessions(next);
  }, []);
  return [sessions, setSessions, current] as const;
}
