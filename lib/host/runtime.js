/**
 * runtime —— 库的打开与缓存（工具的共用底层）。
 *
 * 缓存键是 .nodekb 的绝对路径，有效性靠「全库 md 的 mtime/size 签名」判断：
 * 编辑任何一个 md 都会让签名变化，所以不需要 fs.watch（也就没有 watcher 丢事件的问题）。
 *
 * 会话工作区从哪来（1.4.0 起）：DSH 交给工具的 `exec` 里**没有** workspace/cwd，
 * 只有 `exec.agent.id`（= 会话 id）。会话头里才有真话：
 *   ctx.get('sessions').get(sessionId).header.cwd
 * 所以这里先问会话头，再退显式参数与配置；进程 cwd 只作最后兜底。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse_library } from '../engine/mdlib.js'
import { collectDefs } from '../engine/defs.js'
import { resolveLibrary, listLibraries } from '../engine/registry.js'

const CACHE = new Map() // nodekb -> { sig, nodes, problems, defs }
const MAX_CACHE = 8

// 宿主服务句柄（apply 时注入）：sessions / workspaceRegistry 都是可选服务。
let SERVICES = null

export function bindServices(ctx) {
  SERVICES = ctx || null
}

function service(name) {
  if (!SERVICES) return null
  try {
    if (typeof SERVICES.get === 'function') return SERVICES.get(name) || null
    return SERVICES[name] || null
  } catch {
    return null
  }
}

/** 调用方会话 id：DSH 把它放在 exec.agent.id 上（ToolExecutionInput.agent）。 */
export function sessionIdOf(exec) {
  const agent = exec && typeof exec === 'object' ? exec.agent : null
  const id = agent && typeof agent === 'object' ? agent.id : null
  return typeof id === 'string' && id ? id : ''
}

/** 会话头里记录的工作目录（会话真正的项目根）。 */
export function sessionCwd(exec) {
  const sid = sessionIdOf(exec)
  if (!sid) return ''
  const sessions = service('sessions')
  if (!sessions || typeof sessions.get !== 'function') return ''
  try {
    const session = sessions.get(sid)
    const header = session && session.header
    const cwd = header && header.cwd
    return typeof cwd === 'string' && cwd ? path.resolve(cwd) : ''
  } catch {
    return ''
  }
}

