// Create the GitHub release for the current version and upload the npm tarball.
//
// The token is taken from the same credential store git already uses, so this
// never needs a token on the command line or in a file:
//   git credential fill  ->  password=<token>
//
// Requires (only under the DSH sandbox): full access, because git spawns its
// credential helper through pipes.
//
//   node scripts/release.mjs <tarball> [--tag vX.Y.Z] [--dry]

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const REPO = 'levodoubt/project-node-memory'
const args = process.argv.slice(2)
const tarballArg = args.find((a) => !a.startsWith('--'))
const tagFlag = args.indexOf('--tag')
const dry = args.includes('--dry')

if (!tarballArg) {
  console.error('usage: node scripts/release.mjs <tarball.tgz> [--tag vX.Y.Z] [--dry]')
  process.exit(1)
}

const tarball = resolve(tarballArg)
const bytes = readFileSync(tarball)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tag = tagFlag >= 0 ? args[tagFlag + 1] : `v${pkg.version}`

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const m = /^password=(.+)$/m.exec(out)
  if (!m) throw new Error('no GitHub credential available from git credential fill')
  return m[1].trim()
}

const headers = (t) => ({
  authorization: `Bearer ${t}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'project-node-memory-release',
  'x-github-api-version': '2022-11-28',
})

async function api(t, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...headers(t), ...(init.headers || {}) } })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, ok: res.ok, json, text }
}

const main = async () => {
  const t = token()
  console.log(`repo   ${REPO}`)
  console.log(`tag    ${tag}`)
  console.log(`asset  ${basename(tarball)} (${bytes.length} bytes)`)

  if (dry) {
    const existing = await api(t, `/repos/${REPO}/releases/tags/${tag}`)
    console.log(`dry run: release lookup -> ${existing.status}`)
    return
  }

  // 1) release (create, or reuse if the tag is already published)
  let rel = await api(t, `/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: `project-node-memory ${pkg.version}`,
      body: `Installable bundle for DSH.\n\n\`\`\`\nnpm install -g project-node-memory\ndsh plugin --profile <profile> add project-node-memory\ndsh web\n\`\`\`\n\nAttached tarball is the same artifact published to npm.`,
      draft: false,
      prerelease: false,
    }),
  })
  if (rel.status === 422) {
    rel = await api(t, `/repos/${REPO}/releases/tags/${tag}`)
    console.log('release already exists, reusing')
  }
  if (!rel.ok) throw new Error(`create release failed: ${rel.status} ${rel.text.slice(0, 300)}`)
  const releaseId = rel.json.id
  console.log(`release #${releaseId} ${rel.json.html_url}`)

  // 2) asset (skip when a same-name asset is already attached)
  const have = await api(t, `/repos/${REPO}/releases/${releaseId}/assets`)
  if (have.ok && have.json.some((a) => a.name === basename(tarball))) {
    console.log('asset already uploaded, nothing to do')
    return
  }

  const up = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(basename(tarball))}`,
    {
      method: 'POST',
      headers: { ...headers(t), 'content-type': 'application/gzip', 'content-length': String(bytes.length) },
      body: bytes,
    },
  )
  const upText = await up.text()
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${upText.slice(0, 300)}`)
  const asset = JSON.parse(upText)
  console.log(`asset  ${asset.name} ${asset.size} bytes`)
  console.log(`url    ${asset.browser_download_url}`)
  console.log(`local  ${statSync(tarball).size} bytes`)
}

main().catch((err) => {
  console.error(`release failed: ${err.message}`)
  process.exitCode = 1
})
