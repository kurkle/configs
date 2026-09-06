import {
  computeMaskablePadding,
  formatCliError,
  generate,
  HELP_TEXT,
  isRunningAsMain,
  loadRenderers,
  MissingDependencyError,
  main,
  parseArgs,
  readSourceSvg,
  resolveBackground,
} from '../bin/generate-icons.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kurkle-generate-icons-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

function captureLogs() {
  const lines = []
  const original = console.log
  console.log = (line) => lines.push(line)
  return {
    lines,
    restore() {
      console.log = original
    },
  }
}

// parseArgs

test('parseArgs defaults to docs/public with no background override and help off', () => {
  assert.deepEqual(parseArgs([]), { background: undefined, dir: 'docs/public', help: false })
})

test('parseArgs reads --dir as a separate argument', () => {
  assert.deepEqual(parseArgs(['--dir', 'assets/site']), {
    background: undefined,
    dir: 'assets/site',
    help: false,
  })
})

test('parseArgs reads --dir=value', () => {
  assert.deepEqual(parseArgs(['--dir=assets/site']), {
    background: undefined,
    dir: 'assets/site',
    help: false,
  })
})

test('parseArgs reads --background as a separate argument', () => {
  assert.deepEqual(parseArgs(['--background', '#112233']), {
    background: '#112233',
    dir: 'docs/public',
    help: false,
  })
})

test('parseArgs reads --background=value, including a value containing "="', () => {
  assert.deepEqual(parseArgs(['--background=#112233']), {
    background: '#112233',
    dir: 'docs/public',
    help: false,
  })
})

test('parseArgs reads both flags together, in either order', () => {
  assert.deepEqual(parseArgs(['--background', '#fff', '--dir', 'out']), {
    background: '#fff',
    dir: 'out',
    help: false,
  })
  assert.deepEqual(parseArgs(['--dir=out', '--background=#fff']), {
    background: '#fff',
    dir: 'out',
    help: false,
  })
})

test('parseArgs recognizes --help and -h', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
  assert.equal(parseArgs(['--dir', 'out', '--help']).help, true)
})

// readSourceSvg

test('readSourceSvg returns the file contents when favicon.svg exists', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'favicon.svg'), '<svg></svg>')
    const buffer = await readSourceSvg(dir)
    assert.equal(buffer.toString('utf8'), '<svg></svg>')
  })
})

test('readSourceSvg reports the exact path it looked for when favicon.svg is missing', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      readSourceSvg(dir),
      (err) => {
        assert.match(err.message, /source SVG not found/)
        assert.ok(err.message.includes(path.join(dir, 'favicon.svg')))
        assert.match(err.message, /--dir/)
        return true
      },
      'expected a descriptive ENOENT message'
    )
  })
})

test('readSourceSvg rethrows a non-ENOENT error unchanged, without the friendly wrapper', async () => {
  await withTempDir(async (dir) => {
    // A directory in favicon.svg's place fails with EISDIR, not ENOENT: the
    // "expected a favicon.svg in ..." message would be misleading here, so
    // readSourceSvg must let this one through as-is.
    await mkdir(path.join(dir, 'favicon.svg'))
    await assert.rejects(readSourceSvg(dir), (err) => {
      assert.equal(err.code, 'EISDIR')
      assert.doesNotMatch(err.message, /expected a favicon\.svg/)
      return true
    })
  })
})

// resolveBackground

test('resolveBackground prefers an explicit --background override over any manifest', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, 'site.webmanifest'),
      JSON.stringify({ background_color: '#000000' })
    )
    const log = captureLogs()
    try {
      const background = await resolveBackground(dir, '#ff00ff')
      assert.equal(background, '#ff00ff')
      assert.ok(log.lines.some((line) => line.includes('#ff00ff')))
    } finally {
      log.restore()
    }
  })
})

test('resolveBackground reads background_color from site.webmanifest when present', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, 'site.webmanifest'),
      JSON.stringify({ background_color: '#1144ff' })
    )
    const log = captureLogs()
    try {
      const background = await resolveBackground(dir, undefined)
      assert.equal(background, '#1144ff')
      assert.ok(
        log.lines.some((line) => line.includes('#1144ff') && line.includes('site.webmanifest'))
      )
    } finally {
      log.restore()
    }
  })
})

