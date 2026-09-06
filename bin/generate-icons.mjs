#!/usr/bin/env node

/**
 * Generates the full favicon / PWA icon set from a single source SVG.
 *
 * Reads <dir>/favicon.svg and writes, into the same directory:
 *   - favicon-96x96.png
 *   - apple-touch-icon.png (180x180)
 *   - web-app-manifest-192x192.png
 *   - web-app-manifest-512x512.png
 *   - favicon.ico (multi-resolution: 16, 32, 48)
 *
 * <dir> defaults to docs/public (relative to the current working directory)
 * and can be overridden with --dir for a repository that keeps its site
 * assets elsewhere.
 *
 * Rasterization: sharp (libvips) renders the SVG to PNG at exact pixel
 * dimensions. ICO packaging: png-to-ico bundles multiple PNG buffers into
 * one multi-resolution .ico. Both were chosen because they run headless on
 * any platform (no native `sips`/ImageMagick dependency), sharp resolves
 * exact output dimensions the way `sips` cannot for SVG input, and neither
 * requires a build step (prebuilt binaries). Both are optional peer
 * dependencies of @kurkle/configs — see the README before running this.
 *
 * The two web-app-manifest-*.png files are declared `purpose: maskable` in
 * site.webmanifest: platforms (Android adaptive icons, etc.) crop them to a
 * circle/squircle/rounded-square of their own choosing, so artwork that runs
 * close to the edge gets clipped. Those two are rendered smaller and padded
 * back out to full size (MASKABLE_SAFE_ZONE / the resolved background below)
 * so the mark sits inside the safe zone platforms expect. The non-maskable
 * targets (favicon-96x96, apple-touch-icon, the .ico sizes) are rendered
 * full-bleed as before — shrinking those too would just make the mark
 * smaller for no reason, since nothing masks them.
 */
import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Fraction of the full canvas the artwork occupies in a maskable render.
// 0.8 leaves a 10% margin on every edge, which is the safe-zone platforms
// generally assume for maskable/adaptive icons (content inside the centered
// 80%-diameter circle survives any mask shape). This is a fleet-wide
// decision, not a per-repo one, so it is not configurable from the CLI.
const MASKABLE_SAFE_ZONE = 0.8

// Fallback fill color for the safe-zone margin (and for any transparency
// inside the shrunk artwork itself) when a repository has no
// site.webmanifest, or that manifest has no background_color. Used only as
// a last resort — resolveBackground() below prefers the manifest.
const DEFAULT_MASKABLE_BACKGROUND = '#ffffff'

const pngTargets = [
  { file: 'favicon-96x96.png', size: 96 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'web-app-manifest-192x192.png', maskable: true, size: 192 },
  { file: 'web-app-manifest-512x512.png', maskable: true, size: 512 },
]

const icoSizes = [16, 32, 48]

export const HELP_TEXT = `Usage: kurkle-generate-icons [options]

Generates favicon.ico (16/32/48), favicon-96x96.png, apple-touch-icon.png
(180x180), and the two maskable web-app-manifest-*.png icons from
<dir>/favicon.svg.

Options:
  --dir <path>          Directory holding favicon.svg, and where generated
                         files are written (default: docs/public)
  --background <color>  Fill color for the maskable safe-zone margin
                         (default: background_color from <dir>/site.webmanifest,
                         else #ffffff)
  --help, -h             Show this help and exit
`

// Unrecognized flags used to be ignored silently, so --help fell through to
// parseArgs' defaults and main() went ahead and tried to generate icons
// instead of showing usage.
export function parseArgs(argv) {
  const args = { background: undefined, dir: 'docs/public', help: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inlineValue] = arg.split(/=(.*)/s)

    if (flag === '--dir') {
      args.dir = inlineValue ?? argv[++i]
    } else if (flag === '--background') {
      args.background = inlineValue ?? argv[++i]
    } else if (flag === '--help' || flag === '-h') {
      args.help = true
    }
  }

  return args
}

export class MissingDependencyError extends Error {}

export async function loadRenderers() {
  try {
    const [{ default: sharp }, { default: pngToIco }] = await Promise.all([
      import('sharp'),
      import('png-to-ico'),
    ])
    return { pngToIco, sharp }
  } catch {
    throw new MissingDependencyError(
      'kurkle-generate-icons requires "sharp" and "png-to-ico", which are not installed.\n' +
        '       Install them with: npm install --save-dev sharp png-to-ico'
    )
  }
}

export async function readSourceSvg(publicDir) {
  const sourceSvg = path.join(publicDir, 'favicon.svg')

  try {
    return await readFile(sourceSvg)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `source SVG not found: ${sourceSvg}\n` +
          `       expected a favicon.svg in ${publicDir} (pass --dir to use a different directory)`
      )
    }
    throw err
  }
}

