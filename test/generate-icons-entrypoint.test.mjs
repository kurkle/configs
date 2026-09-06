import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../bin/generate-icons.mjs', import.meta.url))

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kurkle-generate-icons-entrypoint-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

// This is a black-box regression test for a real incident: npm installs bin
// commands as POSIX symlinks (node_modules/.bin/kurkle-generate-icons ->
// ../@kurkle/configs/bin/generate-icons.mjs) - exactly how this command is
// meant to be run. The entrypoint guard used to compare process.argv[1]
// (which stays the symlink's own path when Node runs a script through one)
// against import.meta.url's realpath, which never matched: main() silently
// never ran, nothing was written, nothing was printed, and the process
// still exited 0. `npm run icons` looked like it worked. See
// isRunningAsMain() in the module itself for the fix.
//
// Every unit test elsewhere in this suite imports main()/generate() directly
// and would never have caught this - they never invoke the file as a
// subprocess through its own guard, so this has to be an actual `node
// <symlink>` run to be a real regression test rather than a re-statement of
// the fix.
test('running the script through a node_modules/.bin-style symlink still invokes main()', async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const symlinkPath = path.join(binDir, 'kurkle-generate-icons')
    await symlink(scriptPath, symlinkPath)

    await writeFile(path.join(dir, 'favicon.svg'), '<svg></svg>')

    // sharp/png-to-ico are deliberately not installed in this repository's
    // own devDependencies (see the README: they are optional peer
    // dependencies). Running through the symlink without them still proves
    // the guard invoked main() for real: it fails at loadRenderers(), which
    // only runs after parseArgs and a successful readSourceSvg. The bug
    // being regression-tested here produced no output and exit code 0
    // instead - a silent no-op, not a loud, attributable failure.
    const result = spawnSync(process.execPath, [symlinkPath, '--dir', dir], {
      encoding: 'utf8',
    })

    assert.notEqual(
      result.status,
      0,
      `expected a non-zero exit (main() should have run and failed at the missing sharp/png-to-ico), got 0 with stdout: ${result.stdout}`
    )
    assert.match(result.stderr, /requires "sharp" and "png-to-ico"/)
  })
})

test('running the script directly (no symlink) still invokes main(), for comparison', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'favicon.svg'), '<svg></svg>')

    const result = spawnSync(process.execPath, [scriptPath, '--dir', dir], {
      encoding: 'utf8',
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /requires "sharp" and "png-to-ico"/)
  })
})
