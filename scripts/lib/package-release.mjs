import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const coreWave = new Set([
  "@civaapple/qi-protocol",
  "@civaapple/qi-kernel",
  "@civaapple/qi-capability",
  "@civaapple/qi-llm",
  "@civaapple/qi-context",
  "@civaapple/qi-workspace",
  "@civaapple/qi-tools",
  "@civaapple/qi-loop",
  "@civaapple/qi-tui",
  "@civaapple/qi-agent",
  "@civaapple/qi-introspection",
]);

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

export async function createPackageReleasePlan(rootPath) {
  const root = resolve(rootPath);
  const rootManifest = await readJson(join(root, "package.json"));
  const packages = await readPackages(root);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const duplicateNames = packages
    .filter((pkg, index) => packages.findIndex((candidate) => candidate.name === pkg.name) !== index)
    .map(({ name }) => name);
  const missingCorePackages = [...coreWave].filter((name) => !byName.has(name));
  const missingInternalDependencies = [];
  const internalRangeMismatches = [];

  for (const pkg of packages) {
    for (const [name, range] of Object.entries(pkg.internalDependencies)) {
      if (!byName.has(name)) {
        missingInternalDependencies.push({ package: pkg.name, dependency: name, range });
      } else if (range !== rootManifest.version) {
        internalRangeMismatches.push({
          package: pkg.name,
          dependency: name,
          expected: rootManifest.version,
          actual: range,
        });
      }
    }
  }

  const topology = topologicalBatches(packages, byName);
  const coreDependsOnExtension = packages
    .filter(({ name }) => coreWave.has(name))
    .flatMap((pkg) => Object.keys(pkg.internalDependencies)
      .filter((dependency) => byName.has(dependency) && !coreWave.has(dependency))
      .map((dependency) => ({ package: pkg.name, dependency })));
  const versions = [...new Set(packages.map(({ version }) => version))];
  const namespaceConsistent = packages.every(({ name }) => name.startsWith("@civaapple/qi-"));
  const identity = await readRegistryIdentity(root);
  const identityCheck = validateRegistryIdentity(identity, packages);

  const packageReports = packages.map((pkg) => {
    const checks = [
      check("coordinated-version", pkg.version === rootManifest.version, `${pkg.version}; expected ${rootManifest.version}`),
      check("public-name", pkg.name.startsWith("@civaapple/qi-"), pkg.name),
      check("publish-private", pkg.private !== true, pkg.private === true ? "private: true" : "not private"),
      check("license", Boolean(pkg.license) && pkg.license === rootManifest.license, pkg.license ?? "missing"),
      check(
        "repository",
        Boolean(pkg.repository?.url && pkg.repository?.directory),
        pkg.repository ? JSON.stringify(pkg.repository) : "missing",
      ),
      check(
        "publish-config",
        pkg.publishConfig?.access === "public",
        pkg.publishConfig ? JSON.stringify(pkg.publishConfig) : "missing",
      ),
      check(
        "internal-ranges",
        Object.entries(pkg.internalDependencies).every(([, range]) => range === rootManifest.version),
        Object.entries(pkg.internalDependencies).length === 0
          ? "no internal dependencies"
          : JSON.stringify(pkg.internalDependencies),
      ),
    ];
    return {
      name: pkg.name,
      directory: pkg.directory,
      version: pkg.version,
      wave: coreWave.has(pkg.name) ? "core" : "extension",
      internalDependencies: pkg.internalDependencies,
      manifestReady: checks.every(({ pass }) => pass),
      checks,
    };
  });

  const graphChecks = [
    check("package-count", packages.length === 21, `${packages.length}; expected 21`),
    check("unique-names", duplicateNames.length === 0, duplicateNames.join(", ") || "all names unique"),
    check("coordinated-version", versions.length === 1 && versions[0] === rootManifest.version, versions.join(", ")),
    check("namespace", namespaceConsistent, namespaceConsistent ? "@civaapple/qi-*" : "inconsistent package namespace"),
    check(
      "internal-dependencies-resolve",
      missingInternalDependencies.length === 0,
      missingInternalDependencies.length === 0 ? "all internal dependencies resolve" : JSON.stringify(missingInternalDependencies),
    ),
    check(
      "internal-ranges",
      internalRangeMismatches.length === 0,
      internalRangeMismatches.length === 0 ? `all internal ranges are ${rootManifest.version}` : JSON.stringify(internalRangeMismatches),
    ),
    check("acyclic", topology.cycles.length === 0, topology.cycles.join(", ") || "dependency graph is acyclic"),
    check("core-wave-complete", missingCorePackages.length === 0, missingCorePackages.join(", ") || "core wave is complete"),
    check(
      "core-wave-independent",
      coreDependsOnExtension.length === 0,
      coreDependsOnExtension.length === 0
        ? "core publication wave has no extension-wave dependency"
        : JSON.stringify(coreDependsOnExtension),
    ),
  ];
  const graphReady = graphChecks.every(({ pass }) => pass);
  const manifestsReady = packageReports.every(({ manifestReady }) => manifestReady);
  const registryReady = graphReady && manifestsReady && identityCheck.pass;
  const order = topology.batches.flat();

  return {
    type: "qi.package-release-plan",
    schemaVersion: 1,
    release: rootManifest.version,
    graphReady,
    manifests: manifestsReady ? "ready" : "blocked",
    registry: registryReady ? "ready" : "blocked",
    graphChecks,
    registryIdentity: {
      status: identityCheck.pass ? "confirmed-recorded" : "unconfirmed",
      detail: identityCheck.detail,
    },
    topologicalBatches: topology.batches,
    waves: {
      core: order.filter((name) => coreWave.has(name)),
      extension: order.filter((name) => !coreWave.has(name)),
    },
    packages: packageReports,
    blockers: [
      ...graphChecks.filter(({ pass }) => !pass).map(({ id, detail }) => ({ id, detail })),
      ...packageReports.flatMap((pkg) => pkg.checks
        .filter(({ pass }) => !pass)
        .map(({ id, detail }) => ({ id: `${pkg.name}:${id}`, detail }))),
      ...(identityCheck.pass ? [] : [{ id: "registry-identity", detail: identityCheck.detail }]),
    ],
  };
}

