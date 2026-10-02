import { useEffect, useState } from "react";
import { invokeWorkspace as invoke } from "../../platform/tauri/fs";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";

export type TaskRemote = {
  name: string;
  url: string;
  preferred: boolean;
};
export function RemotePicker({
  cwd,
  branch,
  value,
  onChange,
  layer,
  disabled,
}: {
  cwd: string;
  branch: string;
  value?: string;
  onChange: (remote?: string) => void;
  layer?: number;
  disabled?: boolean;
}) {
  const [remotes, setRemotes] = useState<TaskRemote[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setRemotes([]);
    setError("");
    if (cwd)
      void invoke<TaskRemote[]>("task_delivery_remotes", { cwd, branch })
        .then((rows) => {
          if (active) setRemotes(Array.isArray(rows) ? rows : []);
        })
        .catch((reason) => {
          if (active) setError(String(reason));
        });
    return () => {
      active = false;
    };
  }, [cwd, branch]);
  const preferred = remotes.find((remote) => remote.preferred);
  return (
    <div className="min-w-0">
      <SearchableSelect
        label="Git remote"
        variant="row"
        value={value ?? ""}
        disabled={disabled || !cwd}
        layer={layer}
        onChange={(remote) => onChange(remote || undefined)}
        options={[
          {
            value: "",
            label: preferred ? `Default · ${preferred.name}` : "Choose remote…",
          },
          ...remotes.map((remote) => ({
            value: remote.name,
            label: `${remote.name} · ${remote.url}`,
          })),
          ...(value && !remotes.some((remote) => remote.name === value)
            ? [{ value, label: `${value} · unavailable` }]
            : []),
        ]}
      />
      {error && (
        <p
          role="alert"
          className="text-[11px] text-amber-700 dark:text-amber-300"
        >
          {error}
        </p>
      )}
    </div>
  );
}
