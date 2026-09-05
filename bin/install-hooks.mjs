#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const force = process.argv.includes('--force')
const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'githooks')
const target = join(process.cwd(), '.githooks')

mkdirSync(target, { recursive: true })

for (const name of readdirSync(source)) {
  const destination = join(target, name)

  if (existsSync(destination) && !force) {
    console.log(`skip   .githooks/${name} (already exists, pass --force to overwrite)`)
    continue
  }

  copyFileSync(join(source, name), destination)
  chmodSync(destination, 0o755)
  console.log(`write  .githooks/${name}`)
}

const { status } = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })

if (status === 0) {
  console.log('config core.hooksPath = .githooks')
} else {
  console.warn('warn   could not set core.hooksPath, is this a git repository?')
  process.exitCode = 1
}
