import {
  attempt,
  checkPackage,
  consumerSource,
  DEFAULT_MODES,
  DEFAULT_VERSIONS,
  formatFailures,
  formatRows,
  hasRequireEntry,
  isRunningAsMain,
  packageDir,
  parseArgs,
  parseNpmPackOutput,
  peerSpecs,
  probeConfig,
  readManifest,
  toolPath,
} from '../bin/check-package.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kurkle-check-package-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

test('parseArgs falls back to the floor and the current release', () => {
  const options = parseArgs([])
  assert.deepEqual(options.versions, DEFAULT_VERSIONS)
  assert.deepEqual(options.modes, DEFAULT_MODES)
  assert.equal(options.keep, false)
  assert.equal(options.skipAttw, false)
  assert.equal(options.skipPublint, false)
  assert.equal(options.help, false)
})

test('parseArgs reads package.json config, and flags beat it', () => {
  const config = { modes: ['nodenext'], typescript: ['5.4', '6'] }

  assert.deepEqual(parseArgs([], config).versions, ['5.4', '6'])
  assert.deepEqual(parseArgs([], config).modes, ['nodenext'])
  assert.deepEqual(parseArgs(['--ts', '7'], config).versions, ['7'])
  assert.deepEqual(parseArgs(['--modes', 'node16'], config).modes, ['node16'])
})

test('parseArgs trims list entries and drops empty ones', () => {
  assert.deepEqual(parseArgs(['--ts', ' 5.3 , latest ,']).versions, ['5.3', 'latest'])
})

test('parseArgs does not hand back the caller its own config arrays', () => {
  const config = { typescript: ['5.4'] }
  parseArgs([], config).versions.push('mutated')
  assert.deepEqual(config.typescript, ['5.4'])
})

test('parseArgs reads the boolean flags', () => {
  const options = parseArgs(['--keep', '--skip-attw', '--skip-publint', '--help'])
  assert.equal(options.keep, true)
  assert.equal(options.skipAttw, true)
  assert.equal(options.skipPublint, true)
  assert.equal(options.help, true)
})

test('hasRequireEntry finds a require condition, nested or flat', () => {
  assert.equal(hasRequireEntry({ exports: { '.': { require: './x.cjs' } } }), true)
  assert.equal(hasRequireEntry({ exports: { require: './x.cjs' } }), true)
})

test('hasRequireEntry falls back to main, the node10 entry point', () => {
  assert.equal(hasRequireEntry({ main: 'index.js' }), true)
  assert.equal(hasRequireEntry({ exports: { '.': { import: './x.js' } } }), false)
  assert.equal(hasRequireEntry({}), false)
})

test('hasRequireEntry survives a string exports shorthand', () => {
  assert.equal(hasRequireEntry({ exports: './x.js' }), false)
})

test('peerSpecs keeps required peers and drops optional ones', () => {
  const pkg = {
    peerDependencies: { 'chart.js': '^4.0.0', sharp: '^0.35.0' },
    peerDependenciesMeta: { sharp: { optional: true } },
  }
  assert.deepEqual(peerSpecs(pkg), ['chart.js@^4.0.0'])
  assert.deepEqual(peerSpecs({}), [])
})

test('the consumer imports a namespace, which every package shape accepts', () => {
  const source = consumerSource('chartjs-chart-matrix')
  assert.match(source, /import \* as pkg from 'chartjs-chart-matrix'/)
  // Assigning it exercises the export as a value, not only as a type: a
  // declaration that only type-checks would pass a type-position-only probe.
  assert.match(source, /export const used: unknown = pkg/)
})

test('probeConfig pins module and moduleResolution together', () => {
  const config = probeConfig('consumer.cts', 'node16', false)
  assert.equal(config.compilerOptions.module, 'node16')
  assert.equal(config.compilerOptions.moduleResolution, 'node16')
  assert.equal(config.compilerOptions.skipLibCheck, false)
  assert.deepEqual(config.include, ['src/consumer.cts'])
})

