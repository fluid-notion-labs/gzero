# Context — npm

## build #npm
- Use the package manager matching the lockfile: pnpm-lock.yaml → pnpm, yarn.lock → yarn, else npm.
- TypeScript: `tsc --noEmit` before done; tests via the repo's configured runner.

## layout #npm
- Lockfile committed, node_modules never.
- Scripts in package.json are the interface: build, test, lint.
