import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const exportDir = resolve(root, "web/out");
const packageStaticDir = resolve(root, "src-tauri/resources/static");
const themePlaceholder = "__SERVICE_CONSOLE_THEME__";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolvePackageDirectory(packageName, fromDirectory) {
  const requireFromPackage = createRequire(resolve(fromDirectory, "package.json"));
  try {
    return dirname(requireFromPackage.resolve(`${packageName}/package.json`));
  } catch {
    let current = dirname(requireFromPackage.resolve(packageName));
    while (current !== dirname(current)) {
      const manifestPath = resolve(current, "package.json");
      if (await pathExists(manifestPath)) {
        const metadata = JSON.parse(await readFile(manifestPath, "utf8"));
        if (metadata.name === packageName) return current;
      }
      current = dirname(current);
    }
    throw new Error(`Unable to resolve package metadata for ${packageName}`);
  }
}

async function collectNoticePackages() {
  const project = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const roots = [
    ...Object.keys(project.dependencies || {}),
    "@tailwindcss/postcss",
    "tailwindcss",
  ];
  const packages = new Map();

  async function visit(packageName, fromDirectory) {
    const packageDir = await resolvePackageDirectory(packageName, fromDirectory);
    const metadata = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
    const key = `${metadata.name}@${metadata.version}`;
    if (packages.has(key)) return;
    packages.set(key, { packageDir, metadata });
    for (const dependency of Object.keys(metadata.dependencies || {}).sort((left, right) => left.localeCompare(right))) {
      await visit(dependency, packageDir);
    }
  }

  for (const packageName of roots.sort((left, right) => left.localeCompare(right))) {
    await visit(packageName, root);
  }
  return [...packages.values()].sort((left, right) => (
    left.metadata.name.localeCompare(right.metadata.name)
    || left.metadata.version.localeCompare(right.metadata.version)
  ));
}

async function readPackageLicense(packageDir, metadata) {
  const filenames = await readdir(packageDir);
  const licenseFilename = filenames
    .filter((filename) => /^(licen[cs]e|copying)(\..+)?$/i.test(filename))
    .sort((left, right) => left.localeCompare(right))[0];
  const license = licenseFilename
    ? (await readFile(resolve(packageDir, licenseFilename), "utf8")).trim()
    : `License metadata: ${metadata.license || "not declared"}`;
  return `${metadata.name}@${metadata.version}\n${license}`;
}

async function createThirdPartyNotices() {
  const notices = [];
  for (const { packageDir, metadata } of await collectNoticePackages()) {
    notices.push(await readPackageLicense(packageDir, metadata));
  }
  return `${notices.join("\n\n---\n\n")}\n`;
}

async function validateExport(stagingDir) {
  const index = await readFile(resolve(stagingDir, "index.html"), "utf8");
  const placeholderCount = index.split(themePlaceholder).length - 1;
  if (placeholderCount === 0) {
    throw new Error(`Expected ${themePlaceholder} in exported index.html`);
  }
  if (!index.includes("/static/_next/")) {
    throw new Error("Exported index.html does not reference production assets below /static/_next/");
  }
  if (!(await pathExists(resolve(stagingDir, "_next/static")))) {
    throw new Error("Next.js export is missing the _next/static directory");
  }
}

export async function syncNextExport() {
  if (!(await pathExists(resolve(exportDir, "index.html")))) {
    throw new Error(`Next.js export is missing: ${resolve(exportDir, "index.html")}`);
  }

  await mkdir(dirname(packageStaticDir), { recursive: true });
  const uniqueSuffix = `${process.pid}-${Date.now()}`;
  const stagingDir = `${packageStaticDir}.staging-${uniqueSuffix}`;
  const backupDir = `${packageStaticDir}.backup-${uniqueSuffix}`;
  let movedExistingDirectory = false;

  try {
    await cp(exportDir, stagingDir, { recursive: true });
    await writeFile(
      resolve(stagingDir, "THIRD_PARTY_LICENSES.txt"),
      await createThirdPartyNotices(),
      "utf8",
    );
    await validateExport(stagingDir);

    if (await pathExists(packageStaticDir)) {
      await rename(packageStaticDir, backupDir);
      movedExistingDirectory = true;
    }
    try {
      await rename(stagingDir, packageStaticDir);
    } catch (error) {
      if (movedExistingDirectory) await rename(backupDir, packageStaticDir);
      throw error;
    }
    if (movedExistingDirectory) await rm(backupDir, { force: true, recursive: true });
  } finally {
    await rm(stagingDir, { force: true, recursive: true });
    if (await pathExists(backupDir)) {
      if (!(await pathExists(packageStaticDir))) await rename(backupDir, packageStaticDir);
      else await rm(backupDir, { force: true, recursive: true });
    }
  }

  console.log(`Synced Next.js export into ${packageStaticDir}`);
}

if (resolve(process.argv[1] || "") === scriptPath) {
  await syncNextExport();
}