export function topologicalBatches(packages, byName = new Map(packages.map((pkg) => [pkg.name, pkg]))) {
  const emitted = new Set();
  const remaining = new Set(packages.map(({ name }) => name));
  const batches = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => Object.keys(byName.get(name).internalDependencies)
        .filter((dependency) => byName.has(dependency))
        .every((dependency) => emitted.has(dependency)))
      .sort();
    if (ready.length === 0) break;
    batches.push(ready);
    for (const name of ready) {
      remaining.delete(name);
      emitted.add(name);
    }
  }
  return { batches, cycles: [...remaining].sort() };
}

async function readPackages(root) {
  const packageRoot = join(root, "packages");
  const directories = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(directories.map(async (directory) => {
    const manifest = await readJson(join(packageRoot, directory, "package.json"));
    const internalDependencies = {};
    for (const section of dependencySections) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (name.startsWith("@civaapple/qi-")) internalDependencies[name] = range;
      }
    }
    return {
      directory,
      name: manifest.name,
      version: manifest.version,
      private: manifest.private,
      license: manifest.license,
      repository: manifest.repository,
      publishConfig: manifest.publishConfig,
      internalDependencies,
    };
  }));
}

async function readRegistryIdentity(root) {
  const path = join(root, "release", "registry-identity.json");
  try {
    await access(path, constants.R_OK);
    return await readJson(path);
  } catch {
    return null;
  }
}

function validateRegistryIdentity(identity, packages) {
  if (!identity) {
    return {
      pass: false,
      detail: "release/registry-identity.json is missing; maintainers must record verified scope ownership and CLI identity",
    };
  }
  const pass = identity.registry === "https://registry.npmjs.org"
    && identity.scope === "@civaapple"
    && typeof identity.confirmedBy === "string"
    && identity.confirmedBy.length > 0
    && !Number.isNaN(Date.parse(identity.confirmedAt))
    && identity.cliPackageName === "@civaapple/qi"
    && identity.packageNamesConfirmed === true
    && identity.provenance === true
    && packages.every(({ name }) => name.startsWith(`${identity.scope}/qi-`));
  return {
    pass,
    detail: pass
      ? `scope ${identity.scope} recorded by ${identity.confirmedBy} at ${identity.confirmedAt}`
      : "registry identity record must include registry, @civaapple scope, confirmer/date, @civaapple/qi CLI package name, packageNamesConfirmed=true, and provenance=true",
  };
}

function check(id, pass, detail) {
  return { id, pass, detail };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
