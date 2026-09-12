import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../bin/check-package.mjs', import.meta.url))

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kurkle-check-package-entrypoint-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

// The same regression this suite guards for kurkle-generate-icons: npm installs
// bin commands as POSIX symlinks, and an entrypoint guard that compares
// process.argv[1] against import.meta.url without realpath never matches when
// the command is run the way it is meant to be. It would exit 0 having done
// nothing — a gate that always passes is worse than no gate.
test('running through a node_modules/.bin-style symlink still invokes main()', async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const symlinkPath = path.join(binDir, 'kurkle-check-package')
    await symlink(scriptPath, symlinkPath)

    const result = spawnSync(process.execPath, [symlinkPath, '--help'], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage: kurkle-check-package/)
  })
})

test('--help prints the usage and exits 0 when run directly, for comparison', async () => {
  await withTempDir(async (dir) => {
    const result = spawnSync(process.execPath, [scriptPath, '--help'], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /--skip-publint/)
  })
})

// Every other run reads package.json for `kurkle.checkPackage`, so a run outside
// a package has to fail loudly rather than throw a bare ENOENT stack.
test('a run outside a package fails with a message, not a stack', async () => {
  await withTempDir(async (dir) => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /^error /m)
  })
})

test('a package with nothing to publish still reaches the checks and fails there', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'not-publishable', private: true, version: '1.0.0' })
    )

    // `npm pack` refuses a private package, so this proves main() got past
    // argument parsing and the manifest read into the run itself.
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stdout, /publish contract for not-publishable/)
  })
})

// The regression: `npm pack --json` is the very first thing main() does, and
// its documented contract - stdout is exactly one JSON document - only holds
// when nothing else writes to that same stdout first. A `prepack` script
// (commonly `npm run build`) runs *inside* that call, and anything the
// build logs to stdout lands ahead of npm's own `[`. An earlier
// @kurkle/configs release of kurkle-build-cjs-types did exactly this. Before
// the fix this failed with "error  Unexpected token 'w', ... is not valid
// JSON" before reaching a single check; `--ts ''` keeps this fast and
// network-free by skipping the TypeScript consumer probes (already covered
// elsewhere), leaving attw, publint and the require() smoke test to prove
// the run gets past `npm pack` at all.
test('a build tool writing to stdout during prepack does not break the JSON parse', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        main: 'index.js',
        name: 'noisy-build-probe',
        private: false,
        scripts: { prepack: 'node -e "console.log(\'write dist/index.d.cts\')"' },
        version: '1.0.0',
      })
    )
    await writeFile(path.join(dir, 'index.js'), 'module.exports = {}\n')

    const result = spawnSync(process.execPath, [scriptPath, '--ts', ''], {
      cwd: dir,
      encoding: 'utf8',
    })

    assert.doesNotMatch(result.stderr, /Unexpected token/)
    assert.match(result.stdout, /publish contract for noisy-build-probe/)
    assert.match(result.stdout, /ok {4}attw/)
    assert.match(result.stdout, /ok {4}publint/)
  })
})
