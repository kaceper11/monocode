import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { clearInboxCache } from "../../inbox/model/githubTasks";
import {
  atlassianCapable,
  effectiveHiddenJiraProjects,
  loadJiraFilter,
  saveJiraFilter,
  disconnectJira,
  JIRA_CHANGE_EVENT,
  jiraConnected,
  listJiraProjects,
  loadHiddenJiraProjectIds,
  notifyJiraChange,
  saveHiddenJiraProjectIds,
  saveJiraConfig,
  type JiraProject,
  type JiraStatus,
} from "../../inbox/model/jira";

export function JiraSettings() {
  const operation = useRef(0);
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [hiddenIds, setHiddenIds] = useState(loadHiddenJiraProjectIds);

  const loadProjects = useCallback(async () => {
    const current = operation.current;
    try {
      const projects = await listJiraProjects();
      if (current === operation.current) setProjects(projects);
    } catch (err) {
      if (current !== operation.current) return;
      setProjects([]);
      setError(String(err instanceof Error ? err.message : err));
    }
  }, []);

  useEffect(() => {
    const refresh = () => {
      const current = ++operation.current;
      setChecking(true);
      setStatus(null);
      setProjects([]);
      setToken("");
      void jiraConnected()
        .then(async (next) => {
          if (current !== operation.current) return;
          setStatus(next);
          setError(null);
          if (next.connected && atlassianCapable(next, "Jira"))
            await loadProjects();
        })
        .catch((err: unknown) => {
          if (current === operation.current) setError(String(err));
        })
        .finally(() => {
          if (current === operation.current) {
            setChecking(false);
            setBusy(false);
          }
        });
    };
    refresh();
    const onChange = (event: Event) => {
      setHiddenIds(loadHiddenJiraProjectIds());
      if (event instanceof CustomEvent && event.detail === "connection")
        refresh();
    };
    window.addEventListener(JIRA_CHANGE_EVENT, onChange);
    return () => {
      operation.current++;
      window.removeEventListener(JIRA_CHANGE_EVENT, onChange);
    };
  }, [loadProjects]);

  const connect = async () => {
    if (busy || checking || !site.trim() || !email.trim() || !token.trim())
      return;
    setBusy(true);
    setError(null);
    try {
      const next = await saveJiraConfig({ site, email, token });
      setStatus(next);
      setToken("");
      clearInboxCache();
      saveHiddenJiraProjectIds([]);
      if (atlassianCapable(next, "Jira")) await loadProjects();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await disconnectJira());
      setProjects([]);
      setToken("");
      clearInboxCache();
      notifyJiraChange();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const legacyFilter = loadJiraFilter(status?.site ?? "");
  const effectiveHiddenIds = effectiveHiddenJiraProjects(
    projects,
    hiddenIds,
    legacyFilter.project,
  );

  return (
    <div className="px-4 py-3.5">
      {checking ? (
        <p className="text-[12px] text-content/45">Checking Jira connection…</p>
      ) : status?.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-[12px] text-content/65">
            <p className="break-all">{status.site}</p>
            <p className="break-all">{status.email || status.account}</p>
            <p>{status.capabilities?.join(" · ")}</p>
          </div>
          <SecondaryButton onClick={() => void disconnect()} disabled={busy}>
            {busy ? "Disconnecting" : "Disconnect"}
          </SecondaryButton>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-[12px] leading-relaxed text-content/45">
            Connect Jira and Confluence on your Atlassian Cloud site using your
            email and an API token without scopes. Disconnect deletes the saved
            credentials.
          </p>
          {(
            [
              {
                label: "Jira site",
                value: site,
                set: setSite,
                type: "text",
                placeholder: "yourteam.atlassian.net",
              },
              {
                label: "Atlassian email",
                value: email,
                set: setEmail,
                type: "email",
                placeholder: "you@example.com",
              },
              {
                label: "Jira API token",
                value: token,
                set: setToken,
                type: "password",
                placeholder: "API token",
              },
            ] as const
          ).map((field) => (
            <label
              key={field.label}
              className="flex flex-col gap-1 text-[12px] text-content/65"
            >
              {field.label}
              <input
                aria-label={field.label}
                type={field.type}
                value={field.value}
                onChange={(event) => field.set(event.target.value)}
                placeholder={field.placeholder}
                disabled={busy}
                required
                autoComplete="off"
                spellCheck={false}
                className="h-8 w-full rounded-md border border-content/10 bg-transparent px-2 text-content outline-none focus:border-content/20"
              />
            </label>
          ))}
          <div className="flex items-center gap-3">
            <SecondaryButton
              type="submit"
              disabled={busy || !site.trim() || !email.trim() || !token.trim()}
            >
              {busy ? "Connecting" : "Connect"}
            </SecondaryButton>
            <button
              type="button"
              onClick={() =>
                void openUrl(
                  "https://id.atlassian.com/manage-profile/security/api-tokens",
                )
              }
              className="text-[12px] text-content/65 hover:text-content"
            >
              Create API token
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-[12px] text-red-400/90">
          {error}
        </p>
      ) : null}
      {status?.connected && atlassianCapable(status, "Jira") ? (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-content">
              Projects
            </span>
            <SecondaryButton
              disabled={busy || checking}
              onClick={() => void loadProjects()}
            >
              Refresh projects
            </SecondaryButton>
          </div>
          <p className="text-[12px] text-content/45">
            Unchecked projects stay out of the inbox.
          </p>
          {projects.map((project) => (
            <label
              key={project.id}
              className="flex items-center gap-2 text-[13px] text-content"
            >
              <input
                type="checkbox"
                checked={!effectiveHiddenIds.includes(project.id)}
                disabled={busy}
                onChange={() => {
                  const next = effectiveHiddenIds.includes(project.id)
                    ? effectiveHiddenIds.filter((id) => id !== project.id)
                    : [...effectiveHiddenIds, project.id];
                  if (legacyFilter.project)
                    saveJiraFilter(status.site, {
                      ...legacyFilter,
                      project: "",
                    });
                  clearInboxCache();
                  saveHiddenJiraProjectIds(next);
                }}
              />
              {project.name}{" "}
              <span className="text-content/40">{project.key}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
