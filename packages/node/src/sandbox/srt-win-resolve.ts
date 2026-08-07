import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve the vendored `srt-win.exe` next to a global `srt.cmd` / npm prefix,
 * then ensure a **machine-readable** copy under `%ProgramData%\qi\srt-win\`.
 *
 * Why: `CreateProcessWithLogonW(srt-sandbox)` must load `srt-win.exe`. When the
 * binary lives only under the user's AppData/nvm tree, the sandbox account gets
 * ACCESS_DENIED (0x80070005) even though WFP install succeeded and seclogon runs.
 */
export async function ensureMachineReadableSrtWin(
  srtCliPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string; source: string; copied: boolean } | undefined> {
  if (platform !== "win32") return undefined;
  const source = await findVendoredSrtWin(srtCliPath);
  if (!source) return undefined;

  const programData = process.env.ProgramData || "C:\\ProgramData";
  const destDir = join(programData, "qi", "srt-win");
  const dest = join(destDir, "srt-win.exe");

  let needCopy = true;
  try {
    const [srcStat, destStat] = await Promise.all([stat(source), stat(dest)]);
    needCopy = srcStat.size !== destStat.size || srcStat.mtimeMs > destStat.mtimeMs;
  } catch {
    needCopy = true;
  }

  if (needCopy) {
    await mkdir(destDir, { recursive: true });
    await copyFile(source, dest);
    // Best-effort: allow Authenticated Users to execute (non-fatal if icacls fails).
    try {
      await execFileAsync("icacls", [destDir, "/grant", "*S-1-5-11:(OI)(CI)RX", "/T"], {
        windowsHide: true,
        timeout: 10_000,
      });
    } catch {
      // ignore
    }
  }

  try {
    await access(dest, constants.F_OK);
  } catch {
    return undefined;
  }

  return { path: dest, source, copied: needCopy };
}

async function findVendoredSrtWin(srtCliPath: string): Promise<string | undefined> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const base = dirname(srtCliPath);
  const rel = join("node_modules", "@anthropic-ai", "sandbox-runtime", "vendor", "srt-win", arch, "srt-win.exe");
  const candidates = [
    join(base, rel),
    // nvm / some prefixes put node_modules beside the shim
    join(base, "..", rel),
    // Global npm on Windows sometimes uses %APPDATA%\npm
    process.env.APPDATA
      ? join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor", "srt-win", arch, "srt-win.exe")
      : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return undefined;
}
