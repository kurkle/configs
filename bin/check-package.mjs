#!/usr/bin/env node

// The publish contract gate: `attw`, `publint`, and a consumer that is actually
// compiled and loaded.
//
// The first two check how a specifier *resolves*. Neither type-checks the shipped
// declarations against a consumer, so a package can be green in both and still
// fail to compile — a `declare module` augmentation inside a `.d.cts`, an
// `export =` beside other exports, syntax the consumer's TypeScript is too old to
// parse. This compiles a real consumer, and then requires the entry point.
//
//   kurkle-check-package [--ts 5.3,latest] [--modes node16,nodenext]
//                        [--skip-attw] [--skip-publint] [--keep]

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HELP_TEXT = `Usage: kurkle-check-package [options]

  --ts <list>       Comma separated TypeScript versions (default: 5.3,latest)
  --modes <list>    Comma separated module resolution modes (default: node16,nodenext)
  --skip-attw       Skip the arethetypeswrong check
  --skip-publint    Skip the publint check
  --keep            Leave the tarball and the probe project on disk
  --help            Show this message`

// The floor and the current release, because neither sees the whole contract on
// its own: an old compiler reports errors a new one has stopped reporting, and a
// new one parses syntax an old one cannot.
export const DEFAULT_VERSIONS = ['5.3', 'latest']
export const DEFAULT_MODES = ['node16', 'nodenext']

const list = (value) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

export function parseArgs(argv, config = {}) {
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }

  const chosen = (name, configured, fallback) => {
    const raw = flag(name)
    if (raw !== undefined) {
      return list(raw)
    }
    return configured?.length ? [...configured] : [...fallback]
  }

  return {
    help: argv.includes('--help'),
    keep: argv.includes('--keep'),
    modes: chosen('modes', config.modes, DEFAULT_MODES),
    skipAttw: argv.includes('--skip-attw'),
    skipPublint: argv.includes('--skip-publint'),
    versions: chosen('ts', config.typescript, DEFAULT_VERSIONS),
  }
}

export const readManifest = (dir = process.cwd()) =>
  JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))

// `npm pack --json` documents its stdout as exactly one JSON array - but
// that promise only holds when nothing else writes to the same stdout
// first. Its `prepack` (commonly `npm run build`) runs *inside* this call,
// and anything that build logs to stdout - webpack does by default, a
// misconfigured or buggy build step can always add more - lands ahead of
// npm's own `[`. No npm flag changes this: `--loglevel=silent`, `--silent`
// and `npm_config_loglevel=silent` all still let a build's own stdout
// through, because that fd is inherited directly rather than filtered by
// npm's own logger. So this does not trust the whole stream is JSON; it
// looks for where a JSON value actually starts.
//
// Every line beginning `[` or `{` is a candidate, tried in the order they
// appear and kept only if the remainder from there on actually parses -
// which npm's own output always does, being the last thing printed. A
// build tool's own noise might itself contain a line starting with one of
// those characters without being JSON (a log line reading "[build] done",
// say); such a line fails to parse as a complete document and is skipped
// rather than trusted just because it matched the character.
export function parseNpmPackOutput(output) {
  const starts = [...output.matchAll(/^[[{]/gm)].map((match) => match.index)

  for (const at of starts) {
    try {
      return JSON.parse(output.slice(at))
    } catch {
      // Not the real start - keep looking.
    }
  }

  throw new SyntaxError(`no JSON array or object found in npm pack output:\n${output}`)
}

// `main` is the node10 entry point, so a package with one is requireable even
// when its `exports` map says nothing about `require`.
export function hasRequireEntry(pkg) {
  const entry = pkg.exports?.['.'] ?? pkg.exports
  if (entry && typeof entry === 'object' && 'require' in entry) {
    return true
  }
  return Boolean(pkg.main)
}

export function peerSpecs(pkg) {
  return Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => pkg.peerDependenciesMeta?.[name]?.optional !== true)
    .map(([name, range]) => `${name}@${range}`)
}

// A namespace import is the one form every package shape accepts — named,
// default and `export =` alike — and assigning it exercises the export as a
// value, not only as a type.
export const consumerSource = (name) =>
  `import * as pkg from '${name}'\nexport const used: unknown = pkg\n`

export const probeConfig = (file, mode, skipLibCheck) => ({
  compilerOptions: {
    esModuleInterop: true,
    module: mode,
    moduleResolution: mode,
    noEmit: true,
    skipLibCheck,
    strict: true,
    target: 'es2022',
    types: [],
  },
  include: [`src/${file}`],
})

const defaultExec = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { encoding: 'utf8', stdio: 'pipe', ...options })

export function attempt(exec, command, commandArgs, options) {
  try {
    return { ok: true, output: exec(command, commandArgs, options) ?? '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` || String(error) }
  }
}

// These ship as dependencies of this package, so resolve them from here rather
// than trusting the consuming repository to have hoisted them. Neither tool can
// be located the same way: `publint` does not export its `package.json`, and
// `@arethetypeswrong/cli` is bin-only and exports no entry point at all.
const requireFrom = createRequire(import.meta.url)

const tryResolve = (specifier, resolver) => {
  try {
    return dirname(resolver(specifier))
  } catch {
    return undefined
  }
}

const walkUpToManifest = (from, name) => {
  let dir = from
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) {
      return dir
    }
    dir = dirname(dir)
  }
  return undefined
}

