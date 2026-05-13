#!/usr/bin/env node
// Resolve each stack from data/seeds.json via `npm install --package-lock-only`
// and score every transitive package by how many stacks pulled it in. Writes
// data/transitives.json as a ranked array of `{ name, score, stacks }`.
//
// Run standalone for fast iteration, or invoked by scripts/generate.mjs
// during the monthly refresh. Network is required; results are deterministic
// for a given seeds file + npm registry state.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const seedsPath = process.env.SEEDS_PATH ?? join(ROOT, 'data/seeds.json')
const outPath = process.env.TRANSITIVES_OUT ?? join(ROOT, 'data/transitives.json')
const concurrency = Math.max(1, Number(process.env.MINER_CONCURRENCY ?? 4))

const seedsDoc = JSON.parse(readFileSync(seedsPath, 'utf8'))
const stacks = seedsDoc.stacks ?? seedsDoc
const stackNames = Object.keys(stacks).filter((s) => !s.startsWith('_'))
if (stackNames.length === 0) throw new Error(`no stacks found in ${seedsPath}`)

console.error(`mining ${stackNames.length} stacks (concurrency=${concurrency})`)

const score = new Map()
const failures = []

await runWithConcurrency(stackNames, concurrency, async (stackName) => {
  const deps = stacks[stackName]
  if (!Array.isArray(deps) || deps.length === 0) {
    failures.push({ stack: stackName, reason: 'empty deps' })
    return
  }
  const dir = mkdtempSync(join(tmpdir(), `aube-mine-${stackName}-`))
  try {
    const pkg = {
      name: `mine-${stackName}`,
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries(deps.map((d) => [d, 'latest'])),
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    const { code, stderr } = await run('npm', [
      'install',
      '--package-lock-only',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--silent',
    ], { cwd: dir })
    if (code !== 0) {
      failures.push({ stack: stackName, reason: `npm exit=${code}`, stderr: stderr.slice(-500) })
      return
    }
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
    let entries = 0
    for (const path of Object.keys(lock.packages ?? {})) {
      if (!path.startsWith('node_modules/')) continue
      let name = path.slice('node_modules/'.length)
      while (name.includes('/node_modules/')) name = name.split('/node_modules/').pop()
      if (!name) continue
      if (!score.has(name)) score.set(name, new Set())
      score.get(name).add(stackName)
      entries++
    }
    console.error(`  ${stackName}: ok (${entries} entries)`)
  } catch (e) {
    failures.push({ stack: stackName, reason: e.message })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const entries = [...score.entries()]
  .map(([name, stacksSet]) => ({
    name,
    score: stacksSet.size,
    stacks: [...stacksSet].sort(),
  }))
  .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

const output = {
  generated_at: new Date().toISOString(),
  source: {
    seeds_file: seedsPath.replace(`${ROOT}/`, ''),
    stack_count: stackNames.length,
    success_count: stackNames.length - failures.length,
  },
  failures,
  packages: entries,
}
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`)
console.error(`\nwrote ${entries.length} packages to ${outPath}`)
if (failures.length) console.error(`stacks that failed: ${failures.length}`)

function run(cmd, args, opts) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => res({ code, stdout, stderr }))
    child.on('error', (err) => res({ code: -1, stdout, stderr: stderr + err.message }))
  })
}

async function runWithConcurrency(items, n, fn) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      await fn(item)
    }
  })
  await Promise.all(workers)
}
