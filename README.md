# @kurkle/configs

Shared configuration for kurkle projects: a Biome config, a reusable GitHub Actions
workflow, git hooks, and the templates every repository starts from.

## Installation

```bash
npm install --save-dev @biomejs/biome @kurkle/configs
```

## Biome

Create or update `biome.json`:

```json
{
  "extends": ["./node_modules/@kurkle/configs/biome.json"]
}
```

This inherits all linter rules, formatter settings and assist actions defined here.

### Configuration overview

**Linter** — recommended rules on; cognitive complexity warns above 10; unused imports and
variables are errors; `noExplicitAny`, `noRedeclare` and `noDelete` off; `useImportType`
enforced with separated type imports.

**Formatter** — 2 spaces, 100 column line width, LF line endings, single quotes, ES5 trailing
commas, semicolons as needed.

**Assist** — organized imports (types, then packages, then paths), sorted keys, attributes and
properties.

**Globals** — browser, node, jasmine.

## Shared CI workflow

`shared-ci.yml` is a reusable workflow. Call it from `pr-ci.yml` and `main-ci.yml`:

```yaml
jobs:
  shared-ci:
    uses: kurkle/configs/.github/workflows/shared-ci.yml@v1
    with:
      fetch-depth: 0
      run-audit-signatures: true
    secrets: inherit
```

It runs install → lint → typecheck → build → test → coverage upload in one job, then a
SonarCloud scan in a second job that is skipped on forks and for dependabot. Every step is
opt-out, so a repository without a build or without browser tests turns off the inputs it does
not need rather than forking the workflow.

| Input | Default | Purpose |
| --- | --- | --- |
| `fetch-depth` | `0` | Checkout depth. Use `1` for pull requests. |
| `node-version` | `'24'` | Node.js version for every job. |
| `install-command` | `npm clean-install` | Dependency install command. |
| `run-lint` | `true` | Run `npm run lint`. |
| `run-typecheck` | `true` | Run `npm run typecheck`. |
| `run-build` | `true` | Run `npm run build`. |
| `test-command` | `npm test` | Test command. Empty string skips testing. |
| `browser-tests` | `true` | Wrap the test command in `xvfb-run`, for karma. |
| `extra-command` | `''` | Command run after the tests, e.g. `npm run pack:check`. |
| `coverage-paths` | chrome, firefox and unit lcov | Newline separated lcov paths to upload. Empty string skips the upload. |
| `run-sonar` | `true` | Run the SonarCloud scan. |
| `run-audit-signatures` | `false` | Verify provenance attestations and registry signatures. |

`secrets: inherit` is required whenever `run-sonar` is on, so the scan gets `SONAR_TOKEN`.

### Versioning

Consumers pin the floating major tag `@v1`. `main-ci.yml` moves that tag to every release made
from `main`, so a patch release reaches all repositories without a pull request in each one. Pin
an exact tag such as `@v1.2.0` instead when a repository needs to hold back.

## Git hooks

```bash
npx kurkle-install-hooks
```

Copies `commit-msg` (semantic commit subject check) and `pre-commit` into `.githooks/` and points
`core.hooksPath` at them. Existing hooks are kept unless you pass `--force`. Add the git config to
`package.json` so fresh clones pick the hooks up:

```json
{
  "scripts": {
    "prepare": "git config core.hooksPath .githooks || true"
  }
}
```

The `pre-commit` hook runs lint, test, typecheck, build and docs with `--if-present`, so the same
hook works in every repository regardless of which scripts it defines.

## Templates

One-time copies for a new or migrating repository:

| Template | Copy to |
| --- | --- |
| `templates/editorconfig` | `.editorconfig` |
| `templates/releaserc.json` | `.releaserc.json` |
| `templates/githooks/*` | `.githooks/` (or use `npx kurkle-install-hooks`) |

## TypeScript

`tsconfig.base.json` holds the compiler options shared by every project. Paths stay in the
consuming config, because TypeScript resolves them relative to the file that declares them:

```json
{
  "extends": "@kurkle/configs/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["jasmine"]
  },
  "include": ["./src/**/*"],
  "exclude": ["./dist/**", "./src/**/*.test.ts"]
}
```

## Contributing

Change the config here and let semantic-release publish it: `feat:` and `fix:` commits release a
new version and move the floating major tag. Consumers follow on their next CI run.

## License

MIT
