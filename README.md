# @kurkle/configs

[![npm](https://img.shields.io/npm/v/@kurkle/configs.svg)](https://www.npmjs.com/package/@kurkle/configs)
[![release](https://img.shields.io/github/release/kurkle/configs.svg?style=flat-square)](https://github.com/kurkle/configs/releases/latest)
![GitHub](https://img.shields.io/github/license/kurkle/configs.svg)

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
| `install-command` | `npm clean-install --ignore-scripts` | Dependency install command. Scripts are off by default since a compromised dependency's install script is a common malware vector; override if a repository needs them. |
| `run-lint` | `true` | Run `npm run lint`. |
| `run-typecheck` | `true` | Run `npm run typecheck`. |
| `run-build` | `true` | Run `npm run build`. |
| `test-command` | `npm test` | Test command. Empty string skips testing. |
| `browser-tests` | `true` | Wrap the test command in `xvfb-run`, for karma. |
| `extra-command` | `''` | Command run after the tests, e.g. `npm run pack:check`. |
| `coverage-paths` | chrome, firefox and unit lcov | Newline separated lcov paths to upload. Empty string skips the upload. |
| `run-sonar` | `true` | Run the SonarCloud scan. |
| `run-audit-signatures` | `false` | Verify provenance attestations and registry signatures. |

A caller with `run-sonar` on needs to get `SONAR_TOKEN` to the scan, either with
`secrets: inherit` or, preferred, by naming it explicitly:

```yaml
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

A repository with `run-sonar: false` needs no `secrets:` block at all.

### Versioning

Consumers pin the floating major tag `@v1`. `main-ci.yml` moves that tag to every release made
from `main`, so a patch release reaches all repositories without a pull request in each one. Pin
an exact tag such as `@v1.2.0` instead when a repository needs to hold back.

## Publish contract

`kurkle-check-package` packs the package once and runs three checks against that one tarball:
`attw`, `publint`, and a consumer that is compiled and then loaded.

```json
{
  "scripts": {
    "test:pack": "kurkle-check-package"
  }
}
```

`attw` and `publint` ship as dependencies of this package, so a repository needs neither in its
own `devDependencies`, and the version is bumped in one place for the whole fleet.

### Why the third check exists

`attw` and `publint` check how a specifier *resolves* — does it resolve at all, and does the
resolved file's module kind match the condition that pointed at it. Neither type-checks the
shipped declarations against a consumer. A package can be green in both and still fail to
compile:

- a `declare module` augmentation inside a `.d.cts`, which resolves the augmented specifier in
  require mode
- an `export =` beside other exported elements, which is not valid TypeScript
- syntax the consumer's TypeScript is too old to parse, such as the import attributes a `.d.cts`
  needs to reach an ESM-typed peer

So the third check writes a consumer and compiles it, across `node16` and `nodenext`, with
`skipLibCheck` both on and off, on more than one TypeScript version. Then it `require()`s the
entry point, because declarations can be perfect while the entry point fails to load.

### Two TypeScript versions, not one

The default is the floor and the current release, and both are needed. A new compiler parses
syntax an old one rejects; an old one reports errors a new one has stopped reporting. Checking
only the newest version misses the second kind entirely.

```json
{
  "kurkle": {
    "checkPackage": {
      "typescript": ["5.3", "latest"],
      "modes": ["node16", "nodenext"]
    }
  }
}
```

`--ts` and `--modes` override those per run, and `--skip-attw`, `--skip-publint` and `--keep`
help when narrowing down a failure. A package with no `require` entry skips the CommonJS
consumer instead of failing it.

## CommonJS type declarations

```bash
npx kurkle-build-cjs-types
```

For a package whose `exports.require` condition serves a UMD bundle under a `.cjs` name:
`tsc` only ever emits ESM (`.d.ts`) declarations, so the require condition has nothing of its
own to point at. This duplicates every `.d.ts` in a directory as a `.d.cts` twin, with four
rewrites that make the copy **compile** for a consumer rather than merely resolve:

1. Relative specifiers are rewritten to their `.cjs` counterparts, so a `.d.cts` resolves
   `./x.cjs` to `./x.d.cts` instead of the ESM `./x.d.ts`.
2. A default export becomes `export =`, and — because `export =` may not stand beside other
   exports (TS2309) — any named types move into a namespace merged with the exported value. A
   no-op when the source has no default export, which is what lets one generator handle a
   plugin (default export) and a chart type (none) alike.
3. Imports of a package whose own types are ESM (e.g. `chart.js`) become type-only and carry a
   `resolution-mode` attribute — legal only on a type-only import; a value import would need
   `--module` to be esnext, node18, node20, nodenext or preserve, and `node16` is none of those
   (TS2823).
4. A `declare module` augmentation is dropped and re-imported from the ESM twin of the same
   file, because it resolves its own specifier in the enclosing file's mode and no attribute
   syntax can override that.

Without 2–4 the package still passes `attw` and `publint` — they check how a specifier
resolves, not whether the result compiles — and still fails to build for a consumer with
`skipLibCheck: false`.

Wire it into the build, after the step that emits declarations:

```json
{
  "scripts": {
    "build": "rollup -c && tsc -p tsconfig.json --emitDeclarationOnly && kurkle-build-cjs-types"
  }
}
```

Options:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--dir <path>` | `dist` | Directory holding the emitted `.d.ts` files, and where the `.d.cts` twins are written. |
| `--help` | — | Print usage and exit without generating anything. |

`--dir` can also be set once in `package.json`:

```json
{
  "kurkle": {
    "buildCjsTypes": {
      "dir": "types"
    }
  }
}
```

## Docs deploy workflow

`docs-deploy.yml` is a second, separate reusable workflow that promotes a just-published
release's docs to Cloudflare Pages production. It is not a job inside `shared-ci.yml`, because
shared-ci runs for both pull requests and ordinary pushes to `main`, while this only ever belongs
after an actual release; and it is not folded into a repository's own `release` job either,
because that job's workflow **file name** is load-bearing — npm's trusted publishing binds the
publisher identity to the exact workflow file (`main-ci.yml`) that runs `npx semantic-release`, and
moving that call into a called workflow changes the identity and breaks npm publishing fleet-wide.
Only the two Cloudflare steps move; nothing that touches npm does.

Call it from the `release` job's workflow, as a job of its own that needs `release`:

```yaml
  docs-deploy:
    needs: release
    if: needs.release.outputs.released == 'true'
    uses: kurkle/configs/.github/workflows/docs-deploy.yml@v1
    with:
      version: ${{ needs.release.outputs.version }}
    secrets:
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_PAGES_PROJECT: ${{ secrets.CLOUDFLARE_PAGES_PROJECT }}
      CLOUDFLARE_PAGES_DEPLOY_HOOK: ${{ secrets.CLOUDFLARE_PAGES_DEPLOY_HOOK }}
```

Secrets are named explicitly rather than `secrets: inherit`, the same reasoning as `SONAR_TOKEN`
above — least exposure, since `secrets: inherit` hands this workflow every secret the caller has,
including `NPM_TOKEN` where one exists. `secrets: inherit` still works if a repository prefers it;
`workflow_call.secrets` in `docs-deploy.yml` declares the four names either way, since an explicit
`secrets:` block in a caller is only valid for names the called workflow has declared.

| Input | Purpose |
| --- | --- |
| `version` | Released version without the leading `v`, e.g. `1.2.3`. |

This depends on `needs.release.outputs.released` and `needs.release.outputs.version`, which the
`release` job does not publish as **job** outputs by default — only as outputs of its own
`release-version` step. A repository adopting `docs-deploy.yml` needs both of these changes to its
`release` job, in addition to adding the `docs-deploy` job above:

1. Add a job-level `outputs:` block (next to `permissions:`, before `steps:`):

   ```yaml
       outputs:
         released: ${{ steps.release-version.outputs.released }}
         version: ${{ steps.release-version.outputs.version }}
   ```

2. Remove the `Update Cloudflare Pages production docs version` and
   `Trigger Cloudflare Pages production deploy` steps — they moved into `docs-deploy.yml`. The
   `Resolve released version` step (`id: release-version`) stays; it reads the git tag and belongs
   with the release itself, not the deploy.

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

## Icons

```bash
npx kurkle-generate-icons
```

Reads `docs/public/favicon.svg` and writes the full favicon / PWA icon set next to it:
`favicon.ico` (16/32/48), `favicon-96x96.png`, `apple-touch-icon.png` (180x180), and the two
maskable icons `web-app-manifest-192x192.png` and `web-app-manifest-512x512.png`. The maskable pair
is rendered into an 80% safe zone (`MASKABLE_SAFE_ZONE`, fixed fleet-wide) so the mark survives
being cropped to a circle/squircle by the platform.

Requires `sharp` and `png-to-ico`, both optional peer dependencies — install them in any repository
that runs the command:

```bash
npm install --save-dev sharp png-to-ico
```

Running the command without them prints which packages are missing instead of a raw
`ERR_MODULE_NOT_FOUND`.

Wire it into `package.json`:

```json
{
  "scripts": {
    "icons": "kurkle-generate-icons"
  }
}
```

Options:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--dir <path>` | `docs/public` | Directory holding `favicon.svg`, and where the generated files are written. Relative to the current working directory. |
| `--background <color>` | `background_color` from `<dir>/site.webmanifest`, else `#ffffff` | Fill color for the maskable safe-zone margin. The manifest is the source of truth when present, since platforms use the same value as the icon's backdrop; pass the flag to override it, or when there is no manifest. |
| `--help`, `-h` | — | Print usage and exit without generating anything. |

## Templates

One-time copies for a new or migrating repository:

| Template | Copy to |
| --- | --- |
| `templates/editorconfig` | `.editorconfig` |
| `templates/releaserc.json` | `.releaserc.json` |
| `templates/dependabot.yml` | `.github/dependabot.yml` |
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
