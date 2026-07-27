import { findTrustedExecutable } from "@civaapple/qi-tools";
import { t, type Locale } from "./i18n.js";

const DISCOVERY_COMMANDS = ["rg", "fd"] as const;

/** Trusted PATH accelerators used by search / find / tree (Workspace-external only). */
export async function missingDiscoveryAccelerators(workspaceRoot: string): Promise<string[]> {
  const missing: string[] = [];
  for (const command of DISCOVERY_COMMANDS) {
    if (!(await findTrustedExecutable(command, workspaceRoot))) missing.push(command);
  }
  return missing;
}

/** Lightweight Tip / 提示 line when rg or fd is absent; undefined when both are available. */
export function discoveryAcceleratorTip(locale: Locale, missing: readonly string[]): string | undefined {
  if (missing.length === 0) return undefined;
  const tools = missing.join(" + ");
  const base = t(locale, "tip.discovery", { tools });
  if (process.platform !== "win32") return base;
  const wingetParts: string[] = [];
  for (const name of missing) {
    if (name === "rg") wingetParts.push("BurntSushi.ripgrep.MSVC");
    else if (name === "fd") wingetParts.push("sharkdp.fd");
  }
  if (wingetParts.length === 0) return base;
  return t(locale, "tip.discovery.windows", { tools, winget: wingetParts.join(" ") });
}