test('attempt reports a thrown command as a failure with its output', () => {
  const failure = attempt(
    () => {
      const error = new Error('spawn failed')
      error.stdout = 'out\n'
      error.stderr = 'err\n'
      throw error
    },
    'tsc',
    []
  )
  assert.equal(failure.ok, false)
  assert.equal(failure.output, 'out\nerr\n')
})

test('attempt still reports a failure when the error carries no streams', () => {
  const failure = attempt(() => {
    throw new Error('boom')
  }, 'tsc')
  assert.equal(failure.ok, false)
  assert.match(failure.output, /boom/)
})

test('attempt reports success even when the command prints nothing', () => {
  const success = attempt(() => undefined, 'tsc', [])
  assert.deepEqual(success, { ok: true, output: '' })
})

test('formatRows pads the labels into one column', () => {
  const lines = formatRows([
    { label: 'attw', ok: true },
    { label: 'ts7.0.2 require node16', ok: false },
  ])
  assert.equal(lines[0], '  ok    attw                  ')
  assert.equal(lines[1], '  FAIL  ts7.0.2 require node16')
})

test('formatFailures is empty when everything passed', () => {
  assert.equal(formatFailures([{ label: 'attw', ok: true }]), '')
})

test('formatFailures names the failures and keeps their output', () => {
  const summary = formatFailures([
    { label: 'attw', ok: true },
    { label: 'ts5.3.3 require node16', ok: false, output: 'error TS2309: ...\n' },
  ])
  assert.match(summary, /1 of 2 checks failed/)
  assert.match(summary, /----- ts5\.3\.3 require node16/)
  assert.match(summary, /error TS2309/)
})

test('packageDir finds a package that does not export its package.json', async () => {
  // publint's real shape: `publint/package.json` is not exported, so resolution
  // has to start from the entry point and walk up.
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'node_modules', 'fake-tool')
    mkdirSync(path.join(home, 'src'), { recursive: true })
    await writeFile(
      path.join(home, 'package.json'),
      JSON.stringify({ bin: { 'fake-tool': './src/cli.js' }, name: 'fake-tool', version: '1.0.0' })
    )
    await writeFile(path.join(home, 'src', 'cli.js'), '')

    const resolver = (specifier) => {
      if (specifier === 'fake-tool/package.json') {
        throw new Error('ERR_PACKAGE_PATH_NOT_EXPORTED')
      }
      return path.join(home, 'src', 'cli.js')
    }

    assert.equal(packageDir('fake-tool', resolver), home)
    assert.equal(toolPath('fake-tool', 'fake-tool', resolver), path.join(home, 'src', 'cli.js'))
  })
})

test('packageDir explains itself when neither strategy resolves', () => {
  assert.throws(
    () =>
      packageDir('missing-tool', () => {
        throw new Error('nope')
      }),
    /cannot locate missing-tool/
  )
})

test('isRunningAsMain is false without an argv[1], and for an unrelated path', () => {
  assert.equal(isRunningAsMain(pathToFileURL('/a/b.mjs').href, undefined), false)
  assert.equal(isRunningAsMain(pathToFileURL('/a/b.mjs').href, '/does/not/exist'), false)
})

test('readManifest reads the package.json of a given directory', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe' }))
    assert.equal(readManifest(dir).name, 'probe')
  })
})

// The regression: `npm pack --json` promises stdout is exactly one JSON
// document, but a package's `prepack` (commonly `npm run build`) runs
// *inside* that call, and anything the build itself logs to stdout - such
// as an earlier @kurkle/configs release of kurkle-build-cjs-types - lands
// ahead of npm's own output. No npm flag (verified: --loglevel=silent,
// --silent, npm_config_loglevel=silent) stops a child script's own stdout
// from passing through, so this has to tolerate the noise rather than
// assume it away.
test('parseNpmPackOutput parses clean npm pack output', () => {
  const clean = `${JSON.stringify([{ filename: 'probe-1.0.0.tgz' }])}\n`
  assert.deepEqual(parseNpmPackOutput(clean), [{ filename: 'probe-1.0.0.tgz' }])
})

test('parseNpmPackOutput skips a build tool writing to stdout ahead of the JSON', () => {
  const noisy = `write dist/index.d.cts\n${JSON.stringify([{ filename: 'probe-1.0.0.tgz' }])}\n`
  assert.deepEqual(parseNpmPackOutput(noisy), [{ filename: 'probe-1.0.0.tgz' }])
})

