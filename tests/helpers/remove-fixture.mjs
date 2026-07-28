import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function removeFixture(root) {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

async function makeWritable(path) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) return;
  if (!entry.isDirectory()) {
    await chmod(path, 0o644);
    return;
  }
  await chmod(path, 0o755);
  const children = await readdir(path);
  await Promise.all(children.map((child) => makeWritable(join(path, child))));
}
