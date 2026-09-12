import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const buildCjsTypesPath = fileURLToPath(new URL('../bin/build-cjs-types.mjs', import.meta.url))
const checkPackagePath = fileURLToPath(new URL('../bin/check-package.mjs', import.meta.url))

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kurkle-bin-compat-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

// The incident neither bin's own test suite could have caught, because
// neither exercises the other: a repository's `build` script calls
// kurkle-build-cjs-types, `prepack` calls `npm run build`, and
// kurkle-check-package's first move is `npm pack --json` - which runs
// `prepack` *inside itself*. Before this fix, kurkle-build-cjs-types wrote
// its progress to stdout, that line landed ahead of npm's own `[`, and
// kurkle-check-package's `JSON.parse` blew up before reaching a single
// check:
//
//   error  Unexpected token 'w', "write typ"... is not valid JSON
//
// This wires up a real package with both bins in their actual roles -
// `build` invoking kurkle-build-cjs-types, `prepack` invoking `build`,
// kurkle-check-package invoking `npm pack --json` on top of all of it - and
// runs it for real: real subprocesses, real `npm pack`, no fakes standing in
// for either bin. `--ts ''` only skips the TypeScript consumer probes (each
// one needs a real, network-fetched `npm install typescript@<version>`,
// already covered without network in check-package.test.mjs); it does not
// skip `npm pack`, `prepack`, `build`, or attw/publint, which is everything
// this regression runs through.
test('kurkle-build-cjs-types and kurkle-check-package work together in one real package', async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, 'dist'))
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        main: './dist/index.cjs',
        name: 'compat-probe',
        private: false,
        scripts: {
          build: `node ${JSON.stringify(buildCjsTypesPath)} --dir dist`,
          prepack: 'npm run build',
        },
        version: '1.0.0',
      })
    )
    await writeFile(path.join(dir, 'dist', 'index.d.ts'), 'export declare class Controller {}\n')
    await writeFile(path.join(dir, 'dist', 'index.cjs'), 'module.exports = {}\n')

    const result = spawnSync(process.execPath, [checkPackagePath, '--ts', ''], {
      cwd: dir,
      encoding: 'utf8',
    })

    // The exact failure mode this regresses: a JSON parse error surfacing
    // before any check ran, because kurkle-build-cjs-types' own progress
    // line was still sitting on stdout ahead of npm pack's `[`.
    assert.doesNotMatch(result.stderr, /Unexpected token/)
    assert.doesNotMatch(result.stdout, /Unexpected token/)
    assert.match(result.stdout, /publish contract for compat-probe/)
    assert.match(result.stdout, /ok {4}publint/)

    // Proves kurkle-build-cjs-types actually ran as part of `prepack`, not
    // that the pipeline merely tolerated an empty build: the .d.cts twin
    // did not exist until `npm pack` triggered it.
    const generated = await readFile(path.join(dir, 'dist', 'index.d.cts'), 'utf8')
    assert.match(generated, /export declare class Controller/)
  })
})
