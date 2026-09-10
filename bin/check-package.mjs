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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const keep = args.includes('--keep')
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
const config = pkg.kurkle?.checkPackage ?? {}

// The floor and the current release, because neither sees the whole contract on
// its own: an old compiler reports errors a new one has stopped reporting, and a
// new one parses syntax an old one cannot.
const versions = (flag('ts', config.typescript?.join(',')) ?? '5.3,latest').split(',')
const modes = (flag('modes', config.modes?.join(',')) ?? 'node16,nodenext').split(',')

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { encoding: 'utf8', stdio: 'pipe', ...options })

const attempt = (command, commandArgs, options) => {
  try {
    return { ok: true, output: run(command, commandArgs, options) }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

// These ship as dependencies of this package, so resolve them from here rather
// than trusting the consuming repository to have hoisted them. Neither tool can
// be located the same way: `publint` does not export its `package.json`, and
// `@arethetypeswrong/cli` is bin-only and exports no entry point at all.
const requireFrom = createRequire(import.meta.url)

const tryResolve = (specifier) => {
  try {
    return dirname(requireFrom.resolve(specifier))
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

const packageDir = (name) => {
  for (const specifier of [`${name}/package.json`, name]) {
    const from = tryResolve(specifier)
    const found = from && walkUpToManifest(from, name)
    if (found) {
      return found
    }
  }
  throw new Error(`cannot locate ${name}; is @kurkle/configs installed with its dependencies?`)
}

const toolPath = (name, bin) => {
  const dir = packageDir(name)
  const field = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin
  return join(dir, typeof field === 'string' ? field : field[bin])
}

const failures = []
const rows = []

const record = (label, result) => {
  rows.push([label, result.ok ? 'ok' : 'FAIL'])
  if (!result.ok) {
    failures.push({ label, output: result.output.trim() })
  }
}

console.log(`publish contract for ${pkg.name}`)
console.log(`  node ${process.version}, typescript ${versions.join(', ')}`)

const tarball = (() => {
  const out = run('npm', ['pack', '--json', '--pack-destination', tmpdir()])
  return join(tmpdir(), JSON.parse(out)[0].filename)
})()

if (!args.includes('--skip-attw')) {
  record('attw', attempt(process.execPath, [toolPath('@arethetypeswrong/cli', 'attw'), tarball]))
}

if (!args.includes('--skip-publint')) {
  record('publint', attempt(process.execPath, [toolPath('publint', 'publint'), tarball]))
}

const entry = pkg.exports?.['.'] ?? pkg.exports
const hasRequireEntry =
  entry && typeof entry === 'object' && 'require' in entry ? true : Boolean(pkg.main)

const peers = Object.entries(pkg.peerDependencies ?? {})
  .filter(([name]) => pkg.peerDependenciesMeta?.[name]?.optional !== true)
  .map(([name, range]) => `${name}@${range}`)

const dir = mkdtempSync(join(tmpdir(), 'kurkle-consumer-'))
mkdirSync(join(dir, 'src'))
writeFileSync(
  join(dir, 'package.json'),
  `${JSON.stringify({ name: 'consumer-probe', private: true, type: 'commonjs', version: '1.0.0' }, null, 2)}\n`
)

// A namespace import is the one form every package shape accepts — named,
// default and `export =` alike — and assigning it exercises the export as a
// value, not only as a type.
const source = `import * as pkg from '${pkg.name}'\nexport const used: unknown = pkg\n`
writeFileSync(join(dir, 'src', 'consumer.cts'), source)
writeFileSync(join(dir, 'src', 'consumer.mts'), source)

const consumers = [['consumer.mts', 'import']]
if (hasRequireEntry) {
  consumers.unshift(['consumer.cts', 'require'])
} else {
  console.log('  no require entry in exports, skipping the CommonJS consumer')
}

for (const version of versions) {
  run(
    'npm',
    ['install', '--silent', '--no-audit', '--no-fund', `typescript@${version}`, ...peers, tarball],
    {
      cwd: dir,
    }
  )
  const actual = JSON.parse(
    readFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')
  ).version

  for (const [file, kind] of consumers) {
    for (const mode of modes) {
      for (const skipLibCheck of [true, false]) {
        writeFileSync(
          join(dir, 'tsconfig.probe.json'),
          `${JSON.stringify(
            {
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
            },
            null,
            2
          )}\n`
        )

        const result = attempt(
          join(dir, 'node_modules', '.bin', 'tsc'),
          ['-p', 'tsconfig.probe.json'],
          {
            cwd: dir,
          }
        )
        record(`ts${actual} ${kind} ${mode} skipLibCheck=${skipLibCheck}`, result)
      }
    }
  }
}

// The declarations can be perfect while the entry point itself fails to load.
if (hasRequireEntry) {
  record(
    `require() on node ${process.version}`,
    attempt(process.execPath, ['-e', `require(${JSON.stringify(pkg.name)})`], { cwd: dir })
  )
}

const width = Math.max(...rows.map(([label]) => label.length))
for (const [label, result] of rows) {
  console.log(`  ${result === 'ok' ? 'ok  ' : 'FAIL'}  ${label.padEnd(width)}`)
}

if (keep) {
  console.log(`  kept ${dir} and ${tarball}`)
} else {
  rmSync(dir, { force: true, recursive: true })
  rmSync(tarball, { force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${rows.length} checks failed:\n`)
  for (const { label, output } of failures) {
    console.error(`----- ${label}\n${output}\n`)
  }
  process.exit(1)
}

console.log(`  ${rows.length} checks passed`)