export function packageDir(name, resolver = requireFrom.resolve) {
  for (const specifier of [`${name}/package.json`, name]) {
    const from = tryResolve(specifier, resolver)
    const found = from && walkUpToManifest(from, name)
    if (found) {
      return found
    }
  }
  throw new Error(`cannot locate ${name}; is @kurkle/configs installed with its dependencies?`)
}

export function toolPath(name, bin, resolver) {
  const dir = packageDir(name, resolver)
  const field = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin
  return join(dir, typeof field === 'string' ? field : field[bin])
}

export function formatRows(rows) {
  const width = Math.max(...rows.map(({ label }) => label.length))
  return rows.map(({ label, ok }) => `  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(width)}`)
}

export function formatFailures(rows) {
  const failed = rows.filter((row) => !row.ok)
  if (failed.length === 0) {
    return ''
  }
  const details = failed.map(({ label, output }) => `----- ${label}\n${output.trim()}\n`)
  return `\n${failed.length} of ${rows.length} checks failed:\n\n${details.join('\n')}`
}

// One installed TypeScript, every consumer shape it can be pointed at. The
// version is read back from the probe project rather than taken from the
// requested range, so the label names what actually ran.
export function compileCells({ consumers, dir, exec, modes, record }) {
  const version = JSON.parse(
    readFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')
  ).version

  for (const [file, kind] of consumers) {
    for (const mode of modes) {
      for (const skipLibCheck of [true, false]) {
        writeFileSync(
          join(dir, 'tsconfig.probe.json'),
          `${JSON.stringify(probeConfig(file, mode, skipLibCheck), null, 2)}\n`
        )
        record(
          `ts${version} ${kind} ${mode} skipLibCheck=${skipLibCheck}`,
          attempt(exec, join(dir, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.probe.json'], {
            cwd: dir,
          })
        )
      }
    }
  }
}

// Kept separate from main() so tests can drive the whole run with a fake exec
// rather than a real npm, tsc and node.
export function checkPackage({
  exec = defaultExec,
  log = console.log,
  options,
  pkg,
  resolver,
  tempRoot = tmpdir(),
}) {
  const rows = []
  const record = (label, result) => rows.push({ label, ok: result.ok, output: result.output })

  log(`publish contract for ${pkg.name}`)
  log(`  node ${process.version}, typescript ${options.versions.join(', ')}`)

  const packed = exec('npm', ['pack', '--json', '--pack-destination', tempRoot])
  const tarball = join(tempRoot, parseNpmPackOutput(packed)[0].filename)

  if (!options.skipAttw) {
    record(
      'attw',
      attempt(exec, process.execPath, [
        toolPath('@arethetypeswrong/cli', 'attw', resolver),
        tarball,
      ])
    )
  }

  if (!options.skipPublint) {
    record(
      'publint',
      attempt(exec, process.execPath, [toolPath('publint', 'publint', resolver), tarball])
    )
  }

  const requireable = hasRequireEntry(pkg)
  const dir = mkdtempSync(join(tempRoot, 'kurkle-consumer-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'consumer-probe', private: true, type: 'commonjs', version: '1.0.0' }, null, 2)}\n`
  )
  writeFileSync(join(dir, 'src', 'consumer.cts'), consumerSource(pkg.name))
  writeFileSync(join(dir, 'src', 'consumer.mts'), consumerSource(pkg.name))

  const consumers = [['consumer.mts', 'import']]
  if (requireable) {
    consumers.unshift(['consumer.cts', 'require'])
  } else {
    log('  no require entry in exports, skipping the CommonJS consumer')
  }

  for (const version of options.versions) {
    exec(
      'npm',
      [
        'install',
        '--silent',
        '--no-audit',
        '--no-fund',
        `typescript@${version}`,
        ...peerSpecs(pkg),
        tarball,
      ],
      { cwd: dir }
    )

    compileCells({ consumers, dir, exec, modes: options.modes, record })
  }

  // The declarations can be perfect while the entry point itself fails to load.
  if (requireable) {
    record(
      `require() on node ${process.version}`,
      attempt(exec, process.execPath, ['-e', `require(${JSON.stringify(pkg.name)})`], { cwd: dir })
    )
  }

  for (const line of formatRows(rows)) {
    log(line)
  }

  if (options.keep) {
    log(`  kept ${dir} and ${tarball}`)
  } else {
    rmSync(dir, { force: true, recursive: true })
    rmSync(tarball, { force: true })
  }

  return rows
}

export function main() {
  // Before the manifest, so `--help` answers from anywhere rather than failing
  // on a missing package.json.
  if (parseArgs(process.argv.slice(2)).help) {
    console.log(HELP_TEXT)
    return 0
  }

  const pkg = readManifest()
  const options = parseArgs(process.argv.slice(2), pkg.kurkle?.checkPackage ?? {})
  const rows = checkPackage({ options, pkg })
  const failures = formatFailures(rows)

  if (failures) {
    console.error(failures)
    return 1
  }

  console.log(`  ${rows.length} checks passed`)
  return 0
}

// npm installs bin commands as POSIX symlinks
// (node_modules/.bin/kurkle-check-package -> ../@kurkle/configs/bin/check-package.mjs).
// When Node runs a script through a symlink, process.argv[1] stays the symlink's
// own path while import.meta.url resolves to its real target, so comparing the
// raw strings never matches for exactly the way this command is meant to be run.
// Both sides go through realpathSync so the comparison survives the symlink.
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
