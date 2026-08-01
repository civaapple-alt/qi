import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  installProviderCatalogOverBuiltins,
  parseProviderCatalogDocument,
  resetProviderCatalog,
  type ProviderProfile,
} from "@civaapple/qi-ai";

/** `$QI_HOME/providers` — user overlays and custom providers (non-secret). */
export function defaultProviderCatalogDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory = homedir(),
): string {
  const explicit = optionalString(environment.QI_PROVIDERS);
  if (explicit !== undefined) return resolve(explicit);
  const qiHome = optionalString(environment.QI_HOME);
  return qiHome === undefined
    ? resolve(homeDirectory, ".qi", "providers")
    : resolve(qiHome, "providers");
}

/**
 * Load `*.toml` / `*.json` from the user providers directory, merge onto built-ins, and install.
 * Missing directory is a no-op (built-ins remain active).
 */
export async function loadAndInstallUserProviderCatalog(
  directory = defaultProviderCatalogDirectory(),
): Promise<{ readonly directory: string; readonly overlays: readonly ProviderProfile[] }> {
  resetProviderCatalog();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) {
      return { directory, overlays: [] };
    }
    throw error;
  }

  const overlays: ProviderProfile[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".toml") && !name.endsWith(".json")) continue;
    const absolute = join(directory, name);
    const text = await readFile(absolute, "utf8");
    const document = name.endsWith(".json") ? JSON.parse(text) : parseToml(text);
    overlays.push(...parseProviderCatalogDocument(document));
  }
  if (overlays.length > 0) {
    installProviderCatalogOverBuiltins(overlays);
  }
  return { directory, overlays };
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
