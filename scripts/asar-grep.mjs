// Read files out of an Electron asar archive without extracting it.
//
//   node scripts/asar-grep.mjs list  <asar> <substring>
//   node scripts/asar-grep.mjs grep  <asar> <substring> <regex> [maxHits]
//   node scripts/asar-grep.mjs cat   <asar> <path-inside-archive>
//
// Only used for debugging what the host actually ships (DSH internals); the plugin
// itself never reads the asar.

import { readFileSync } from 'node:fs'

const [mode, asarPath, a, b, c] = process.argv.slice(2)
if (!mode || !asarPath) {
  console.error('usage: asar-grep.mjs list|grep|cat <asar> <substring|path> [regex] [maxHits]')
  process.exit(1)
}

const buf = readFileSync(asarPath)
// Layout: uint32 headerPickleSize, uint32 headerSize, uint32 jsonSize, uint32 jsonLen… then JSON, then payload.
const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
const base = 8 + headerSize

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p, out)
    else out.push({ path: p, offset: Number(entry.offset), size: entry.size })
  }
  return out
}

const files = walk(header, '', [])

function readEntry(entry) {
  return buf.subarray(base + entry.offset, base + entry.offset + entry.size)
}

if (mode === 'list') {
  const hits = files.filter((f) => f.path.includes(a)).slice(0, 400)
  for (const f of hits) console.log(`${String(f.size).padStart(9)}  ${f.path}`)
  console.log(`total ${files.length} files, ${hits.length} matched`)
} else if (mode === 'cat') {
  const entry = files.find((f) => f.path === a)
  if (!entry) {
    console.error(`not found: ${a}`)
    process.exit(1)
  }
  process.stdout.write(readEntry(entry))
} else if (mode === 'grep') {
  const re = new RegExp(b, 'g')
  const maxHits = Number(c || 20)
  let hits = 0
  for (const f of files) {
    if (!f.path.includes(a) || !f.size) continue
    const text = readEntry(f).toString('utf8')
    if (!text.includes(b) && !re.test(text)) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits < maxHits; i++) {
      if (re.test(lines[i])) {
        console.log(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
        hits += 1
      }
      re.lastIndex = 0
    }
    if (hits >= maxHits) break
  }
  console.log(`hits ${hits}${hits >= maxHits ? ' (capped)' : ''}`)
}