test('resolveBackground falls back to #ffffff and says so when there is no site.webmanifest', async () => {
  await withTempDir(async (dir) => {
    const log = captureLogs()
    try {
      const background = await resolveBackground(dir, undefined)
      assert.equal(background, '#ffffff')
      assert.ok(
        log.lines.some((line) => line.includes('#ffffff') && line.includes('no site.webmanifest'))
      )
    } finally {
      log.restore()
    }
  })
})

test('resolveBackground falls back to #ffffff and says so when the manifest has no background_color', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'site.webmanifest'), JSON.stringify({ name: 'Example' }))
    const log = captureLogs()
    try {
      const background = await resolveBackground(dir, undefined)
      assert.equal(background, '#ffffff')
      assert.ok(
        log.lines.some((line) => line.includes('#ffffff') && line.includes('no background_color'))
      )
    } finally {
      log.restore()
    }
  })
})

test('resolveBackground lets a malformed manifest fail loudly instead of silently defaulting', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'site.webmanifest'), '{ not json')
    await assert.rejects(resolveBackground(dir, undefined))
  })
})

// loadRenderers

test('loadRenderers reports both missing packages and the install command when sharp/png-to-ico are not installed', async () => {
  // @kurkle/configs deliberately keeps sharp and png-to-ico out of its own
  // devDependencies (see the README): they are optional peer dependencies,
  // so this repository's own test run exercises the exact "not installed"
  // path a consumer hits before adding them.
  await assert.rejects(
    loadRenderers(),
    (err) => {
      assert.ok(err instanceof MissingDependencyError)
      assert.match(err.message, /sharp/)
      assert.match(err.message, /png-to-ico/)
      assert.match(err.message, /npm install --save-dev sharp png-to-ico/)
      return true
    },
    'expected a MissingDependencyError naming both packages and the install command'
  )
})

// main
//
// Only the part of main() that runs before any rasterization is exercised
// here: it wires parseArgs, readSourceSvg and loadRenderers together, and a
// missing optional dependency should still surface as a MissingDependencyError
// all the way out, uncaught. Everything past that point calls sharp directly
// and is out of scope for these tests (see the README and loadRenderers test
// above for why sharp/png-to-ico are not installed in this repository).

test('main propagates a MissingDependencyError once past argument parsing and reading the SVG', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'favicon.svg'), '<svg></svg>')
    const originalArgv = process.argv
    process.argv = ['node', 'generate-icons.mjs', '--dir', dir]
    try {
      await assert.rejects(main(), (err) => err instanceof MissingDependencyError)
    } finally {
      process.argv = originalArgv
    }
  })
})

test('main prints usage and returns on --help instead of trying to generate icons', async () => {
  // Regression: unrecognized flags used to be ignored silently, so --help
  // fell through to parseArgs' defaults and main() went on to look for
  // docs/public/favicon.svg - which does not exist here, so this would have
  // rejected instead of printing usage and returning cleanly.
  const originalArgv = process.argv
  process.argv = ['node', 'generate-icons.mjs', '--help']
  const log = captureLogs()
  try {
    await main()
    assert.ok(log.lines.some((line) => line === HELP_TEXT))
  } finally {
    process.argv = originalArgv
    log.restore()
  }
})

// generate
//
// A fake sharp/pngToIco pair, not a mock of sharp's internals: it records
// what it was called with and returns a small placeholder buffer, so these
// tests verify OUR orchestration (which files get written, in what order,
// with what padding and background threaded through) without asking sharp
// to rasterize anything for real — that part is sharp's job, proven against
// a real SVG and real sharp separately (see the PR description).

function createFakeSharp() {
  const calls = []

  function fakeSharp(input, options) {
    const record = { input, ops: [], options }
    calls.push(record)
    const chain = {
      extend: (options) => {
        record.ops.push(['extend', options])
        return chain
      },
      flatten: (options) => {
        record.ops.push(['flatten', options])
        return chain
      },
      png: () => {
        record.ops.push(['png'])
        return chain
      },
      resize: (width, height) => {
        record.ops.push(['resize', width, height])
        return chain
      },
      toBuffer: async () => Buffer.from(JSON.stringify(record.ops)),
    }
    return chain
  }

  fakeSharp.calls = calls
  return fakeSharp
}

