#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'

const top = Number(process.env.TOP_N ?? 2000)
const sourceUrl = process.env.PACKAGES_URL ?? 'https://tristan-f-r.github.io/npm-rank/PACKAGES.html'
const outDir = new URL('../data/', import.meta.url)

if (!Number.isInteger(top) || top < 1) {
  throw new Error('TOP_N must be a positive integer')
}

const names = parsePackageNames(await fetchText(sourceUrl)).slice(0, top)

await mkdir(outDir, { recursive: true })
const json = `${JSON.stringify(names, null, 2)}\n`
await writeFile(new URL('packages.json', outDir), json)
await writeFile(new URL('packages.txt', outDir), `${names.join('\n')}\n`)
await writeFile(new URL('packages.sha256', outDir), `${sha256(json)}  packages.json\n`)
console.error(`wrote ${names.length} package names`)

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
