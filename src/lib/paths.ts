import { IS_WIN } from "./platform";

function windowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

export function slash(path: string): string {
  const normalized =
    windowsPath(path) || (IS_WIN && !path.startsWith("/"))
      ? path.replace(/\\/g, "/")
      : path;
  return normalized
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/(?:wsl\$|wsl\.localhost)\//i, "//wsl.localhost/");
}

export function wslLocation(
  path: string,
): { distribution: string; path: string } | undefined {
  const match = /^\/\/wsl\.localhost\/([^/]+)(\/.*)?$/i.exec(slash(path));
  return match ? { distribution: match[1], path: match[2] || "/" } : undefined;
}

/** Build an explicit Linux identity; never reinterpret a Windows path as Linux. */
export function wslPath(distribution: string, path: string): string {
  if (
    !distribution ||
    distribution.length > 128 ||
    /^-/.test(distribution) ||
    /[/\\:\x00-\x1f\x7f]/.test(distribution)
  )
    throw new Error("Choose a named WSL distribution");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 4096 ||
    /[\\\x00-\x1f\x7f]/.test(path) ||
    path.split("/").includes("..")
  )
    throw new Error(
      "Choose an absolute Linux path without parent traversal or backslashes",
    );
  return `//wsl.localhost/${distribution}/${path
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/")}`;
}

function trimSlash(path: string): string {
  return slash(path).replace(/\/+$/, "") || "/";
}

/** Stable comparison key for Windows paths without changing their display case. */
export function pathKey(path: string): string {
  const normalized = trimSlash(path);
  const wsl = wslLocation(normalized);
  if (wsl)
    return `//wsl.localhost/${wsl.distribution.toLowerCase()}${wsl.path === "/" ? "" : wsl.path}`;
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function prettyCwd(cwd: string): string {
  const trimmed = trimSlash(cwd);
  const wsl = wslLocation(trimmed);
  if (wsl) return `WSL · ${wsl.distribution} · ${wsl.path}`;
  if (trimmed === "~") return "~";

  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "Users" || parts[0] === "home")) {
    const rest = parts.slice(2).join("/");
    return rest ? `~/${rest}` : "~";
  }
  if (
    parts.length >= 3 &&
    /^[A-Za-z]:$/.test(parts[0]) &&
    parts[1] === "Users"
  ) {
    const rest = parts.slice(3).join("/");
    return rest ? `~/${rest}` : "~";
  }
  return trimmed;
}

