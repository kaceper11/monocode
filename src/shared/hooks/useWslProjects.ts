import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pickFolder } from "../../platform/tauri/fs";
import { pathKey, wslLocation } from "../lib/paths";
import { IS_WIN } from "../../platform/tauri/platform";
import { connectWslProject, invalidateWslDiscovery, wslDistributions, wslDistributionsPeek } from "../../features/sessions/model/wsl";
import { setWslStatus, useWslStatus, wslStatusFor } from "../../features/sessions/model/wslStatus";

/** Connect the selected execution host before entering upstream's project flow. */
export function useWslProjects(
  projectCwd: string,
  selectProjects: (paths: string[], allowBlankReuse?: boolean) => void,
  activeSessionId?: string,
) {
  const [wslOpening, setWslOpening] = useState<{
    path: string;
    busy: boolean;
    error?: string;
    /** Picks still waiting behind a failed connect — retry resumes there. */
    queue?: string[];
    /** Whether the resumed batch may still absorb a blank session. */
    blankReuse?: boolean;
    /** Reconnect an attached session without opening or retargeting it. */
    attached?: boolean;
  } | null>(null);
  const openingStatus = useWslStatus(wslLocation(wslOpening?.path ?? "")?.distribution);
  const wslOpenRequest = useRef<AbortController | null>(null);
  useEffect(() => () => wslOpenRequest.current?.abort(), []);
  const reconnectAttached = useCallback((path: string) => {
    wslOpenRequest.current?.abort();
    const controller = new AbortController();
    wslOpenRequest.current = controller;
    setWslOpening({ path, busy: true, attached: true });
    void connectWslProject(path, controller.signal)
      .then((canonical) => {
        if (controller.signal.aborted) return;
        if (pathKey(canonical) !== pathKey(path))
          throw new Error("This folder resolves to a different path. Choose it again from Open project.");
        setWslOpening(null);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setWslOpening({ path, busy: false, error: String(error), attached: true });
      })
      .finally(() => {
        if (wslOpenRequest.current === controller) wslOpenRequest.current = null;
      });
    return controller;
  }, []);
  useEffect(() => {
    // A partially opened batch owns its Retry queue until dismissed or resumed.
    if (wslOpening?.queue) return;
    if (!wslLocation(projectCwd)) {
      wslOpenRequest.current?.abort();
      setWslOpening(null);
      return;
    }
    reconnectAttached(projectCwd);
    return () => wslOpenRequest.current?.abort();
    // Connection-state changes do not retry interrupted work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectCwd, activeSessionId, reconnectAttached]);
  const projectCwdRef = useRef(projectCwd);
  projectCwdRef.current = projectCwd;
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<string>("wsl:disconnected", (event) => {
      if (disposed) return;
      const distribution = event.payload;
      // The emit fires for any failed request on the bridge's owner — a
      // request holding a stale bridge can report after a fresh bridge
      // already reconnected. Confirm before flagging the distro down.
      const statusBefore = wslStatusFor(distribution);
      void invoke<boolean>("wsl_connected", { distribution })
        .then((alive) => {
          if (disposed || wslStatusFor(distribution) !== statusBefore) return;
          // A connect in flight reports its own failure; don't pre-empt it.
          if (alive || wslStatusFor(distribution).state === "connecting")
            return;
          invalidateWslDiscovery(`//wsl.localhost/${distribution}/`);
          setWslStatus(distribution, {
            state: "disconnected",
            error: "WSL connection interrupted",
          });
          const path = projectCwdRef.current;
          if (
            wslLocation(path)?.distribution.toLowerCase() ===
            distribution.toLowerCase()
          )
            setWslOpening((current) =>
              current?.busy
                ? current
                : {
                    path,
                    busy: false,
                    attached: true,
                    error:
                      "WSL connection interrupted. Reconnect, then inspect any in-flight action before retrying it.",
                  },
            );
        })
        .catch(() => {
          if (disposed || wslStatusFor(distribution) !== statusBefore) return;
          if (wslStatusFor(distribution).state === "connecting") return;
          invalidateWslDiscovery(`//wsl.localhost/${distribution}/`);
          setWslStatus(distribution, {
            state: "disconnected",
            error: "WSL connection interrupted",
          });
        });
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);
  const onSelectProjects = useCallback(
    (paths: string[], allowBlankReuse = true) => {
      wslOpenRequest.current?.abort();
      if (!paths.length) return;
      const controller = new AbortController();
      wslOpenRequest.current = controller;
      void (async () => {
        const resolved: string[] = [];
        const remaining = [...paths];
        while (remaining.length && !controller.signal.aborted) {
          const path = remaining[0];
          if (!wslLocation(path)) {
            resolved.push(path);
            remaining.shift();
            continue;
          }
          setWslOpening({ path, busy: true });
          try {
            resolved.push(await connectWslProject(path, controller.signal));
          } catch (error) {
            if (controller.signal.aborted) return;
            // Keep the progress already made; the rest waits behind Retry.
            if (resolved.length) selectProjects(resolved, allowBlankReuse);
            setWslOpening({
              path,
              busy: false,
              error: String(error),
              queue: remaining,
              blankReuse: allowBlankReuse && resolved.length === 0,
            });
            return;
          }
          remaining.shift();
        }
        if (controller.signal.aborted) return;
        setWslOpening(null);
        selectProjects(resolved, allowBlankReuse);
      })();
    },
    [selectProjects],
  );
  const onSelectProject = useCallback(
    (path: string) => onSelectProjects([path]),
    [onSelectProjects],
  );

  const [wslPickerOpen, setWslPickerOpen] = useState(false);
  const pickProject = useCallback(async () => {
    if (IS_WIN) {
      // A failed probe can't prove WSL is absent — the last known list still
      // justifies the host dialog; nothing to choose means the folder picker.
      const distributions = await wslDistributions().catch(
        () => wslDistributionsPeek() ?? [],
      );
      if (distributions.length) {
        setWslPickerOpen(true);
        return;
      }
    }
    const paths = await pickFolder();
    if (paths) onSelectProjects(paths);
  }, [onSelectProjects]);


  return { onSelectProject, onSelectProjects, pickProject, wslPickerOpen,
    closePicker: () => setWslPickerOpen(false),
    // Keep warm path validation out of the layout; genuine connects and errors
    // still expose progress, cancellation and recovery through the same banner.
    wslOpening: wslOpening?.busy && openingStatus.state === "connected" ? null : wslOpening,
    retryOpening: () => {
      if (!wslOpening) return;
      if (wslOpening.attached) reconnectAttached(wslOpening.path);
      else onSelectProjects(wslOpening.queue ?? [wslOpening.path], wslOpening.blankReuse ?? true);
    },
    dismissOpening: () => { wslOpenRequest.current?.abort(); setWslOpening(null); },
  };
}
