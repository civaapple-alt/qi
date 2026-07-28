import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SecureCredentialRecord,
  SecureCredentialStore,
} from "@civaapple/qi-agent/capability";

export type {
  SecureCredentialRecord,
  SecureCredentialStore,
} from "@civaapple/qi-agent/capability";

interface SealedFile {
  version: 1;
  records: Record<string, {
    provider: string;
    alias: string;
    authKind: "api-key" | "oauth";
    expiresAt?: string;
    metadata?: Record<string, string>;
    iv: string;
    tag: string;
    ciphertext: string;
  }>;
}

/**
 * AES-256-GCM sealed credential file under QI_HOME.
 * Secrets never appear in TOML or Session events; the master key stays in a sibling key file.
 */
export class EncryptedFileCredentialStore implements SecureCredentialStore {
  readonly #path: string;
  readonly #keyPath: string;

  constructor(qiHome: string) {
    this.#path = join(qiHome, "credentials", "store.json");
    this.#keyPath = join(qiHome, "credentials", "master.key");
  }

  async list(): Promise<readonly Omit<SecureCredentialRecord, "secret">[]> {
    const file = await this.#read();
    return Object.entries(file.records).map(([accountId, record]) => ({
      accountId,
      provider: record.provider,
      alias: record.alias,
      authKind: record.authKind,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    }));
  }

  async get(accountId: string): Promise<SecureCredentialRecord | undefined> {
    const file = await this.#read();
    const record = file.records[accountId];
    if (!record) return undefined;
    const key = await this.#loadKey();
    const secret = decrypt(key, record.iv, record.tag, record.ciphertext);
    return {
      accountId,
      provider: record.provider,
      alias: record.alias,
      authKind: record.authKind,
      secret,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    };
  }

  async set(record: SecureCredentialRecord): Promise<void> {
    if (!record.accountId || !record.secret) throw new TypeError("accountId and secret are required");
    const file = await this.#read();
    const key = await this.#loadKey();
    const sealed = encrypt(key, record.secret);
    file.records[record.accountId] = {
      provider: record.provider,
      alias: record.alias,
      authKind: record.authKind,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      ...(record.metadata === undefined ? {} : { metadata: { ...record.metadata } }),
      ...sealed,
    };
    await this.#write(file);
  }

  async delete(accountId: string): Promise<boolean> {
    const file = await this.#read();
    if (!file.records[accountId]) return false;
    delete file.records[accountId];
    await this.#write(file);
    return true;
  }

  async #read(): Promise<SealedFile> {
    try {
      const raw = JSON.parse(await readFile(this.#path, "utf8")) as SealedFile;
      if (raw.version !== 1 || typeof raw.records !== "object" || raw.records === null) {
        throw new TypeError(`Invalid sealed credential file: ${this.#path}`);
      }
      return { version: 1, records: raw.records };
    } catch (error) {
      if (isMissing(error)) {
        const empty: SealedFile = { version: 1, records: {} };
        await this.#loadKey();
        await this.#write(empty);
        return empty;
      }
      throw error;
    }
  }

  async #write(file: SealedFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.#path, 0o600).catch(() => undefined);
  }

  async #loadKey(): Promise<Buffer> {
    try {
      const existing = await readFile(this.#keyPath);
      if (existing.byteLength >= 32) return existing.subarray(0, 32);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const key = randomBytes(32);
    await mkdir(dirname(this.#keyPath), { recursive: true });
    await writeFile(this.#keyPath, key, { mode: 0o600 });
    await chmod(this.#keyPath, 0o600).catch(() => undefined);
    return key;
  }
}

function encrypt(key: Buffer, plaintext: string): { iv: string; tag: string; ciphertext: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(key: Buffer, iv: string, tag: string, ciphertext: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
