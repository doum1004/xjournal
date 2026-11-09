// The secret store (spec §8.7, §11.3). Connector credentials live here, never in the
// database: `connector_accounts.secret_ref` holds only a pointer. Locally that's the OS
// credential store (Windows Credential Manager, macOS Keychain, libsecret); a managed vault
// takes its place in hosted mode.

export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  /** Returns whether a secret was there to delete. */
  delete(ref: string): Promise<boolean>;
}

/** The secret-store pointer for a connector account. */
export const connectorSecretRef = (connectorAccountId: string) => `connector/${connectorAccountId}`;

/** The OS credential store, through `Bun.secrets`. Entries are named `<service>/<ref>`. */
export function osKeychain(service = 'xjournal'): SecretStore {
  return {
    async get(ref) {
      return (await Bun.secrets.get({ service, name: ref })) ?? null;
    },
    async set(ref, value) {
      await Bun.secrets.set({ service, name: ref, value });
    },
    async delete(ref) {
      return Bun.secrets.delete({ service, name: ref });
    },
  };
}

/** An in-process store, for tests. */
export function memorySecrets(initial: Record<string, string> = {}): SecretStore & {
  entries(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    async get(ref) {
      return map.get(ref) ?? null;
    },
    async set(ref, value) {
      map.set(ref, value);
    },
    async delete(ref) {
      return map.delete(ref);
    },
    entries: () => Object.fromEntries(map),
  };
}

/**
 * Replace every occurrence of `secrets` in `text`, so a credential echoed back in an error
 * message never reaches the database or a log (spec §11.3).
 */
export function redact(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out;
}
