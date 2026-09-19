import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pickFolder } from "../lib/fs";
import { wslLocation } from "../lib/paths";
import { IS_WIN } from "../lib/platform";
import { connectWslProject, invalidateWslDiscovery, wslDistributions } from "../lib/wsl";
import { setWslStatus, wslStatusFor } from "../lib/wslStatus";

/** Connect the selected execution host before entering upstream's project flow. */
export function useWslProjects(projectCwd: string, selectProject: (path: string) => void) {
  const [wslOpening, setWslOpening] = useState<{
    path: string;
    busy: boolean;
    error?: string;
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
  const onSelectProject = useCallback(
    (path: string) => {
      wslOpenRequest.current?.abort();
      if (!wslLocation(path)) {
        setWslOpening(null);
        selectProject(path);
        return;
      }
      const controller = new AbortController();
      wslOpenRequest.current = controller;
      setWslOpening({ path, busy: true });
      void connectWslProject(path, controller.signal)
        .then((canonical) => {
          if (controller.signal.aborted) return;
          setWslOpening(null);
          selectProject(canonical);
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setWslOpening({ path, busy: false, error: String(error) });
        });
    },
    [selectProject],
  );

  const [wslPickerOpen, setWslPickerOpen] = useState(false);
  const pickProject = useCallback(async () => {
    if (IS_WIN) {
      // Only a successful empty probe skips the dialog — a failure can't
      // prove WSL is absent, so the dialog opens for its error and retry.
      const distributions = await wslDistributions().catch(() => null);
      if (distributions === null || distributions.length) {
        setWslPickerOpen(true);
        return;
      }
    }
    const path = await pickFolder();
    if (path) onSelectProject(path);
  }, [onSelectProject]);


  return { onSelectProject, pickProject, wslPickerOpen,
    closePicker: () => setWslPickerOpen(false),
    wslOpening,
    dismissOpening: () => { wslOpenRequest.current?.abort(); setWslOpening(null); },
  };
}
