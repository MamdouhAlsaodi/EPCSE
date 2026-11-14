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

## Open source and attribution

EPCSE is available under the [MIT License](LICENSE). You may use, modify, share, and sell the engine or code, including as part of commercial games, subject to the license terms. No royalty is required by this license.

**Mamdouh Alsaodi (ممدوح السعودي)** is a contributor to EPCSE. If this project helps you build something, a mention of Mamdouh and a link back to this repository would be sincerely appreciated: recognition helps contributors share their work and encourages open-source development. This request is voluntary and does not add a requirement beyond the MIT License.

The templates in [`docs/spec-kit-templates/`](docs/spec-kit-templates/) originate from [GitHub Spec Kit](https://github.com/github/spec-kit) and retain [GitHub's MIT license notice](docs/spec-kit-templates/LICENSE).
