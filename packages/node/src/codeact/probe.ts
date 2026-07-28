import { spawn } from "node:child_process";

/**
 * Probes for a usable container runtime by invoking `<runtime> version` with a short timeout.
 * A valid container invocation plan is never proof that a container can run; callers must probe first
 * and skip registering a container-backed capability when no candidate responds.
 */
export async function probeContainerRuntime(
  candidates: readonly ("docker" | "podman")[] = ["docker", "podman"],
  timeoutMs = 3_000,
): Promise<"docker" | "podman" | undefined> {
  for (const runtime of candidates) {
    if (await probeOne(runtime, timeoutMs)) return runtime;
  }
  return undefined;
}

function probeOne(runtime: "docker" | "podman", timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(runtime, ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", windowsHide: true });
    } catch {
      resolveProbe(false);
      return;
    }
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(false);
    }, timeoutMs);
    child.once("error", () => settle(false));
    child.once("exit", (code) => settle(code === 0));
  });
}