export async function resolveBackground(publicDir, override) {
  if (override) {
    console.log(`using  background ${override} (from --background)`)
    return override
  }

  const manifestPath = path.join(publicDir, 'site.webmanifest')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

    if (manifest.background_color) {
      console.log(`read   background ${manifest.background_color} from site.webmanifest`)
      return manifest.background_color
    }

    console.log(
      `using  default background ${DEFAULT_MASKABLE_BACKGROUND} (site.webmanifest has no background_color)`
    )
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
    console.log(
      `using  default background ${DEFAULT_MASKABLE_BACKGROUND} (no site.webmanifest in ${publicDir})`
    )
  }

  return DEFAULT_MASKABLE_BACKGROUND
}

// Pure arithmetic behind the maskable safe zone: how much of the canvas is
// artwork (innerSize) versus background padding (before/after), split as
// evenly as an odd margin allows. Kept separate from the sharp calls below
// so the numbers themselves — the exact thing that regressed once already
// (see the module doc comment) — are unit-testable without rasterizing
// anything.
export function computeMaskablePadding(size, safeZone = MASKABLE_SAFE_ZONE) {
  const innerSize = Math.round(size * safeZone)
  const margin = size - innerSize
  const before = Math.floor(margin / 2)
  const after = margin - before
  return { after, before, innerSize }
}

// Formats a caught error for the top-level CLI handler. A
// MissingDependencyError's message is already user-facing; anything else
// falls back to its message, or its string form if it has none (e.g. a
// non-Error value was thrown).
export function formatCliError(err) {
  if (err instanceof MissingDependencyError) {
    return err.message
  }
  return err.message ?? String(err)
}

// Orchestrates the actual rendering once everything main() needs (the
// resolved directory, the SVG bytes, and the loaded sharp/pngToIco) is in
// hand. Kept separate from main() so tests can drive it with a fake sharp/
// pngToIco — verifying which files get written, in what order, and with what
// padding — without asking sharp to rasterize anything for real.
export async function generate({ background, pngToIco, publicDir, sharp, svgBuffer }) {
  const maskableBackground = await resolveBackground(publicDir, background)

  async function renderPng(size) {
    return sharp(svgBuffer, { density: 300 }).resize(size, size).png().toBuffer()
  }

  async function renderMaskablePng(size) {
    const { after, before, innerSize } = computeMaskablePadding(size)

    const artwork = await sharp(svgBuffer, { density: 300 })
      .resize(innerSize, innerSize)
      .flatten({ background: maskableBackground })
      .png()
      .toBuffer()

    return sharp(artwork)
      .extend({
        after,
        background: maskableBackground,
        before,
        bottom: after,
        left: before,
        right: after,
        top: before,
      })
      .png()
      .toBuffer()
  }

  await mkdir(publicDir, { recursive: true })

  for (const { file, maskable, size } of pngTargets) {
    const buffer = maskable ? await renderMaskablePng(size) : await renderPng(size)
    await writeFile(path.join(publicDir, file), buffer)
    console.log(`write  ${file} (${size}x${size}${maskable ? ', maskable safe zone' : ''})`)
  }

  const icoBuffers = await Promise.all(icoSizes.map((size) => renderPng(size)))
  const ico = await pngToIco(icoBuffers)
  await writeFile(path.join(publicDir, 'favicon.ico'), ico)
  console.log(`write  favicon.ico (${icoSizes.join('/')})`)
}

export async function main() {
  const { background, dir, help } = parseArgs(process.argv.slice(2))

  if (help) {
    console.log(HELP_TEXT)
    return
  }

  const publicDir = path.resolve(process.cwd(), dir)

  const svgBuffer = await readSourceSvg(publicDir)
  const { pngToIco, sharp } = await loadRenderers()

  await generate({ background, pngToIco, publicDir, sharp, svgBuffer })
}

// npm installs bin commands as POSIX symlinks
// (node_modules/.bin/kurkle-generate-icons -> ../@kurkle/configs/bin/generate-icons.mjs).
// When Node runs a script through a symlink, process.argv[1] stays the
// symlink's own path while import.meta.url resolves to the symlink's real
// target, so comparing the raw strings never matches for exactly the way
// this command is meant to be run - it would silently no-op every time. Both
// sides go through realpathSync so the comparison survives the symlink.
// argv[1] can be missing (REPL, `node -e`) and realpathSync throws on a path
// that no longer exists; either case means "not running as main", not a
// crash.
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

const isMain = isRunningAsMain(import.meta.url, process.argv[1])

if (isMain) {
  try {
    await main()
  } catch (err) {
    console.error(`error  ${formatCliError(err)}`)
    process.exitCode = 1
  }
}
