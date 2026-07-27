import { homedir } from "node:os";
import { resolve } from "node:path";

/** User Qi home: `QI_HOME` or `~/.qi`. */
export function defaultQiHome(
  environment: { readonly QI_HOME?: string } = process.env,
  homeDirectory = homedir(),
): string {
  const fromEnv = environment.QI_HOME?.trim();
  return fromEnv ? resolve(fromEnv) : resolve(homeDirectory, ".qi");
}

/** Default project data root: `~/.qi/projects` (or `$QI_HOME/projects`). */
export function defaultProjectsRoot(
  environment: { readonly QI_HOME?: string } = process.env,
  homeDirectory = homedir(),
): string {
  return resolve(defaultQiHome(environment, homeDirectory), "projects");
}
