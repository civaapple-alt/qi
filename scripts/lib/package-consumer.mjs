export function internalDependencyNames(manifest) {
  return [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].filter((name) => name.startsWith("@civaapple/qi-")))].sort();
}

export function dependencyClosure(targetName, candidates) {
  const byName = candidates instanceof Map
    ? candidates
    : new Map(candidates.map((candidate) => [candidate.name, candidate]));
  if (!byName.has(targetName)) throw new Error(`Unknown package candidate: ${targetName}`);
  const closure = new Set();
  const pending = [targetName];
  while (pending.length > 0) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    const candidate = byName.get(name);
    if (!candidate) throw new Error(`Missing internal package dependency: ${name}`);
    closure.add(name);
    for (const dependency of candidate.internalDependencies ?? []) {
      if (!byName.has(dependency)) {
        throw new Error(`${candidate.name} declares missing internal dependency ${dependency}`);
      }
      pending.push(dependency);
    }
  }
  return [...closure].sort();
}

export async function mapConcurrent(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("concurrency limit must be a positive integer");
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  );
  return results;
}
