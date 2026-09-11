import {
  buildCjsTypes,
  HELP_TEXT,
  isRunningAsMain,
  namespacedExports,
  parseArgs,
  readManifest,
  relativeCjsSpecifiers,
  transformDeclaration,
  typeOnlyPackageImports,
  withoutAugmentations,
} from '../bin/build-cjs-types.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kurkle-build-cjs-types-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults dir to "dist" and help to false', () => {
  const options = parseArgs([])
  assert.equal(options.dir, 'dist')
  assert.equal(options.help, false)
})

test('parseArgs reads --dir as two tokens or one with "="', () => {
  assert.equal(parseArgs(['--dir', 'types']).dir, 'types')
  assert.equal(parseArgs(['--dir=types']).dir, 'types')
})

test('parseArgs reads package.json config, and a flag beats it', () => {
  assert.equal(parseArgs([], { dir: 'types' }).dir, 'types')
  assert.equal(parseArgs(['--dir', 'dist'], { dir: 'types' }).dir, 'dist')
})

test('parseArgs reads --help and -h', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
  assert.equal(parseArgs([]).help, false)
})

test('HELP_TEXT documents --dir and its default', () => {
  assert.match(HELP_TEXT, /--dir/)
  assert.match(HELP_TEXT, /dist/)
})

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

test('readManifest reads the package.json of a given directory', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe' }))
    assert.equal(readManifest(dir).name, 'probe')
  })
})

// ---------------------------------------------------------------------------
// Rewrite 1: relative specifiers -> .cjs, so a .d.cts resolves to .d.cts
// ---------------------------------------------------------------------------

test('relativeCjsSpecifiers rewrites a relative .js specifier to .cjs', () => {
  assert.equal(
    relativeCjsSpecifiers(`import { Options } from './options.js'\n`),
    `import { Options } from './options.cjs'\n`
  )
})

