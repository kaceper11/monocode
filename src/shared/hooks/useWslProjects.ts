import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pickFolder } from "../../platform/tauri/fs";
import { wslLocation } from "../lib/paths";
import { IS_WIN } from "../../platform/tauri/platform";
import { connectWslProject, invalidateWslDiscovery, wslDistributions, wslDistributionsPeek } from "../../features/sessions/model/wsl";
import { setWslStatus, wslStatusFor } from "../../features/sessions/model/wslStatus";

/** Connect the selected execution host before entering upstream's project flow. */
export function useWslProjects(
  projectCwd: string,
  selectProjects: (paths: string[], allowBlankReuse?: boolean) => void,
) {
  const [wslOpening, setWslOpening] = useState<{
    path: string;
    busy: boolean;
    error?: string;
    /** Picks still waiting behind a failed connect — retry resumes there. */
    queue?: string[];
    /** Whether the resumed batch may still absorb a blank session. */
    blankReuse?: boolean;
  } | null>(null);
  const wslOpenRequest = useRef<AbortController | null>(null);
  useEffect(() => () => wslOpenRequest.current?.abort(), []);
  useEffect(() => {
    const location = wslLocation(projectCwd);
    if (!location) return;
    let disposed = false;
    const openingAtStart = wslOpenRequest.current;
    // Publish the probe only when nothing fresher landed meanwhile — a
    // connect started (or finished) during the probe outranks its result.
    const statusBefore = wslStatusFor(location.distribution);
    void invoke<boolean>("wsl_connected", {
      distribution: location.distribution,
    })
      .then((connected) => {
        if (disposed || wslStatusFor(location.distribution) !== statusBefore) return;
        setWslStatus(location.distribution, {
          state: connected ? "connected" : "disconnected",
        });
        if (
          !disposed &&
          wslOpenRequest.current === openingAtStart &&
          !connected
        )
          setWslOpening(
            (current) =>
              current ?? {
                path: projectCwd,
                busy: false,
                error:
                  "Reconnect WSL to access this project. Windows execution will not be used.",
              },
          );
      })
      .catch((error) => {
        if (disposed || wslStatusFor(location.distribution) !== statusBefore) return;
        setWslStatus(location.distribution, {
          state: "error",
          error: String(error),
        });
        if (!disposed && wslOpenRequest.current === openingAtStart)
          setWslOpening(
            (current) =>
              current ?? {
                path: projectCwd,
                busy: false,
                error: String(error),
              },
          );
      });
    return () => {
      disposed = true;
    };
  }, [projectCwd]);
  const projectCwdRef = useRef(projectCwd);
  projectCwdRef.current = projectCwd;
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<string>("wsl:disconnected", (event) => {
      if (disposed) return;
      const distribution = event.payload;
      invalidateWslDiscovery(`//wsl.localhost/${distribution}/`);
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
                    error:
                      "WSL connection interrupted. Reconnect, then inspect any in-flight action before retrying it.",
                  },
            );
        })
        .catch(() => {
          if (disposed || wslStatusFor(distribution) !== statusBefore) return;
          if (wslStatusFor(distribution).state === "connecting") return;
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
    wslOpening,
    dismissOpening: () => { wslOpenRequest.current?.abort(); setWslOpening(null); },
  };
}
