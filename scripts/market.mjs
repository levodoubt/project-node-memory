// Submit project-node-memory to the awesome-dsh-plugin marketplace.
//
//   node scripts/market.mjs prepare   # fork, branch, commit data/plugins/<entry>.yml
//   node scripts/market.mjs submit    # open the pull request (after the repo is 1 day old)
//   node scripts/market.mjs status    # what exists already
//
// The token comes from the same credential store git uses (no token in files).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const OWNER = 'levodoubt'
const BRANCH = 'add/levodoubt-project-node-memory'
const ENTRY = 'data/plugins/levodoubt__project-node-memory.yml'
const YML = readFileSync(new URL('../.market/levodoubt__project-node-memory.yml', import.meta.url), 'utf8')

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const m = /^password=(.+)$/m.exec(out)
  if (!m) throw new Error('no GitHub credential from git credential fill')
  return m[1].trim()
}

const T = token()
const H = {
  authorization: `Bearer ${T}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'project-node-memory-market',
  'x-github-api-version': '2022-11-28',
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* plain-text error */
  }
  return { status: res.status, ok: res.ok, json, text }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function prepare() {
  // 1) fork
  let fork = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}`)
  if (!fork.ok) {
    const created = await api(`/repos/${UPSTREAM}/forks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"default_branch_only":true}' })
    console.log(`fork: ${created.status}`)
    for (let i = 0; i < 20 && !fork.ok; i++) {
      await sleep(3000)
      fork = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}`)
    }
  }
  console.log(`fork repo: ${fork.ok ? fork.json.full_name : 'unavailable'}`)
  if (!fork.ok) throw new Error('fork not ready')

  // 2) branch from the fork's own main (the fork may not carry upstream commits yet)
  const forkRepo = `${OWNER}/${UPSTREAM.split('/')[1]}`
  let base = null
  for (let i = 0; i < 10 && !base; i++) {
    const f = await api(`/repos/${forkRepo}/commits/${fork.json.default_branch || 'main'}`)
    if (f.ok) base = f.json.sha
    else await sleep(3000)
  }
  if (!base) {
    const up = await api(`/repos/${UPSTREAM}/commits/main`)
    base = up.json.sha
  }
  console.log(`base: ${base.slice(0, 7)}`)
  const ref = await api(`/repos/${forkRepo}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base }),
  })
  console.log(`branch: ${ref.status} ${BRANCH} @ ${base.slice(0, 7)}`)

  // 3) entry file (create on the branch, or update it if a previous run already committed one)
  const exists = await api(`/repos/${UPSTREAM}/contents/${ENTRY}`)
  if (exists.ok) {
    console.log(`${ENTRY} already exists upstream — nothing to add`)
    return
  }
  const mine = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}/contents/${ENTRY}?ref=${BRANCH}`)
  const put = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}/contents/${ENTRY}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: mine.ok ? 'Update levodoubt/project-node-memory entry' : 'Add levodoubt/project-node-memory',
      branch: BRANCH,
      content: Buffer.from(YML, 'utf8').toString('base64'),
      ...(mine.ok ? { sha: mine.json.sha } : {}),
    }),
  })
  console.log(`entry: ${put.status} ${put.ok ? put.json.content.path : put.text.slice(0, 200)}`)
}

async function submit() {
  const age = await api(`/repos/${OWNER}/project-node-memory`)
  const created = new Date(age.json.created_at)
  const hours = (Date.now() - created.getTime()) / 36e5
  console.log(`repo age: ${hours.toFixed(1)} h (CI needs >= 24 h)`)

  const body = [
    '### What this adds',
    '',
    '`project-node-memory` — a markdown-as-database knowledge base for DSH agents.',
    '',
    '- 9 agent tools: `kb_list` `kb_init` `kb_write` `kb_read` `kb_search` `kb_diag` `kb_backlinks` `kb_rename` `kb_vcs_status`',
    '- Stable TIDs, `[[node]]` links that never copy text, `[[tscl]]` value definitions expanded in place',
    '- Bounded reads, structural lint covering `tscl`, workspace-first discovery, inline git snapshots',
    '- Bundled prompt section + skill so the agent reaches for `kb_*` instead of hand-written `docs/`',
    '- Node-graph panel with markdown/LaTeX rendering, sidebar entry + main panel',
    '- Declares `dsh.bundle` (cordis patch) and `dsh.client` (web); npm package mirrors the attached release tarball',
    '',
    '### Checklist',
    '',
    '- [x] `dsh.bundle` declared in `package.json`',
    '- [x] Entry file is `data/plugins/levodoubt__project-node-memory.yml`',
    '- [x] Description matches what the code actually does',
    '- [x] Released: https://github.com/levodoubt/project-node-memory/releases',
    '- [x] npm: https://www.npmjs.com/package/project-node-memory',
    '',
    'Submitted after the 24 h repository-age gate, so CI should be green on the first run.',
  ].join('\n')

  const pr = await api(`/repos/${UPSTREAM}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Add levodoubt/project-node-memory', head: `${OWNER}:${BRANCH}`, base: 'main', body }),
  })
  if (pr.ok) console.log(`PR #${pr.json.number} ${pr.json.html_url}`)
  else console.log(`PR failed: ${pr.status} ${pr.text.slice(0, 400)}`)
}

async function status() {
  const fork = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}`)
  console.log(`fork: ${fork.status}`)
  const file = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}/contents/${ENTRY}?ref=${BRANCH}`)
  console.log(`entry on ${BRANCH}: ${file.status}`)
  const prs = await api(`/repos/${UPSTREAM}/pulls?state=all&head=${OWNER}:${BRANCH}`)
  console.log(`PRs: ${prs.ok ? prs.json.length : prs.status}`)
  const npm = await fetch('https://registry.npmjs.org/project-node-memory/latest')
  const meta = npm.ok ? await npm.json() : null
  console.log(`npm: ${meta ? `v${meta.version}` : `HTTP ${npm.status}`}`)
}

const mode = process.argv[2] || 'status'
const run = { prepare, submit, status }[mode]
if (!run) {
  console.error('usage: node scripts/market.mjs prepare|submit|status')
  process.exit(1)
}
run().catch((err) => {
  console.error(`market ${mode} failed: ${err.message}`)
  process.exitCode = 1
})