test('relativeCjsSpecifiers rewrites every relative specifier in the file', () => {
  const source = `import { A } from './a.js'\nimport { B } from './b.js'\n`
  assert.equal(source.match(/\.cjs'/g), null)
  const result = relativeCjsSpecifiers(source)
  assert.equal((result.match(/\.cjs'/g) ?? []).length, 2)
})

test('relativeCjsSpecifiers leaves a bare package specifier alone', () => {
  const source = `import { Plugin } from 'chart.js'\n`
  assert.equal(relativeCjsSpecifiers(source), source)
})

// ---------------------------------------------------------------------------
// Rewrite 3: type-only + resolution-mode, package imports only
// ---------------------------------------------------------------------------

test('typeOnlyPackageImports adds resolution-mode to a bare value import', () => {
  const result = typeOnlyPackageImports(`import { Plugin } from 'chart.js'\n`)
  assert.match(
    result,
    /^import type \{ Plugin \} from 'chart\.js' with \{ 'resolution-mode': 'import' \};/
  )
})

test('typeOnlyPackageImports adds resolution-mode even when already type-only', () => {
  const result = typeOnlyPackageImports(`import type { ChartType } from 'chart.js'\n`)
  assert.match(
    result,
    /^import type \{ ChartType \} from 'chart\.js' with \{ 'resolution-mode': 'import' \};/
  )
})

test('typeOnlyPackageImports never touches a relative import', () => {
  const source = `import { Options } from './options.js'\n`
  assert.equal(typeOnlyPackageImports(source), source)
})

// ---------------------------------------------------------------------------
// Rewrite 4: drop a package augmentation, caller re-imports the ESM twin
// ---------------------------------------------------------------------------

test('withoutAugmentations removes a declare module block, tracking nested braces', () => {
  const source =
    "declare module 'chart.js' {\n" +
    '  interface PluginOptionsByType<TType extends ChartType> {\n' +
    '    autocolors?: AutocolorsOptions\n' +
    '  }\n' +
    '}\n\n' +
    'export interface AutocolorsOptions {}\n'

  const { removed, source: result } = withoutAugmentations(source)
  assert.equal(removed, true)
  assert.doesNotMatch(result, /declare module/)
  assert.match(result, /export interface AutocolorsOptions \{\}/)
})

test('withoutAugmentations removes every augmentation and reports none left over', () => {
  const source = "declare module 'a' {}\ndeclare module 'b' {}\nexport {}\n"
  const { removed, source: result } = withoutAugmentations(source)
  assert.equal(removed, true)
  assert.equal(result.match(/declare module/g), null)
})

test('withoutAugmentations is a no-op, removed: false, with nothing to drop', () => {
  const source = 'export interface Foo {}\n'
  assert.deepEqual(withoutAugmentations(source), { removed: false, source })
})

test('withoutAugmentations leaves a local (relative-specifier) module block alone', () => {
  // The augmentation this rewrite targets only ever names a bare package
  // specifier (chart.js); a relative one is not a cross-package
  // augmentation and has no ESM twin to re-import it from.
  const source = "declare module './local' {\n  const x: number\n}\n"
  assert.deepEqual(withoutAugmentations(source), { removed: false, source })
})

// ---------------------------------------------------------------------------
// Rewrite 2: export default -> export =, named exports -> merged namespace.
// This is the rewrite that differs between the two known variants (a plugin
// with a default export vs. a chart type with none), and is a no-op for the
// second - the reason one generator produces both.
// ---------------------------------------------------------------------------

test('namespacedExports is a no-op when there is no default export', () => {
  const source =
    'export interface MatrixControllerDatasetOptions {}\nexport declare class MatrixController {}\n'
  assert.equal(namespacedExports(source), source)
})

test('namespacedExports rewrites "export default X" to "export = X" and namespaces the rest', () => {
  const source =
    'export interface AutocolorsOptions {}\n' +
    'export interface AutocolorsContext {}\n' +
    'declare const autocolorPlugin: Plugin\n' +
    'export default autocolorPlugin\n'

  const result = namespacedExports(source)

  assert.match(result, /^export = autocolorPlugin$/m)
  assert.match(
    result,
    /^declare namespace autocolorPlugin \{\n {2}export \{ AutocolorsContext, AutocolorsOptions \}\n\}\n\nexport = autocolorPlugin$/m
  )
  // The named types are no longer exported on their own - they only exist as
  // namespace members now, or "export =" would sit beside other exports
  // (TS2309).
  assert.doesNotMatch(result, /^export interface/m)
  assert.match(result, /^interface AutocolorsOptions \{\}$/m)
})

test('namespacedExports also rewrites "export { X as default }"', () => {
  const source =
    'export interface Options {}\ndeclare const plugin: Plugin\nexport { plugin as default }\n'
  const result = namespacedExports(source)
  assert.match(result, /^export = plugin$/m)
  assert.match(result, /export \{ Options \}/)
})

test('namespacedExports skips the namespace when a default export has no named exports beside it', () => {
  const source = 'declare const plugin: Plugin\nexport default plugin\n'
  const result = namespacedExports(source)
  assert.equal(result, 'declare const plugin: Plugin\nexport = plugin\n')
})

// Locks the namespace member order as deterministic and alphabetical
// regardless of declaration order - the sort's comparator has to actually
// run (Sonar javascript:S2871 flagged an earlier bare `.sort()` here as a
// reliability bug: it works for these inputs today only because every
// element already happens to be a string, which a linter cannot assume from
// the call site alone). Five names, scrambled well past what a stable-sort
// coincidence could fix by accident, from more than one starting letter.
test('namespacedExports sorts namespace members deterministically regardless of declaration order', () => {
  const source =
    'export interface Zebra {}\n' +
    'export interface Apple {}\n' +
    'export interface Mango {}\n' +
    'export interface apple {}\n' +
    'export interface Banana {}\n' +
    'declare const plugin: Plugin\n' +
    'export default plugin\n'

  const result = namespacedExports(source)

  assert.match(result, /export \{ Apple, Banana, Mango, Zebra, apple \}/)
})

// TS interface declarations legitimately merge under a repeated name, so the
// comparator's equal branch is reachable on real input, not just in theory.
test('namespacedExports keeps equal-named members stable, exercising the comparator tie branch', () => {
  const source =
    'export interface Options {}\n' +
    'export interface Options {}\n' +
    'declare const plugin: Plugin\n' +
    'export default plugin\n'

  const result = namespacedExports(source)

  assert.match(result, /export \{ Options, Options \}/)
})

// ---------------------------------------------------------------------------
// transformDeclaration: the four rewrites composed in order
// ---------------------------------------------------------------------------

test('transformDeclaration composes all four rewrites for a default-export file', () => {
  const source =
    "import { ChartType, Plugin } from 'chart.js'\n\n" +
    "import { Options } from './options.js'\n\n" +
    "declare module 'chart.js' {\n" +
    '  interface ChartDatasetProperties<TType extends ChartType, TData> {\n' +
    '    gradient?: Options\n' +
    '  }\n' +
    '}\n\n' +
    'declare const plugin: Plugin\n\n' +
    'export default plugin\n'

  const { removed, source: result } = transformDeclaration(source)

  assert.equal(removed, true)
  assert.match(result, /from '\.\/options\.cjs'/)
  assert.match(
    result,
    /import type \{ ChartType, Plugin \} from 'chart\.js' with \{ 'resolution-mode': 'import' \};/
  )
  assert.doesNotMatch(result, /declare module/)
  assert.match(result, /^export = plugin$/m)
})

test('transformDeclaration is a no-op on rewrite 2 for a file with no default export', () => {
  const source =
    "import { ChartComponent } from 'chart.js'\n\nexport declare class MatrixController {}\n"
  const { removed, source: result } = transformDeclaration(source)
  assert.equal(removed, false)
  assert.match(result, /export declare class MatrixController \{\}/)
})

// ---------------------------------------------------------------------------
// buildCjsTypes: the whole directory pass, and the central equivalence claim
// - one generator, driven only by --dir, produces the same rewrite for both
// known shapes. The measured fact this fixes was two copies differing only
// in which directory name was hard-coded; this proves the directory name
// itself has no bearing on the rewrite, only the .d.ts content does.
// ---------------------------------------------------------------------------

const noDefaultExportFixture =
  "import type { ChartComponent } from 'chart.js'\n\nexport declare class MatrixController implements ChartComponent {}\n"

const defaultExportFixture =
  "import { Plugin } from 'chart.js'\n\n" +
  "declare module 'chart.js' {\n" +
  '  interface PluginOptionsByType {\n' +
  '    autocolors?: AutocolorsOptions\n' +
  '  }\n' +
  '}\n\n' +
  'export interface AutocolorsOptions {}\n\n' +
  'declare const autocolorPlugin: Plugin\n\n' +
  'export { autocolorPlugin as default }\n'

test('buildCjsTypes writes a .d.cts twin for every .d.ts in the directory', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'index.d.ts'), noDefaultExportFixture)
    await writeFile(path.join(dir, 'index.d.mts'), 'ignored')

    const written = buildCjsTypes(dir)

    assert.deepEqual(written, ['index.d.cts'])
    const output = await readFile(path.join(dir, 'index.d.cts'), 'utf8')
    assert.match(
      output,
      /import type \{ ChartComponent \} from 'chart\.js' with \{ 'resolution-mode': 'import' \};/
    )
    assert.match(output, /export declare class MatrixController/)
  })
})

