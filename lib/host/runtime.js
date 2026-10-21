/**
 * runtime —— 库的打开与缓存（工具的共用底层）。
 *
 * 缓存键是 .nodekb 的绝对路径，有效性靠「全库 md 的 mtime/size 签名」判断：
 * 编辑任何一个 md 都会让签名变化，所以不需要 fs.watch（也就没有 watcher 丢事件的问题）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse_library } from '../engine/mdlib.js'
import { resolveLibrary, listLibraries } from '../engine/registry.js'

const CACHE = new Map() // nodekb -> { sig, nodes, problems }
const MAX_CACHE = 8

// 面板没有会话上下文，只能靠人指定工作区（ws 参数）。
// 但 Agent 调 kb_* 工具时是带着工作区的——把那一次记下来，
// 面板就能「跟着 Agent 走」，不必每次手填目录。
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
        } catch {
          /* 竞态删除：忽略 */
        }
      }
    }
  }
  walk(nodekb)
  return `${count}:${size}:${maxM}`
}

/** 取会话工作区：配置优先 → exec 上下文 → 进程 cwd */
export function workspaceOf(config, exec) {
  const configured = config && typeof config.workspace === 'string' ? config.workspace : ''
  if (configured) return path.resolve(configured)
  const env = process.env.DSH_NODEKB_WORKSPACE
  if (env) return path.resolve(env)
  const e = exec && typeof exec === 'object' ? exec : {}
  const candidates = [e.workspace, e.cwd, e.session && e.session.workspace, e.session && e.session.cwd]
  for (const c of candidates) if (typeof c === 'string' && c) return path.resolve(c)
  if (LAST_WORKSPACE) return LAST_WORKSPACE
  return process.cwd()
}

/**
 * 打开一个库（带缓存）。
 * @returns {{name:string, base:string, nodekb:string, nodes:Map, problems:string[], cached:boolean}}
 */
export function openLibrary(config, exec, { kb, lib, remember = true } = {}) {
  const workspace = workspaceOf(config, exec)
  // 只有「Agent 带着会话工作区」的调用才值得记下来；
  // 面板用 ws 参数指定目录是显式选择，别拿它污染工具侧的默认工作区。
  if (remember) rememberWorkspace(workspace)
  const resolved = resolveLibrary({ kb, lib, workspace, config })
  const sig = signature(resolved.nodekb)
  const hit = CACHE.get(resolved.nodekb)
  if (hit && hit.sig === sig) {
    return { ...resolved, nodes: hit.nodes, problems: hit.problems, cached: true }
  }
  const problems = []
  const nodes = parse_library(resolved.nodekb, problems)
  CACHE.set(resolved.nodekb, { sig, nodes, problems })
  if (CACHE.size > MAX_CACHE) CACHE.delete(CACHE.keys().next().value)
  return { ...resolved, nodes, problems, cached: false }
}

export function knownLibraries(config, exec) {
  return listLibraries({ workspace: workspaceOf(config, exec), config })
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
