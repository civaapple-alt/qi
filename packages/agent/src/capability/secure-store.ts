export interface SecureCredentialRecord {
  readonly accountId: string;
  readonly provider: string;
  readonly alias: string;
  readonly authKind: "api-key" | "oauth";
  readonly secret: string;
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Credential persistence port. Concrete encrypted storage belongs to qi-node. */
export interface SecureCredentialStore {
  list(): Promise<readonly Omit<SecureCredentialRecord, "secret">[]>;
  get(accountId: string): Promise<SecureCredentialRecord | undefined>;
  set(record: SecureCredentialRecord): Promise<void>;
  delete(accountId: string): Promise<boolean>;
}
