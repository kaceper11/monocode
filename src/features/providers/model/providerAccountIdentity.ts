import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type {
  ProviderAccount,
  ProviderAccountProvider,
} from "./providerAccounts";

/** Identity the provider CLI cached on disk after sign-in. */
export type ProviderAccountIdentity = {
  email?: string | null;
  name?: string | null;
  plan?: string | null;
  organization?: string | null;
};

export async function readProviderAccountIdentity(
  provider: ProviderAccountProvider,
  accountId: string,
  cwd?: string,
): Promise<ProviderAccountIdentity | null> {
  try {
    return await invoke<ProviderAccountIdentity | null>(
      "provider_account_identity",
      { provider, accountId, ...(cwd ? { cwd } : {}) },
    );
  } catch {
    return null;
  }
}

/** Org chip text: "Personal" for Claude's default "<name>'s Organization". */
export function identityOrganizationTag(
  identity: ProviderAccountIdentity | null | undefined,
): string | null {
  const name = identity?.organization?.trim();
  if (!name) return null;
  return /['’]s Organization$/.test(name) ? "Personal" : name;
}

export function identityKey(account: ProviderAccount): string {
  return `${account.provider}:${account.id}`;
}

/**
 * Load identities for `accounts`, keyed by `identityKey`. Re-reads whenever
 * `refreshKey` changes.
 */
export function useProviderAccountIdentities(
  accounts: ProviderAccount[],
  refreshKey?: unknown,
  cwd?: string,
): Record<string, ProviderAccountIdentity | null> {
  const [state, setState] = useState<{ cwd?: string; identities: Record<string, ProviderAccountIdentity | null> }>({ identities: {} });
  const key = accounts.map(identityKey).join("|");

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      accounts.map(
        async (account) =>
          [
            identityKey(account),
            await readProviderAccountIdentity(account.provider, account.id, cwd),
          ] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setState({ cwd, identities: Object.fromEntries(entries) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey, cwd]);

  return state.cwd === cwd ? state.identities : {};
}
