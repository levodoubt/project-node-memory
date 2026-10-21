/**
 * registry —— 库定位（工作区优先，注册表兜底）。
 *
 * 三种来源，优先级从高到低：
 * 1. 工具参数 `lib`（技能目录或 .nodekb 路径）——受工作区/已注册路径白名单约束
 * 2. config.libraries 里显式声明的 { 名字: 技能目录 }
 * 3. 注册表 JSON（`{"libraries":{"名字":{"path":"技能目录"}}}`，与 Python 版 kb_registry.json 同格式）
 * 4. 工作区自带 `.nodekb`（名字固定为 workspace）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_KB = 'workspace'

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** child 是否位于 parent 之内（含相等） */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function defaultRegistryPaths(workspace) {
  const out = [path.join(os.homedir(), '.dsh', 'nodekb', 'registry.json')]
  for (const p of [path.join(workspace, 'kb_registry.json'), path.join(workspace, '.nodekb', 'kb_registry.json')]) {
    if (isFile(p)) out.push(p)
  }
  return out
}

export function readRegistryFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const libs = data && typeof data === 'object' ? data.libraries : null
    if (!libs || typeof libs !== 'object') return {}
    const out = {}
    for (const [name, info] of Object.entries(libs)) {
      if (info && typeof info.path === 'string' && info.path) out[name] = { path: info.path, registry: file }
    }
    return out
  } catch {
    return {}
  }
}

/** 合并多个注册表（先出现的优先） */
export function loadRegistries(files, inline) {
  const merged = new Map()
  for (const [name, dir] of Object.entries(inline || {})) {
    if (typeof dir === 'string' && dir) merged.set(name, { path: dir, registry: 'config' })
  }
  for (const f of files || []) {
    for (const [name, entry] of Object.entries(readRegistryFile(f))) {
      if (!merged.has(name)) merged.set(name, entry)
    }
  }
  return merged
}

function workspaceBase(workspace) {
  const nodekb = path.join(workspace, '.nodekb')
  return isDir(nodekb) ? { name: DEFAULT_KB, base: workspace, nodekb, origin: 'workspace' } : null
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 在工作区里找库（有界 BFS，默认下钻 2 层）。
 * 约定位置优先，但 <root>/packages/<包>/.nodekb 这种单仓多包也能发现。
 * 跳过 node_modules/.git/dist/build 与点目录；budget 是 readdir 次数上限，
 * 面板每次加载都会调，不能把整棵树走一遍。
 */
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.git'])

export function discoverLibraries(root, { depth = 2, budget = 300, limit = 60 } = {}) {
  const ws = path.resolve(root || '.')
  const out = []
  const seen = new Set()
  const push = (dir, rel, origin) => {
    const nodekb = path.join(dir, '.nodekb')
    if (!isDir(nodekb) || seen.has(nodekb)) return
    seen.add(nodekb)
    const parts = rel ? rel.split(/[\\/]/) : []
    const isSkill = parts.length >= 2 && parts[parts.length - 2] === 'skills'
    const name = !parts.length ? DEFAULT_KB : isSkill ? parts[parts.length - 1] : parts.join('/')
    out.push({ name, path: dir, nodekb, exists: true, origin })
  }
  push(ws, '', 'workspace')
  // 技能自带的知识库是约定位置，单独直查（不进 BFS，因为 .dsh 是点目录）
  const scanSkills = (base, prefix) => {
    for (const e of safeReaddir(path.join(base, '.dsh', 'skills'))) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      push(path.join(base, '.dsh', 'skills', e.name), (prefix ? prefix + '/' : '') + '.dsh/skills/' + e.name, 'discovered')
      if (out.length >= limit) return
    }
  }
  scanSkills(ws, '')
  const queue = [{ dir: ws, rel: '', level: 0 }]
  let spent = 0
  while (queue.length && spent < budget && out.length < limit) {
    const cur = queue.shift()
    if (cur.level >= depth) continue
    let entries
    spent += 1
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= limit || spent >= budget) break
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue
      const rel = cur.rel ? cur.rel + '/' + e.name : e.name
      const dir = path.join(cur.dir, e.name)
      push(dir, rel, 'discovered')
      if (cur.level === 0) scanSkills(dir, e.name)
      queue.push({ dir, rel, level: cur.level + 1 })
    }
  }
  return out
}

/**
 * 定位库根（返回 .nodekb 目录）。
 * @throws 带可行动提示的错误
 */