test('parseNpmPackOutput skips several lines of noise, not just one', () => {
  const noisy =
    'rollup v4.0.0\nwrite dist/index.js\nwrite dist/index.d.cts\n' +
    `${JSON.stringify([{ filename: 'probe-1.0.0.tgz' }])}\n`
  assert.deepEqual(parseNpmPackOutput(noisy), [{ filename: 'probe-1.0.0.tgz' }])
})

test('parseNpmPackOutput is not fooled by a noise line that merely starts with "[" or "{"', () => {
  // A line like this looks like a JSON-array start to a naive `indexOf('[')`
  // search, but it is not valid JSON on its own - the parser has to actually
  // try it, fail, and move on to the real start further down.
  const noisy = `[build] compiling\n${JSON.stringify([{ filename: 'probe-1.0.0.tgz' }])}\n`
  assert.deepEqual(parseNpmPackOutput(noisy), [{ filename: 'probe-1.0.0.tgz' }])
})

test('parseNpmPackOutput throws a clear error when there is no JSON at all', () => {
  assert.throws(() => parseNpmPackOutput('npm ERR! something went wrong\n'), SyntaxError)
})

// The whole run, driven with a fake exec: no npm, no tsc, no node subprocess.
// `npm install` writes the typescript manifest the way the real one would, since
// checkPackage reads the version back out of the probe project afterwards.
function fakeExec(failing = new Set()) {
  const calls = []
  return {
    calls,
    exec(command, commandArgs = [], options) {
      calls.push({ args: commandArgs, command, options })

      if (commandArgs[0] === 'pack') {
        return JSON.stringify([{ filename: 'probe-1.0.0.tgz' }])
      }

      if (commandArgs[0] === 'install') {
        const home = path.join(options.cwd, 'node_modules', 'typescript')
        mkdirSync(home, { recursive: true })
        writeFileSync(
          path.join(home, 'package.json'),
          JSON.stringify({ name: 'typescript', version: '9.9.9' })
        )
        return ''
      }

      const label = `${command} ${commandArgs.join(' ')}`
      for (const needle of failing) {
        if (label.includes(needle)) {
          const error = new Error('failed')
          error.stdout = `error TS9999: ${needle}\n`
          throw error
        }
      }
      return ''
    },
  }
}

// attw and publint are located by module resolution, so the fake stands in as a
// package whose manifest carries the name being looked for.
async function fakeTools(root) {
  const homes = new Map()

  for (const [name, bin] of [
    ['@arethetypeswrong/cli', 'attw'],
    ['publint', 'publint'],
  ]) {
    const home = path.join(root, 'tools', bin)
    mkdirSync(home, { recursive: true })
    await writeFile(
      path.join(home, 'package.json'),
      JSON.stringify({ bin: { [bin]: './cli.js' }, name, version: '1.0.0' })
    )
    homes.set(name, home)
  }

  return (specifier) => {
    const name = specifier.replace(/\/package\.json$/, '')
    const home = homes.get(name)
    if (!home) {
      throw new Error(`unknown ${specifier}`)
    }
    return path.join(home, 'package.json')
  }
}

async function withProbe(run) {
  await withTempDir(async (dir) => {
    await run(dir, await fakeTools(dir))
  })
}

test('checkPackage runs every consumer cell, plus the tools and the smoke test', async () => {
  await withProbe(async (tempRoot, resolver) => {
    const { calls, exec } = fakeExec()
    const rows = checkPackage({
      exec,
      log: () => {},
      options: parseArgs(['--keep']),
      pkg: { main: 'index.js', name: 'probe', peerDependencies: { 'chart.js': '^4.0.0' } },
      resolver,
      tempRoot,
    })

    // 2 tools + 2 versions x 2 consumers x 2 modes x 2 skipLibCheck + require()
    assert.equal(rows.length, 19)
    assert.ok(rows.every((row) => row.ok))

    const labels = rows.map((row) => row.label)
    assert.ok(labels.includes('attw'))
    assert.ok(labels.includes('publint'))
    assert.ok(labels.includes('ts9.9.9 require node16 skipLibCheck=false'))
    assert.ok(labels.includes('ts9.9.9 import nodenext skipLibCheck=true'))
    assert.ok(labels.some((label) => label.startsWith('require() on node ')))

    const install = calls.find((call) => call.args[0] === 'install')
    assert.ok(install.args.includes('chart.js@^4.0.0'), 'required peers are installed')
  })
})

