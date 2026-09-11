#!/usr/bin/env node

/**
 * Emits the CommonJS half of the type declarations.
 *
 * `exports.require` serves the UMD bundle under a `.cjs` name, but `tsc`
 * emits only ESM declarations. TypeScript reads a `.d.ts` reached through
 * `require` as ESM and reports the package as masquerading (attw's
 * FalseESM), so the require condition needs its own `.d.cts` tree: every
 * `.d.ts` in the target directory gets a `.d.cts` twin.
 *
 * Four rewrites make that tree compile rather than merely resolve:
 *
 *  1. A `.d.cts` resolves a relative `./x.cjs` specifier to `./x.d.cts`, so
 *     the copies rewrite their own specifiers as they go.
 *
 *  2. The default export becomes `export =`, matching the UMD bundle's
 *     `module.exports =`. `export =` may not stand beside other exports
 *     (TS2309), so any named types move into a namespace merged with the
 *     exported value, where a CommonJS consumer reaches them as members.
 *     This step is a no-op when the source has no default export, which is
 *     why one generator covers both shapes.
 *
 *  3. Imports from a package whose types are ESM — chart.js — become
 *     type-only and carry `resolution-mode`, or a CommonJS declaration
 *     cannot reach them (TS1479 for a value import, TS1541 for a type-only
 *     one without the attribute). The attribute is legal here only because
 *     the import is type-only: on a value import it needs `--module` to be
 *     esnext, node18, node20, nodenext or preserve, and `node16` is none of
 *     those (TS2823).
 *
 *  4. A `declare module 'chart.js'` augmentation resolves its own specifier
 *     in the enclosing file's mode, and no attribute syntax can override
 *     that. The block is dropped and pulled back in from the ESM twin of the
 *     same file, which resolves it in import mode.
 *
 * Without 2 to 4 the package still passes attw and publint — they check
 * resolution, not compilation — and still fails for a `skipLibCheck: false`
 * consumer.
 */
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HELP_TEXT = `Usage: kurkle-build-cjs-types [options]

  --dir <path>   Directory of the emitted .d.ts declarations, and where the
                 .d.cts twins are written (default: dist)
  --help         Show this message`

export const readManifest = (dir = process.cwd()) =>
  JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))

// Mirrors kurkle-check-package: a CLI flag wins, then package.json's
// `kurkle.buildCjsTypes`, then the default.
export function parseArgs(argv, config = {}) {
  const args = { dir: config.dir ?? 'dist', help: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inlineValue] = arg.split(/=(.*)/s)

    if (flag === '--dir') {
      args.dir = inlineValue ?? argv[++i]
    } else if (flag === '--help' || flag === '-h') {
      args.help = true
    }
  }

  return args
}

// Rewrite 1: a `.d.cts` resolves `./x.js` as ESM, so its own relative
// specifiers need to point at the `.cjs` sibling instead.
export const relativeCjsSpecifiers = (source) =>
  source.replace(/(from\s+'\.\/[^']+)\.js'/g, "$1.cjs'")