function createFakePngToIco() {
  const calls = []
  async function fakePngToIco(buffers) {
    calls.push(buffers)
    return Buffer.from('fake-ico')
  }
  fakePngToIco.calls = calls
  return fakePngToIco
}

test('generate writes exactly the five expected files, non-maskable ones full-bleed', async () => {
  await withTempDir(async (dir) => {
    const sharp = createFakeSharp()
    const pngToIco = createFakePngToIco()

    await generate({
      background: '#1144ff',
      pngToIco,
      publicDir: dir,
      sharp,
      svgBuffer: Buffer.from('<svg></svg>'),
    })

    const files = (await readdir(dir)).sort()
    assert.deepEqual(files, [
      'apple-touch-icon.png',
      'favicon-96x96.png',
      'favicon.ico',
      'web-app-manifest-192x192.png',
      'web-app-manifest-512x512.png',
    ])

    // The non-maskable renders (favicon-96x96, apple-touch-icon, and the
    // three ICO sizes) resize straight to the target size, full-bleed: no
    // flatten/extend padding call.
    const nonMaskableSizes = [96, 180, 16, 32, 48]
    for (const size of nonMaskableSizes) {
      const call = sharp.calls.find(
        (c) => c.ops.some(([op, w]) => op === 'resize' && w === size) && c.ops.length === 2
      )
      assert.ok(call, `expected a full-bleed resize to ${size}`)
      assert.deepEqual(
        call.ops.map(([op]) => op),
        ['resize', 'png']
      )
    }
  })
})

test('generate pads the two maskable renders using computeMaskablePadding, with the resolved background', async () => {
  await withTempDir(async (dir) => {
    const sharp = createFakeSharp()
    const pngToIco = createFakePngToIco()

    await generate({
      background: '#1144ff',
      pngToIco,
      publicDir: dir,
      sharp,
      svgBuffer: Buffer.from('<svg></svg>'),
    })

    for (const size of [192, 512]) {
      const { after, before, innerSize } = computeMaskablePadding(size)

      // First pass: resize down to the safe-zone inner size and flatten
      // onto the resolved background.
      const innerIndex = sharp.calls.findIndex((c) =>
        c.ops.some(([op, w]) => op === 'resize' && w === innerSize)
      )
      assert.ok(
        innerIndex >= 0,
        `expected a resize to the ${size} safe-zone inner size ${innerSize}`
      )
      const [, flattenOptions] = sharp.calls[innerIndex].ops.find(([op]) => op === 'flatten')
      assert.deepEqual(flattenOptions, { background: '#1144ff' })

      // Second pass: renderMaskablePng immediately re-wraps that flattened
      // buffer to pad it back out to full size, so it is the very next
      // sharp() call, using exactly computeMaskablePadding's numbers.
      const padded = sharp.calls[innerIndex + 1]
      const [, extendOptions] = padded.ops.find(([op]) => op === 'extend')
      assert.deepEqual(extendOptions, {
        after,
        background: '#1144ff',
        before,
        bottom: after,
        left: before,
        right: after,
        top: before,
      })
    }
  })
})

test('generate packs exactly the three ICO sizes into favicon.ico, in order', async () => {
  await withTempDir(async (dir) => {
    const sharp = createFakeSharp()
    const pngToIco = createFakePngToIco()

    await generate({
      background: '#ffffff',
      pngToIco,
      publicDir: dir,
      sharp,
      svgBuffer: Buffer.from('<svg></svg>'),
    })

    assert.equal(pngToIco.calls.length, 1)
    assert.equal(pngToIco.calls[0].length, 3)
  })
})

test('generate logs one write line per file, naming maskable renders as such', async () => {
  await withTempDir(async (dir) => {
    const sharp = createFakeSharp()
    const pngToIco = createFakePngToIco()
    const log = captureLogs()

    try {
      await generate({
        background: '#ffffff',
        pngToIco,
        publicDir: dir,
        sharp,
        svgBuffer: Buffer.from('<svg></svg>'),
      })
    } finally {
      log.restore()
    }

    assert.ok(
      log.lines.some(
        (line) =>
          line.includes('web-app-manifest-192x192.png') && line.includes('maskable safe zone')
      )
    )
    assert.ok(
      log.lines.some((line) => line.includes('favicon-96x96.png') && !line.includes('maskable'))
    )
    assert.ok(log.lines.some((line) => line.includes('favicon.ico (16/32/48)')))
  })
})

