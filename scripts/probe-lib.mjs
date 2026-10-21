// 对真实库跑一遍面板会打的那些接口（离线起一个 http 服务，不碰 DSH）。
// 用法: node scripts/probe-lib.mjs "<库目录或技能目录>" [搜索词]
import http from 'node:http'
import path from 'node:path'
import { registerRoutes } from '../lib/host/routes.js'

const target = process.argv[2]
const term = process.argv[3] || '口径'
if (!target) {
  console.error('用法: node scripts/probe-lib.mjs "<库目录>" [搜索词]')
  process.exit(1)
}

const routes = []
const ctx = { webServer: { register: (spec) => (routes.push(spec), () => {}) } }
registerRoutes(ctx, {})
const spec = routes[0]

const server = http.createServer((req, res) => spec.handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const ws = path.resolve(target)

async function get(p) {
  const url = `${base}${p}${p.includes('?') ? '&' : '?'}ws=${encodeURIComponent(ws)}`
  const r = await fetch(url)
  const body = await r.json().catch(() => ({}))
  return { status: r.status, body }
}

try {
  const libs = await get('/nodekb/api/libs')
  console.log('libs', libs.status, JSON.stringify(libs.body).slice(0, 300))

  const tree = await get('/nodekb/api/tree')
  const t = tree.body.tree
  console.log('tree', tree.status, 'nodeCount=' + tree.body.nodeCount, 'lib=' + tree.body.kb)
  const walk = (n, d = 0, out = []) => {
    out.push(`${'  '.repeat(d)}${n.tid} [${n.type}] ${n.title} (${n.chars})`)
    for (const c of n.children || []) walk(c, d + 1, out)
    return out
  }
  if (t) console.log(walk(t).slice(0, 25).join('\n'))

  const search = await get(`/nodekb/api/search?q=${encodeURIComponent(term)}&limit=3`)
  console.log('search', search.status, 'total=' + search.body.total)
  for (const h of (search.body.hits || []).slice(0, 3)) console.log('  -', h.tid, '::', String(h.snippet).slice(0, 60))

  const diag = await get('/nodekb/api/diag')
  const rep = diag.body.diag || diag.body
  console.log('diag', diag.status, 'errors=' + (rep.errors || []).length, 'warnings=' + (rep.warnings || []).length, 'nodes=' + rep.node_count)
} finally {
  server.close()
}