// The regression at the checkPackage() level, not just parseNpmPackOutput()
// in isolation: a build tool that writes to stdout ahead of npm's own JSON
// - exactly what an earlier @kurkle/configs release of kurkle-build-cjs-types
// did from inside a `prepack` - must not derail the run before it reaches a
// single check.
test('checkPackage tolerates a build tool writing to stdout ahead of npm pack --json', async () => {
  await withProbe(async (tempRoot, resolver) => {
    const { exec } = fakeExec()
    const noisyExec = (command, commandArgs, options) => {
      const result = exec(command, commandArgs, options)
      return commandArgs[0] === 'pack' ? `write dist/index.d.cts\n${result}` : result
    }

    const rows = checkPackage({
      exec: noisyExec,
      log: () => {},
      options: parseArgs(['--keep']),
      pkg: { main: 'index.js', name: 'probe', peerDependencies: { 'chart.js': '^4.0.0' } },
      resolver,
      tempRoot,
    })

    assert.equal(rows.length, 19)
    assert.ok(rows.every((row) => row.ok))
  })
})

test('checkPackage skips the CommonJS consumer for a package with no require entry', async () => {
  await withProbe(async (tempRoot, resolver) => {
    const lines = []
    const { exec } = fakeExec()
    const rows = checkPackage({
      exec,
      log: (line) => lines.push(line),
      options: parseArgs(['--skip-attw', '--skip-publint']),
      pkg: { exports: { '.': { import: './x.js' } }, name: 'probe' },
      resolver,
      tempRoot,
    })

    assert.equal(rows.length, 8)
    assert.ok(rows.every((row) => row.label.includes('import')))
    assert.ok(lines.some((line) => line.includes('skipping the CommonJS consumer')))
  })
})

test('checkPackage reports a failing cell without stopping the run', async () => {
  await withProbe(async (tempRoot, resolver) => {
    const { exec } = fakeExec(new Set(['tsconfig.probe.json']))
    const rows = checkPackage({
      exec,
      log: () => {},
      options: parseArgs(['--skip-attw', '--skip-publint', '--ts', '5.3']),
      pkg: { main: 'index.js', name: 'probe' },
      resolver,
      tempRoot,
    })

    const compiles = rows.filter((row) => row.label.startsWith('ts'))
    assert.equal(compiles.length, 8)
    assert.ok(compiles.every((row) => !row.ok))
    assert.match(formatFailures(rows), /error TS9999/)
  })
})

test('checkPackage cleans up the probe project unless --keep is given', async () => {
  await withProbe(async (tempRoot, resolver) => {
    const { calls, exec } = fakeExec()
    checkPackage({
      exec,
      log: () => {},
      options: parseArgs(['--skip-attw', '--skip-publint', '--ts', '5.3']),
      pkg: { main: 'index.js', name: 'probe' },
      resolver,
      tempRoot,
    })

    const probe = calls.find((call) => call.options?.cwd)?.options.cwd
    assert.ok(probe, 'the probe project was used')
    assert.equal(existsSync(probe), false)
  })
})

test('the probe project is CommonJS, so .cts and .mts mean what they should', async () => {
  await withProbe(async (tempRoot, resolver) => {
    const { calls, exec } = fakeExec()
    checkPackage({
      exec,
      log: () => {},
      options: parseArgs(['--keep', '--skip-attw', '--skip-publint', '--ts', '5.3']),
      pkg: { main: 'index.js', name: 'probe' },
      resolver,
      tempRoot,
    })

    const probe = calls.find((call) => call.options?.cwd).options.cwd
    const manifest = JSON.parse(await readFile(path.join(probe, 'package.json'), 'utf8'))
    assert.equal(manifest.type, 'commonjs')
  })
})