/** 已登记工作区的全部路径（允许范围用，不再只认「解析出来的那一个」）。 */
export function workspaceRoots() {
  const reg = service('workspaceRegistry')
  if (!reg || typeof reg.list !== 'function') return []
  try {
    return reg
      .list()
      .map((w) => (w && typeof w.path === 'string' ? path.resolve(w.path) : ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

// 面板没有会话上下文，只能靠人指定工作区（ws 参数）。
// 但 Agent 调 kb_* 工具时是带着会话的——把那次的工作区记下来，面板就能「跟着 Agent 走」。
// 这条兜底**只服务面板**：带 exec 的工具调用永远不吃它（否则会把上一个项目的路径带进来）。
let LAST_WORKSPACE = ''

export function rememberWorkspace(ws) {
  if (typeof ws === 'string' && ws) LAST_WORKSPACE = path.resolve(ws)
}

export function lastWorkspace() {
  return LAST_WORKSPACE
}

function signature(nodekb) {
  let count = 0
  let maxM = 0
  let size = 0
  const names = []
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue // 与 parse_library 一致：跳过点目录/点文件
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.name.endsWith('.md')) {
        try {
          const st = fs.statSync(p)
          count += 1
          size += st.size
          if (st.mtimeMs > maxM) maxM = st.mtimeMs
          // 文件名也算签名：改名/移动既不改 mtime 也不改大小，
          // 只按内容比签名会让「改名后的旧索引」一直命中缓存（库看着正常、实际裂开）。
          names.push(path.relative(nodekb, p).split(path.sep).join('/'))
        } catch {
          /* 竞态删除：忽略 */
        }
      }
    }
  }
  walk(nodekb)
  names.sort()
  const digest = crypto.createHash('sha1').update(names.join('\n')).digest('hex').slice(0, 12)
  return `${count}:${size}:${maxM}:${digest}`
}

/** 让某个库的缓存立刻失效（改名/移动之后必须调，别指望下一次签名比对） */
export function forgetLibrary(nodekb) {
  if (nodekb) CACHE.delete(path.resolve(nodekb))
}

/** 判定工作区，并说明它是怎么定下来的。
 *  顺序：显式 exec.workspace → exec.cwd → 会话头 cwd → 配置 → 环境变量 →（仅面板）上次记住的 → 进程 cwd */
export function workspaceSource(config, exec) {
  const e = exec && typeof exec === 'object' ? exec : null
  const explicit = e && typeof e.workspace === 'string' && e.workspace ? path.resolve(e.workspace) : ''
  if (explicit) return { path: explicit, from: 'exec.workspace' }
  const cwd = e && typeof e.cwd === 'string' && e.cwd ? path.resolve(e.cwd) : ''
  if (cwd) return { path: cwd, from: 'exec.cwd' }
  const scwd = sessionCwd(e)
  if (scwd) return { path: scwd, from: 'session.header.cwd' }
  // 面板没有会话：优先「最近一次工具用过的目录」，配置只当最后的默认值。
  // 这样配置里留着的旧路径不会把面板钉在某个老项目上。
  if (!e && LAST_WORKSPACE) return { path: LAST_WORKSPACE, from: 'last-workspace（面板）' }
  const configured = config && typeof config.workspace === 'string' ? config.workspace : ''
  if (configured) return { path: path.resolve(configured), from: 'config.workspace' }
  const env = process.env.DSH_NODEKB_WORKSPACE
  if (env) return { path: path.resolve(env), from: 'env.DSH_NODEKB_WORKSPACE' }
  return { path: process.cwd(), from: 'process.cwd' }
}

export function workspaceOf(config, exec) {
  return workspaceSource(config, exec).path
}

/** 诊断用：把「工作区是怎么定下来的」原样吐出来（面板/工具都对不上时靠它） */
export function whereInfo(config, exec) {
  const e = exec && typeof exec === 'object' ? exec : null
  const src = workspaceSource(config, e)
  return {
    sessionId: sessionIdOf(e),
    sessionCwd: sessionCwd(e),
    execWorkspace: (e && e.workspace && String(e.workspace)) || '',
    execCwd: (e && e.cwd && String(e.cwd)) || '',
    configured: (config && config.workspace) || '',
    env: process.env.DSH_NODEKB_WORKSPACE || '',
    lastWorkspace: LAST_WORKSPACE || '',
    processCwd: process.cwd(),
    workspaceRoots: workspaceRoots(),
    resolved: src.path,
    from: src.from,
  }
}

/**
 * 打开一个库（带缓存）。
 * @returns {{name:string, base:string, nodekb:string, nodes:Map, problems:string[], cached:boolean}}
 */
export function openLibrary(config, exec, { kb, lib, remember = true } = {}) {
  const { path: workspace, from } = workspaceSource(config, exec)
  // 只有「带着会话的调用」才值得记下来；面板用 ws 参数指定目录是显式选择，别污染工具侧默认工作区。
  if (remember && exec && typeof exec === 'object' && !exec.wsParam) rememberWorkspace(workspace)
  const resolved = resolveLibrary({ kb, lib, workspace, config, extraRoots: workspaceRoots() })
  const sig = signature(resolved.nodekb)
  const hit = CACHE.get(resolved.nodekb)
  const base = { ...resolved, workspace, workspaceFrom: from }
  if (hit && hit.sig === sig) {
    return { ...base, nodes: hit.nodes, defs: hit.defs, problems: hit.problems, cached: true }
  }
  const problems = []
  const nodes = parse_library(resolved.nodekb, problems)
  const found = collectDefs(nodes)
  for (const p of found.problems) {
    if (p.code === 'dup-def') problems.push(`重复定义: <tscl id="${p.id}"> 出现在 ${p.owners.join('、')}`)
    else if (p.code === 'nested-tscl') problems.push(`嵌套 <tscl> 开标签: ${p.tid}`)
  }
  CACHE.set(resolved.nodekb, { sig, nodes, defs: found.defs, problems })
  if (CACHE.size > MAX_CACHE) CACHE.delete(CACHE.keys().next().value)
  return { ...base, nodes, defs: found.defs, problems, cached: false }
}

export function knownLibraries(config, exec, opts = {}) {
  return listLibraries({ workspace: workspaceOf(config, exec), config, scope: opts.scope })
}

export function libraryHint(config, exec) {
  try {
    const rows = knownLibraries(config, exec)
    if (!rows.length) return '当前没有可用库。在工作区（或已注册的技能目录）下建 .nodekb/ 并放入 md 文件即可。'
    return `可用库: ${rows.map((r) => `${r.name}${r.exists ? '' : '(路径不存在)'}`).join('、')}`
  } catch {
    return ''
  }
}
