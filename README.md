# EPCSE — Economic, Political & Civilization Simulation Engine

A planned deterministic simulation of interconnected economies, cities, populations, governments and diplomacy. The engine is intended to run independently of a user interface, web server or database.

**Status:** bootstrap only — workspace scaffolding (TypeScript strict, pnpm, Vitest, ESLint, Prettier, CI) and a CLI stub that explicitly reports that no simulation is implemented. No simulation engine, economics, or world rules exist yet.

The planning documentation is available in [`docs/`](docs/README.md). The intended stack is TypeScript and Node.js, with a standalone simulation core and CLI; API, persistence and visualization are to be integrated later as part of the same project.

## Setup

Requirements: Node.js >= 24 and pnpm 10.28.2 (pinned via `packageManager` / Corepack).

```sh
corepack pnpm@10.28.2 install --frozen-lockfile
corepack pnpm@10.28.2 typecheck
corepack pnpm@10.28.2 lint
corepack pnpm@10.28.2 test
corepack pnpm@10.28.2 build
```

CI (`.github/workflows/ci.yml`) runs the same commands on pull requests and pushes with pinned Node and pnpm versions.
