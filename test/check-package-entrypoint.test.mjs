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
