import { useEffect, useRef, useState } from "react";
import { AZURE_CHANGE_EVENT, azureConnected } from "../lib/azure";
import { JIRA_CHANGE_EVENT, atlassianCapable, jiraConnected } from "../lib/jira";
import { LINEAR_CHANGE_EVENT, linearConnected } from "../lib/linear";
import { GITLAB_CHANGE_EVENT, gitlabConnected } from "../lib/gitlab";
import { githubStatus } from "../lib/githubTasks";
import {
  loadInboxConnections,
  saveInboxConnections,
  type InboxSourceConnections,
} from "../lib/inboxFilters";

/**
 * The inbox's provider connection state, probed once per mount. The board
 * seeds from the same persisted answer so both surfaces show the same
 * sources; `null` (unprobed) stays visible until proven otherwise.
 */
export function useInboxConnections(): InboxSourceConnections {
  const [connections, setConnections] = useState(loadInboxConnections);
  // Persist probe results only — writing the just-loaded value back on
  // mount would be a no-op write.
  const probed = useRef(false);

  useEffect(() => {
    if (probed.current) saveInboxConnections(connections);
  }, [connections]);

  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    const read = () => {
      const generation = ++latest;
      void Promise.allSettled([
        githubStatus(),
        linearConnected(),
        gitlabConnected(),
        jiraConnected(),
        azureConnected(),
      ]).then(([github, linear, gitlab, jira, azure]) => {
        if (cancelled || generation !== latest) return;
        probed.current = true;
        setConnections((prev) => ({
          github:
            github.status === "fulfilled" ? github.value.connected : prev.github,
          linear:
            linear.status === "fulfilled" ? linear.value.connected : prev.linear,
          gitlab:
            gitlab.status === "fulfilled" ? gitlab.value.connected : prev.gitlab,
          jira:
            jira.status === "fulfilled"
              ? jira.value.connected && atlassianCapable(jira.value, "Jira")
              : prev.jira,
          azure:
            azure.status === "fulfilled" ? azure.value.connected : prev.azure,
        }));
      });
    };
    read();
    const events = [
      LINEAR_CHANGE_EVENT,
      GITLAB_CHANGE_EVENT,
      JIRA_CHANGE_EVENT,
      AZURE_CHANGE_EVENT,
    ];
    for (const event of events) window.addEventListener(event, read);
    return () => {
      cancelled = true;
      for (const event of events) window.removeEventListener(event, read);
    };
  }, []);

  return connections;
}
