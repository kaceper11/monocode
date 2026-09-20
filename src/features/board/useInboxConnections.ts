import { useEffect, useRef, useState } from "react";
import {
  AZUREDEVOPS_CHANGE_EVENT,
  azureDevOpsConnected,
} from "../inbox/model/azureDevOps";
import { JIRA_CHANGE_EVENT, atlassianCapable, jiraConnected } from "../sessions/model/jira";
import { LINEAR_CHANGE_EVENT, linearConnected } from "../inbox/model/linear";
import { GITLAB_CHANGE_EVENT, gitlabConnected } from "../inbox/model/gitlab";
import { githubStatus } from "../inbox/model/githubTasks";
import {
  loadInboxConnections,
  saveInboxConnections,
  type InboxSourceConnections,
} from "../inbox/model/inboxFilters";

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
        azureDevOpsConnected(),
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
          azuredevops:
            azure.status === "fulfilled"
              ? azure.value.connected
              : prev.azuredevops,
        }));
      });
    };
    read();
    const events = [
      LINEAR_CHANGE_EVENT,
      GITLAB_CHANGE_EVENT,
      JIRA_CHANGE_EVENT,
      AZUREDEVOPS_CHANGE_EVENT,
    ];
    for (const event of events) window.addEventListener(event, read);
    return () => {
      cancelled = true;
      for (const event of events) window.removeEventListener(event, read);
    };
  }, []);

  return connections;
}