test('buildCjsTypes produces byte-identical output for the same content under "dist" or "types"', async () => {
  const outputs = {}

  for (const dirName of ['dist', 'types']) {
    await withTempDir(async (parent) => {
      const dir = path.join(parent, dirName)
      await mkdir(dir)
      await writeFile(path.join(dir, 'index.d.ts'), noDefaultExportFixture)
      buildCjsTypes(dir)
      outputs[dirName] = await readFile(path.join(dir, 'index.d.cts'), 'utf8')
    })
  }

  assert.equal(outputs.dist, outputs.types)
})

test('buildCjsTypes prefixes a resolution-mode side-effect import only when an augmentation was removed', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'no-augmentation.d.ts'), noDefaultExportFixture)
    await writeFile(path.join(dir, 'has-augmentation.d.ts'), defaultExportFixture)

    buildCjsTypes(dir)

    const withoutAugmentation = await readFile(path.join(dir, 'no-augmentation.d.cts'), 'utf8')
    const withAugmentation = await readFile(path.join(dir, 'has-augmentation.d.cts'), 'utf8')

    assert.doesNotMatch(withoutAugmentation, /resolution-mode': 'import' \};\nimport type \{\}/)
    assert.doesNotMatch(withoutAugmentation, /^import type \{\} from/m)
    assert.match(
      withAugmentation,
      /^import type \{\} from '\.\/has-augmentation\.js' with \{ 'resolution-mode': 'import' \};/
    )
  })
})

test('buildCjsTypes applies export = and the namespace merge for a default-export file', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'index.d.ts'), defaultExportFixture)
    buildCjsTypes(dir)
    const output = await readFile(path.join(dir, 'index.d.cts'), 'utf8')

    assert.match(output, /^export = autocolorPlugin$/m)
    assert.match(
      output,
      /declare namespace autocolorPlugin \{\n {2}export \{ AutocolorsOptions \}\n\}/
    )
    assert.doesNotMatch(output, /declare module 'chart\.js'/)
  })
})

test('buildCjsTypes ignores files that are not .d.ts', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'index.d.ts'), noDefaultExportFixture)
    await writeFile(path.join(dir, 'index.js'), 'module.exports = {}\n')
    const written = buildCjsTypes(dir)
    assert.deepEqual(written, ['index.d.cts'])
  })
})

// ---------------------------------------------------------------------------
// isRunningAsMain: see test/build-cjs-types-entrypoint.test.mjs for the
// black-box regression through a real symlink subprocess. These cover the
// two edge cases that don't need a subprocess: no argv[1] at all, and a
// path that resolves to something other than this file.
// ---------------------------------------------------------------------------

test('isRunningAsMain is false without an argv[1]', () => {
  assert.equal(isRunningAsMain(pathToFileURL('/a/b.mjs').href, undefined), false)
})

test('isRunningAsMain is false, not throwing, for a path that does not exist', () => {
  assert.equal(isRunningAsMain(pathToFileURL('/a/b.mjs').href, '/does/not/exist'), false)
})

test('isRunningAsMain is false for a real but unrelated file', async () => {
  await withTempDir(async (dir) => {
    const self = path.join(dir, 'self.mjs')
    const other = path.join(dir, 'other.mjs')
    await writeFile(self, '')
    await writeFile(other, '')
    assert.equal(isRunningAsMain(pathToFileURL(self).href, other), false)
  })
})

test('isRunningAsMain is true when argv[1] is the same file directly, no symlink involved', async () => {
  await withTempDir(async (dir) => {
    const self = path.join(dir, 'self.mjs')
    await writeFile(self, '')
    assert.equal(isRunningAsMain(pathToFileURL(self).href, self), true)
  })
})