export function parentPath(path: string): string {
  const trimmed = trimSlash(path);
  if (/^\/\/[^/]+\/[^/]+$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`;
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return "/";
  const parent = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
  return parent;
}

export function rebasePath(path: string, from: string, to: string): string {
  const normalized = trimSlash(path);
  const source = trimSlash(from);
  const dest = trimSlash(to);
  const key = pathKey(normalized);
  const sourceKey = pathKey(source);
  if (key === sourceKey) return /^[A-Za-z]:$/.test(dest) ? `${dest}/` : dest;
  if (key.startsWith(`${sourceKey}/`)) {
    return `${dest}${normalized.slice(source.length)}`;
  }
  return slash(path);
}

export function isEqualOrInside(path: string, root: string): boolean {
  const normalized = trimSlash(path);
  const base = trimSlash(root);
  const key = pathKey(normalized);
  const baseKey = pathKey(base);
  return key === baseKey || key.startsWith(`${baseKey}/`);
}

export function joinPath(parent: string, relative: string): string {
  const base = trimSlash(parent);
  const parts = relative
    .split(windowsPath(parent) ? /[/\\]/ : /\//)
    .filter((part) => part && part !== ".");
  let out = base;
  for (const part of parts) {
    if (part === "..") {
      out = parentPath(out);
      continue;
    }
    out = out === "/" ? `/${part}` : `${out}/${part}`;
  }
  return out;
}

/** Absolute path for a workspace file href, or `undefined` if it is not a local file. */
export function resolveWorkspacePath(
  href: string,
  cwd?: string,
  knownFile = false,
): string | undefined {
  return parseWorkspaceFileReference(href, cwd, false, knownFile)?.path;
}

/** Keep source positions while resolving a local Markdown file reference. */
export function resolveWorkspaceFileReference(
  href: string,
  cwd?: string,
): { path: string; navigation?: { line: number; column?: number } } | undefined {
  return parseWorkspaceFileReference(href, cwd, true);
}

function parseWorkspaceFileReference(
  href: string,
  cwd: string | undefined,
  decodeUrl: boolean,
  knownFile = false,
) {
  let value = href.trim();
  if (!value) return undefined;

  // Strip heading anchors before decoding, keeping encoded '#' in filenames.
  if (decodeUrl) {
    const hash = value.indexOf("#");
    if (hash > 0 && !/^L\d+(?:-L\d+)?$/.test(value.slice(hash + 1)))
      value = value.slice(0, hash);
  }
  const location = value.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:-L\d+)?)$/);
  const line = Number(location?.[1] ?? location?.[3]);
  const column = location?.[2] ? Number(location[2]) : undefined;
  const navigation =
    Number.isSafeInteger(line) && line > 0
      ? { line, ...(column && Number.isSafeInteger(column) ? { column } : {}) }
      : undefined;
  if (location) value = value.slice(0, location.index);

  const fileUrl = value.startsWith("file://");
  if (fileUrl) {
    value = value.slice("file://".length);
    if (value.startsWith("localhost/")) value = value.slice("localhost".length);
  }
  if (decodeUrl || fileUrl) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // A literal percent sign is valid in a local filename.
    }
  }

  if (cwd && wslLocation(cwd) && value.includes("\\") && !windowsPath(value))
    return undefined;
  value = slash(value);
  // File URLs can also decode to UNC paths. Windows accepts mixed separators.
  if ((decodeUrl || fileUrl) && /^[\\/]{2}/.test(value)) return undefined;
  // A bare filename's :line[:column] suffix must be removed before this check.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:\//.test(value))
    return undefined;
  if (!value || value === "." || value.startsWith("#") || value.startsWith("?") || value.includes("://")) {
    return undefined;
  }
  if (!knownFile && !looksLikeFilePath(value)) return undefined;

  if (/^[A-Za-z]:\//.test(value)) return { path: value, navigation };
  if (value.startsWith("/")) {
    const wsl = cwd ? wslLocation(cwd) : undefined;
    if (wsl && !value.startsWith("//") && !/^\/[A-Za-z]:\//.test(value)) {
      try {
        return { path: wslPath(wsl.distribution, value), navigation };
      } catch {
        return undefined;
      }
    }
    return {
      path: /^\/[A-Za-z]:\//.test(value) ? value.slice(1) : value,
      navigation,
    };
  }
  if (!cwd || cwd === "~")
    return knownFile
      ? { path: cwd ? joinPath(cwd, value) : value, navigation }
      : undefined;
  return { path: joinPath(cwd, value), navigation };
}

export function isExtensionlessFileName(value: string): boolean {
  return /^(dockerfile|makefile|gemfile|license)$/i.test(value);
}

function looksLikeFilePath(value: string): boolean {
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return true;
  if (value.includes("/")) return true;
  return isExtensionlessFileName(value) ||
    /\.[A-Za-z][A-Za-z0-9+]{0,11}$/.test(value);
}

export function prettyParent(path: string): string {
  return prettyCwd(parentPath(path));
}

/** Path relative to cwd when it lives under the project, otherwise unchanged. */
export function displayPath(path: string, cwd?: string): string {
  const normalized = trimSlash(path);
  const base = cwd ? trimSlash(cwd) : undefined;
  if (base && base !== "~") {
    const key = pathKey(normalized);
    const baseKey = pathKey(base);
    if (key === baseKey) {
      return normalized.split("/").filter(Boolean).pop() || normalized;
    }
    const prefix = `${base}/`;
    if (key.startsWith(`${baseKey}/`)) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}

/** Folder name for tab labels — `~` when the cwd is home. */
export function projectName(cwd: string): string {
  if (!cwd || prettyCwd(cwd) === "~") return "~";
  const trimmed = trimSlash(cwd);
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed;
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * Identity for a project's saved appearance and data. Folder names repeat across
 * checkouts (`cortex/agentbase` and `cortex-finance/agentbase`), so the whole
 * path is the key — `projectName` is for display only.
 */
export function projectKey(cwd: string): string {
  return pathKey(cwd);
}
