// Runtime dep resolution for tests, without a node_modules tree:
// maps @earendil-works/* to the vendored pi checkout's dist builds,
// found by walking up from the cwd. Loaded via --import in package.json's
// test script; used with tools/typecheck.sh's generated tsconfig for tsc.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let piRoot;
for (let d = process.cwd(); d !== "/"; d = dirname(d)) {
  if (existsSync(join(d, "vendor/pi/packages/tui"))) {
    piRoot = join(d, "vendor/pi");
    break;
  }
}
if (!piRoot) {
  throw new Error(
    "vendor/pi not found in any parent of the plugin; clone pi (github.com/earendil-works/pi) as ../../vendor/pi relative to the repo root",
  );
}

const dist = {
  "@earendil-works/pi-tui": join(piRoot, "packages/tui/dist/index.js"),
  "@earendil-works/pi-ai": join(piRoot, "packages/ai/dist/index.js"),
  "@earendil-works/pi-coding-agent": join(piRoot, "packages/coding-agent/dist/index.js"),
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = dist[specifier];
    if (mapped && existsSync(mapped)) {
      return { url: pathToFileURL(mapped).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