export function resolveLibrary({ kb, lib, workspace, config } = {}) {
  const ws = path.resolve(workspace || process.cwd())
  const registries = loadRegistries(
    config && config.registries ? config.registries : defaultRegistryPaths(ws),
    config && config.libraries,
  )

  // 1) 显式路径
  if (lib) {
    const p = path.resolve(ws, lib)
    const nodekb = path.basename(p) === '.nodekb' ? p : path.join(p, '.nodekb')
    if (!isDir(nodekb)) throw new Error(`库目录不存在: ${nodekb}（你传入: ${lib}）`)
    const allowed = [ws, ...[...registries.values()].map((e) => e.path)]
    if (!allowed.some((root) => isInside(nodekb, root))) {
      throw new Error(
        `拒绝访问工作区外的库: ${nodekb}\n` +
          `允许范围 = 工作区 ${ws} + 已注册库。需要长期使用请在插件配置 config.libraries 里登记。`,
      )
    }
    return { name: path.basename(nodekb), base: path.dirname(nodekb), nodekb, origin: 'lib' }
  }

  // 2) 名字
  const name = kb && String(kb).trim()
  if (name) {
    const entry = registries.get(name)
    if (entry) {
      const nodekb = path.join(entry.path, '.nodekb')
      if (!isDir(nodekb)) throw new Error(`库目录不存在: ${nodekb}（注册表 ${name} 指向 ${entry.path}）`)
      return { name, base: entry.path, nodekb, origin: entry.registry }
    }
    const discovered = discoverLibraries(ws).find((r) => r.name === name)
    if (discovered) {
      return { name, base: path.dirname(discovered.nodekb), nodekb: discovered.nodekb, origin: discovered.origin }
    }
    if (name === DEFAULT_KB) {
      const wsLib = workspaceBase(ws)
      if (wsLib) return wsLib
    }
    const names = [...registries.keys(), ...discoverLibraries(ws).map((r) => r.name)]
    throw new Error(`未注册的库: ${name}（可用: ${names.join(', ') || '无'}；或用 lib 参数给绝对路径）`)
  }

  // 3) 无参：工作区自带 → 工作区里唯一发现 → 唯一的注册表库
  const wsLib = workspaceBase(ws)
  if (wsLib) return wsLib
  const found = discoverLibraries(ws)
  if (found.length === 1) {
    return { name: found[0].name, base: path.dirname(found[0].nodekb), nodekb: found[0].nodekb, origin: found[0].origin }
  }
  if (found.length > 1) {
    throw new Error(
      `未指定库（工作区根没有 .nodekb，但发现 ${found.length} 个）：${found.map((r) => r.name).join('、')}\n` +
        `用 kb 参数选一个，或把库放到工作区根的 .nodekb。`,
    )
  }
  if (registries.size === 1) {
    const [[only, entry]] = [...registries.entries()]
    const nodekb = path.join(entry.path, '.nodekb')
    if (isDir(nodekb)) return { name: only, base: entry.path, nodekb, origin: entry.registry }
  }
  if (registries.size > 1) {
    throw new Error(
      `未指定库（工作区没有 .nodekb）。已注册: ${[...registries.keys()].join(', ')}；用 kb 参数选一个。`,
    )
  }
  throw new Error(
    `没有可用库：工作区 ${ws} 下没有 .nodekb，注册表里也没有库。\n` +
      `在项目里建 .nodekb/ 并放 md 文件即可（folder/文件/## 标题都会自动变成节点）；` +
      `技能自带的知识库放在 .dsh/skills/<技能名>/.nodekb/ 也会被自动发现。`,
  )
}

/** 列出可用库（不解析内容，避免一次拖动整库） */
export function listLibraries({ workspace, config } = {}) {
  const ws = path.resolve(workspace || process.cwd())
  const registries = loadRegistries(
    config && config.registries ? config.registries : defaultRegistryPaths(ws),
    config && config.libraries,
  )
  const rows = []
  const seen = new Set()
  for (const r of discoverLibraries(ws)) {
    rows.push({ name: r.name, path: path.dirname(r.nodekb), exists: true, origin: r.origin })
    seen.add(r.nodekb)
  }
  for (const [name, entry] of registries) {
    const nodekb = path.join(entry.path, '.nodekb')
    if (seen.has(nodekb)) continue
    rows.push({ name, path: entry.path, exists: isDir(nodekb), origin: entry.registry })
  }
  return rows
}
