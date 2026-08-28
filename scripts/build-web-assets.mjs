import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = resolve(root, "src/service_console/static/vendor");

await rm(vendorDir, { force: true, recursive: true });
await mkdir(vendorDir, { recursive: true });

await build({
  entryPoints: [resolve(root, "web/xterm-entry.js")],
  outfile: resolve(vendorDir, "xterm-bundle.js"),
  bundle: true,
  format: "iife",
  legalComments: "eof",
  minify: true,
  platform: "browser",
  target: ["safari15", "chrome100", "firefox100"],
});

await cp(
  resolve(root, "node_modules/@xterm/xterm/css/xterm.css"),
  resolve(vendorDir, "xterm.css"),
);

const packages = [
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-search",
  "@xterm/addon-web-links",
  "esbuild",
];
const notices = [];
for (const packageName of packages) {
  const packageDir = resolve(root, "node_modules", packageName);
  const metadata = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
  const licenseFilename = packageName === "esbuild" ? "LICENSE.md" : "LICENSE";
  const license = await readFile(resolve(packageDir, licenseFilename), "utf8");
  notices.push(`${metadata.name}@${metadata.version}\n${license.trim()}`);
}
await writeFile(
  resolve(vendorDir, "THIRD_PARTY_LICENSES.txt"),
  `${notices.join("\n\n---\n\n")}\n`,
  "utf8",
);

console.log(`Built browser assets in ${vendorDir}`);
