// Push release-notes/<version>.md into the GitHub Release for tag v<version>.
//
//   node scripts/release-notes.mjs 1.3.3
//
// The release itself is created by CI (gh release create with the packaged tarball);
// this script only replaces its body, so the notes live in git next to the code.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const OWNER = 'levodoubt'
const REPO = 'project-node-memory'
const version = (process.argv[2] || '').replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}

const file = new URL(`../release-notes/${version}.md`, import.meta.url)
if (!existsSync(file)) {
  console.error(`missing release-notes/${version}.md`)
  process.exit(1)
}
const body = readFileSync(file, 'utf8')

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const m = /^password=(.+)$/m.exec(out)
  if (!m) throw new Error('no GitHub credential from git credential fill')
  return m[1].trim()
}

const headers = {
  authorization: `Bearer ${token()}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'project-node-memory-release-notes',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
}

const rel = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/v${version}`, { headers })
const relJson = await rel.json()
if (!rel.ok) {
  console.error(`release v${version}: HTTP ${rel.status} ${relJson.message || ''}`)
  process.exit(1)
}

const patch = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${relJson.id}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ body, name: `v${version}` }),
})
const patched = await patch.json()
if (!patch.ok) {
  console.error(`patch: HTTP ${patch.status} ${patched.message || ''}`)
  process.exit(1)
}
console.log(`release v${version} body updated (${body.length} chars) ${patched.html_url}`)
