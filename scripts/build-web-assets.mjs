import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { syncNextExport } from "./sync-next-export.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = resolve(root, "node_modules/next/dist/bin/next");

function runNextBuild() {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [nextBin, "build", "--webpack", resolve(root, "web")], {
      cwd: root,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "inherit",
    });
    child.once("error", rejectBuild);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Next.js build failed (${signal || `exit ${code}`})`));
    });
  });
}

await runNextBuild();
await syncNextExport();
