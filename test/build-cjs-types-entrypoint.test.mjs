import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../bin/build-cjs-types.mjs', import.meta.url))

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kurkle-build-cjs-types-entrypoint-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

// The same regression this suite guards for kurkle-check-package and
// kurkle-generate-icons: @kurkle/configs@1.5.0 exited 0 having written
// nothing, because the entrypoint guard compared process.argv[1] (which
// stays the symlink's own path when Node runs a script through one, exactly
// how npm installs bin commands - node_modules/.bin/kurkle-build-cjs-types
// -> ../@kurkle/configs/bin/build-cjs-types.mjs) against import.meta.url's
// raw string, which never matched. A gate that always exits 0 is worse than
// no gate: it looks like the CommonJS declarations were built when they
// were not. The fix (isRunningAsMain, realpath on both sides) landed in
// 1.5.1; this proves it holds here too by actually running the symlink as a
// subprocess, not by re-asserting the fix inline.
test('running through a node_modules/.bin-style symlink with no input still fails loudly, not exit 0', async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const symlinkPath = path.join(binDir, 'kurkle-build-cjs-types')
    await symlink(scriptPath, symlinkPath)

    // No package.json in cwd: main() reads it before anything else, so this
    // is "missing input" the same way a missing favicon.svg or an
    // unpublishable package is for the other two commands. The broken
    // 1.5.0 guard would have produced exit 0 and no output at all here,
    // which is indistinguishable from success without this assertion.
    const result = spawnSync(process.execPath, [symlinkPath], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.notEqual(
      result.status,
      0,
      `expected a non-zero exit (main() should have run and failed reading package.json), got 0 with stdout: ${result.stdout}`
    )
    assert.match(result.stderr, /^error /m)
  })
})

test('running directly (no symlink) with no input also fails loudly, for comparison', async () => {
  await withTempDir(async (dir) => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^error /m)
  })
})

test('running through the symlink with --help still invokes main(), exits 0', async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const symlinkPath = path.join(binDir, 'kurkle-build-cjs-types')
    await symlink(scriptPath, symlinkPath)

    const result = spawnSync(process.execPath, [symlinkPath, '--help'], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage: kurkle-build-cjs-types/)
  })
})

// End-to-end through the symlink with real input, proving the whole pipeline
// - not just the guard - runs when invoked the way npm actually invokes it.
test('running through the symlink against a real directory writes the .d.cts twin', async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const symlinkPath = path.join(binDir, 'kurkle-build-cjs-types')
    await symlink(scriptPath, symlinkPath)

    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe' }))
    await mkdir(path.join(dir, 'types'))
    await writeFile(
      path.join(dir, 'types', 'index.d.ts'),
      "import type { ChartComponent } from 'chart.js'\n\nexport declare class Controller implements ChartComponent {}\n"
    )

    const result = spawnSync(process.execPath, [symlinkPath, '--dir', 'types'], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    // Progress goes to stderr, not stdout: this command commonly runs from a
    // `build` script invoked by `prepack`, which itself runs inside
    // `npm pack --json` - a caller (kurkle-check-package included) whose
    // entire contract for stdout is "nothing but that one JSON document".
    // See the regression test below for the incident this guards.
    assert.match(result.stderr, /write {2}types[/\\]index\.d\.cts/)
    assert.equal(result.stdout, '')
  })
})

// The actual incident: kurkle-build-cjs-types wrote its progress to stdout,
// and when a repository's `build` script (which commonly runs from
// `prepack`) called it, that line landed ahead of the `[` that
// `npm pack --json` was about to print - breaking every caller of that JSON,
// kurkle-check-package included, with "Unexpected token 'w', ... is not
// valid JSON". This is the exact scenario, one level up: prepack calling
// this command directly, and stdout has to be silent on success for that to
// be safe.
test('running through the symlink writes nothing to stdout on success, only to stderr', async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const symlinkPath = path.join(binDir, 'kurkle-build-cjs-types')
    await symlink(scriptPath, symlinkPath)

    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'probe',
        private: false,
        scripts: { prepack: `node ${JSON.stringify(symlinkPath)}` },
        version: '1.0.0',
      })
    )
    await mkdir(path.join(dir, 'dist'))
    await writeFile(path.join(dir, 'dist', 'index.d.ts'), 'export declare class Controller {}\n')

    // The real reproduction: run it exactly the way check-package does,
    // through npm pack --json, and prove the JSON that comes back is still
    // parseable.
    const result = spawnSync('npm', ['pack', '--json', '--pack-destination', dir], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotThrow(
      () => JSON.parse(result.stdout),
      `stdout was not valid JSON:\n${result.stdout}`
    )
  })
})
