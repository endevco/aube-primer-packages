#!/usr/bin/env node
// Produce `data/packages.json` — the canonical name list aube embeds in its
// metadata primer.
//
// Two inputs are merged:
//   1. npm-rank popularity (direct-install count, fetched from upstream)
//   2. cross-stack transitive popularity (mined by scripts/mine-transitives.mjs)
//
// The merge keeps the output at exactly TOP_N entries: the top (TOP_N -
// supplement_size) popularity entries plus every transitive with score
// >= MIN_STACKS not already in popularity. Net effect: the lowest-rank
// popularity entries are displaced by the most cross-cutting transitives.
//
// Env overrides:
//   TOP_N=2000                       output size
//   PACKAGES_URL=<url>               popularity source (defaults to npm-rank)
//   MIN_STACKS=5                     transitive score threshold
//   SKIP_MINER=1                     skip mining, use existing transitives.json
//   TRANSITIVES_PATH=<path>          override transitives source (default: data/transitives.json)

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const top = Number(process.env.TOP_N ?? 2000)
const sourceUrl = process.env.PACKAGES_URL ?? 'https://tristan-f-r.github.io/npm-rank/PACKAGES.html'
const minStacks = Number(process.env.MIN_STACKS ?? 5)
const transitivesPath = resolve(process.env.TRANSITIVES_PATH ?? `${ROOT}/data/transitives.json`)
const outDir = `${ROOT}/data`

if (!Number.isInteger(top) || top < 1) {
  throw new Error('TOP_N must be a positive integer')
}
if (!Number.isInteger(minStacks) || minStacks < 1) {
  throw new Error('MIN_STACKS must be a positive integer')
}

if (!process.env.SKIP_MINER) {
  console.error('mining transitives (set SKIP_MINER=1 to reuse existing transitives.json)')
  await runScript(`${__dirname}/mine-transitives.mjs`)
}

const popular = parsePackageNames(await fetchText(sourceUrl))
const transitives = loadTransitives(transitivesPath, minStacks)
const popularSet = new Set(popular.slice(0, top))
const supplement = transitives.filter((name) => !popularSet.has(name))
const supplementSize = Math.min(supplement.length, top)
const kept = popular.slice(0, top - supplementSize)
const names = [...kept, ...supplement.slice(0, supplementSize)]

await mkdir(outDir, { recursive: true })
const json = `${JSON.stringify(names, null, 2)}\n`
await writeFile(`${outDir}/packages.json`, json)
await writeFile(`${outDir}/packages.txt`, `${names.join('\n')}\n`)
await writeFile(`${outDir}/packages.sha256`, `${sha256(json)}  packages.json\n`)
console.error(
  `wrote ${names.length} package names ` +
  `(${kept.length} popularity + ${supplementSize} transitives, threshold ≥${minStacks})`,
)

function loadTransitives(path, threshold) {
  if (!existsSync(path)) {
    console.error(`transitives file ${path} not found; emitting popularity-only list`)
    return []
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  const pkgs = Array.isArray(doc) ? doc : doc.packages
  if (!Array.isArray(pkgs)) {
    throw new Error(`${path}: expected array or {packages: array}`)
  }
  return pkgs
    .filter((p) => (typeof p === 'string' ? true : (p?.score ?? Infinity) >= threshold))
    .map((p) => (typeof p === 'string' ? p : p?.name))
    .filter((n) => typeof n === 'string' && n.length > 0)
}

function runScript(script) {
  return new Promise((res, rej) => {
    const child = spawn('node', [script], { stdio: 'inherit' })
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${script} exited ${code}`))))
    child.on('error', rej)
  })
}

async function fetchText(url) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url)
    if (res.ok) return res.text()
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`${url}: HTTP ${res.status}`)
    }
    const retryAfter = Number(res.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30000, 1000 * 2 ** (attempt - 1))
    const wait = Math.max(5000, delay)
    console.error(`${url}: HTTP ${res.status}; retrying in ${Math.round(wait / 1000)}s`)
    await sleep(wait)
  }
  throw new Error(`${url}: retry limit exceeded`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parsePackageNames(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed).filter(isPackageName)
  }
  const names = []
  const seen = new Set()
  for (const match of trimmed.matchAll(/https:\/\/www\.npmjs\.com\/package\/([^"'<>?#\s]+)/g)) {
    const name = decodeURIComponent(match[1])
    if (isPackageName(name) && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  if (names.length) return names
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && isPackageName(line))
  if (lines.length) return lines
  throw new Error('package source did not contain package names')
}

function isPackageName(name) {
  if (/\s/.test(name)) return false
  if (name.startsWith('@')) return /^@[^/]+\/[^/]+$/.test(name)
  return !name.includes('/') && name.length > 0
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}
