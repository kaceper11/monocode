import type { ReactNode } from "react";
import type { OpenFileFn } from "../lib/search";

/**
 * Placeholder for the Extensions settings page — `SettingsView` imports it
 * from origin/main but the implementation is still uncommitted upstream.
 * Renders just the shared header so the section stays navigable.
 */
export function ExtensionsPage({
  header,
}: {
  cwd: string;
  onOpenFile?: OpenFileFn;
  header: ReactNode;
}) {
  return <>{header}</>;
}
