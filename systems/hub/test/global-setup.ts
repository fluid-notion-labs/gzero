/**
 * Test bootstrap: guarantee the dev token exists.
 *
 * `.dev.vars` is gitignored (real deployments set TOKEN as a Wrangler
 * secret), so a fresh checkout — the exact situation the test suite is
 * supposed to make painless — had no token and every request 401'd
 * (2026-11-06: 22 of 37 hub tests failed after a reinstall for this
 * one reason). Write it here so `npm test` never depends on an
 * untracked file. Harmless if it already exists.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export default function () {
  const file = path.join(__dirname, "..", ".dev.vars");
  if (!existsSync(file)) {
    writeFileSync(file, "TOKEN=token\n");
  }
}