// isRunningAsMain
//
// The full regression this is fixing - the guard silently no-opping when
// run through a node_modules/.bin symlink, exactly how npm installs this
// command - is covered end-to-end with a real subprocess and a real symlink
// in test/generate-icons-entrypoint.test.mjs. These are the fast unit-level
// edge cases for the comparison itself.

test('isRunningAsMain matches through a real symlink, via realpath', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = path.join(dir, 'script.mjs')
    await writeFile(scriptPath, '')
    const symlinkPath = path.join(dir, 'symlinked-entry')
    await symlink(scriptPath, symlinkPath)

    assert.equal(isRunningAsMain(pathToFileURL(scriptPath).href, symlinkPath), true)
  })
})

test('isRunningAsMain matches when argv[1] is the same path directly, no symlink involved', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = path.join(dir, 'script.mjs')
    await writeFile(scriptPath, '')

    assert.equal(isRunningAsMain(pathToFileURL(scriptPath).href, scriptPath), true)
  })
})

test('isRunningAsMain does not match a different file', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = path.join(dir, 'script.mjs')
    const otherPath = path.join(dir, 'other.mjs')
    await writeFile(scriptPath, '')
    await writeFile(otherPath, '')

    assert.equal(isRunningAsMain(pathToFileURL(scriptPath).href, otherPath), false)
  })
})

test('isRunningAsMain returns false, not throw, when argv[1] is missing', () => {
  assert.equal(isRunningAsMain(pathToFileURL('/anything').href, undefined), false)
})

test('isRunningAsMain returns false, not throw, when argv[1] points at nothing', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = path.join(dir, 'script.mjs')
    await writeFile(scriptPath, '')

    assert.equal(
      isRunningAsMain(pathToFileURL(scriptPath).href, path.join(dir, 'does-not-exist')),
      false
    )
  })
})

// computeMaskablePadding
//
// This is the exact arithmetic that regressed once already (a maskable-icon
// safe-zone fix had to be hand-propagated across three repos within an hour
// of the script being written), so it gets its own coverage independent of
// any actual rendering.

test('computeMaskablePadding splits an even margin equally on both sides', () => {
  // 192 * 0.8 = 153.6 -> rounds to 154; margin 38 splits evenly.
  assert.deepEqual(computeMaskablePadding(192, 0.8), { after: 19, before: 19, innerSize: 154 })
  // 512 * 0.8 = 409.6 -> rounds to 410; margin 102 splits evenly.
  assert.deepEqual(computeMaskablePadding(512, 0.8), { after: 51, before: 51, innerSize: 410 })
})

test('computeMaskablePadding puts the extra pixel of an odd margin after the artwork', () => {
  // 97 * 0.8 = 77.6 -> rounds to 78; margin 19 is odd: floor(19/2)=9 before, 10 after.
  assert.deepEqual(computeMaskablePadding(97, 0.8), { after: 10, before: 9, innerSize: 78 })
})

test('computeMaskablePadding defaults to the fleet-wide 0.8 safe zone', () => {
  assert.deepEqual(computeMaskablePadding(192), computeMaskablePadding(192, 0.8))
})

test('computeMaskablePadding leaves no padding at all at a safe zone of 1', () => {
  assert.deepEqual(computeMaskablePadding(192, 1), { after: 0, before: 0, innerSize: 192 })
})

// formatCliError

test('formatCliError passes a MissingDependencyError message through as-is', () => {
  const err = new MissingDependencyError('install sharp and png-to-ico')
  assert.equal(formatCliError(err), 'install sharp and png-to-ico')
})

test('formatCliError uses an ordinary error message', () => {
  assert.equal(formatCliError(new Error('boom')), 'boom')
})

test('formatCliError falls back to the string form of a thrown non-Error value', () => {
  assert.equal(formatCliError('just a string'), 'just a string')
})