// Rewrite 3: type-only + `resolution-mode` for every import of a bare
// (non-relative) specifier — the packages whose declarations are ESM.
export const typeOnlyPackageImports = (source) =>
  source.replace(
    /import[ \t]+(?:type[ \t]+)?([^;'"]+?)[ \t]+from[ \t]+'([^.'][^']*)'[ \t]*;?/g,
    (_match, clause, specifier) =>
      `import type ${clause} from '${specifier}' with { 'resolution-mode': 'import' };`
  )

// Finds the end of the `{ ... }` block opened by the first `{` at or after
// `from`, tracking nesting depth so an augmentation containing its own
// braces (an interface, a nested namespace) is removed whole.
const endOfBlock = (source, from) => {
  let depth = 0
  let at = source.indexOf('{', from)

  do {
    depth += source[at] === '{' ? 1 : source[at] === '}' ? -1 : 0
    at += 1
  } while (depth > 0)

  return at
}

// Rewrite 4: drop every `declare module '<bare specifier>' { ... }`
// augmentation. The caller re-imports it from the ESM twin when any were
// removed.
export const withoutAugmentations = (source) => {
  let result = source
  let removed = false

  for (;;) {
    const start = result.search(/declare module '[^.'][^']*' \{/)
    if (start === -1) {
      return { removed, source: result }
    }

    result = result.slice(0, start) + result.slice(endOfBlock(result, start))
    removed = true
  }
}

// Plain .sort() coerces to string before comparing, which happens to be what
// every element here already is - but a bare .sort() reads as
// accidental numeric-unsafe sorting to a linter (Sonar javascript:S2871), so
// the comparator is spelled out. Not .localeCompare(): this output is a
// build artifact and has to be byte-identical regardless of the host's
// locale, and ordinary "<"/">" already gives a deterministic string order
// for identifier names.
const compareNames = (a, b) => {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

// Rewrite 2: `export default` (or `export { X as default }`) becomes
// `export =`, and any other top-level exports move into a namespace merged
// with the exported value. A no-op when there is no default export, which is
// what makes one generator correct for both a plugin (default export) and a
// chart type (none) alike.
export const namespacedExports = (source) => {
  const exported = [...source.matchAll(/^export (?:interface|type|enum|class) (\w+)/gm)].map(
    (match) => match[1]
  )

  const withDefault = source
    .replace(/^export default (\w+)$/m, 'export = $1')
    .replace(/^export \{\s*(\w+)\s+as default\s*\}$/m, 'export = $1')

  const assignment = withDefault.match(/^export = (\w+)$/m)
  if (!assignment || exported.length === 0) {
    return withDefault
  }

  const members = [...exported].sort(compareNames).join(', ')
  const namespace = `declare namespace ${assignment[1]} {\n  export { ${members} }\n}\n\n`

  return withDefault
    .replace(/^export (interface|type|enum|class) /gm, '$1 ')
    .replace(/^export = /m, `${namespace}export = `)
}

// The four rewrites in the order that makes them compose: specifiers first
// (so later steps see `.cjs` already in place), then the export shape, then
// the augmentation, which needs the *original* specifiers to name the ESM
// twin it re-imports.
export function transformDeclaration(source) {
  return withoutAugmentations(
    namespacedExports(typeOnlyPackageImports(relativeCjsSpecifiers(source)))
  )
}

// Duplicates every `.d.ts` in `dir` as a `.d.cts`. Returns the names written,
// so callers (main, tests) can report or assert on them without re-reading
// the directory.
export function buildCjsTypes(dir) {
  const written = []

  for (const name of readdirSync(dir).filter((file) => file.endsWith('.d.ts'))) {
    const raw = readFileSync(join(dir, name), 'utf8')
    const { removed, source } = transformDeclaration(raw)
    const twin = name.replace(/\.d\.ts$/, '.js')
    const prefix = removed
      ? `import type {} from './${twin}' with { 'resolution-mode': 'import' };\n`
      : ''

    const outName = name.replace(/\.d\.ts$/, '.d.cts')
    writeFileSync(join(dir, outName), (prefix + source).replace(/\n{3,}/g, '\n\n'))
    written.push(outName)
  }

  return written
}

export function main() {
  // Before the manifest, so `--help` answers from anywhere rather than
  // failing on a missing package.json.
  if (parseArgs(process.argv.slice(2)).help) {
    console.log(HELP_TEXT)
    return 0
  }

  const pkg = readManifest()
  const options = parseArgs(process.argv.slice(2), pkg.kurkle?.buildCjsTypes ?? {})
  const dir = resolve(process.cwd(), options.dir)

  for (const name of buildCjsTypes(dir)) {
    console.log(`write  ${join(options.dir, name)}`)
  }

  return 0
}

// npm installs bin commands as POSIX symlinks
// (node_modules/.bin/kurkle-build-cjs-types -> ../@kurkle/configs/bin/build-cjs-types.mjs).
// When Node runs a script through a symlink, process.argv[1] stays the
// symlink's own path while import.meta.url resolves to its real target, so
// comparing the raw strings never matches for exactly the way this command
// is meant to be run. Both sides go through realpathSync so the comparison
// survives the symlink.
export function isRunningAsMain(scriptUrl, argv1) {
  if (!argv1) {
    return false
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(scriptUrl))
  } catch {
    return false
  }
}

if (isRunningAsMain(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`error  ${err.message ?? String(err)}`)
    process.exitCode = 1
  }
}
