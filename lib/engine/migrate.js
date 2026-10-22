/**
 * migrate —— 把旧写法裸引用 `[[x]]` 迁成 1.1 的双语法。
 *
 * 规则：
 *   - x 是 tscl 定义 id  → `[[tscl="x"]]`（值嵌入）
 *   - x 是节点 TID        → `[[node="x"]]`（链接）
 *   - 两者都不是          → 原样保留，记进 unresolved（本来就悬空，迁移不该猜）
 *
 * 三条纪律与 rename 一致：围栏内不动、写前重读复核 mtime/size、默认只演练（dry_run）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { ROOT_TID } from './mdlib.js'

const FENCE = '```'
const BARE_REF = /\[\[([^[\]"=\s][^[\]]*)\]\]/g

function absOf(lib, node) {
  const raw = String(node.source || '').split('#')[0]
  if (!raw) return ''
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(lib.nodekb, raw)
}

function relOf(lib, abs) {
  return path.relative(lib.nodekb, abs).split(path.sep).join('/')
}

function allMarkdown(nodekb) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) out.push(p)
    }
  }
  walk(nodekb)
  return out
}

/** 纯函数：把一段 md 文本里的裸引用改写（可单测） */
export function migrateText(text, { isTid, isDef }) {
  const out = []
  const hits = { node: 0, tscl: 0, unresolved: [] }
  let fenced = false
  for (const line of String(text).split('\n')) {
    if (line.trim().startsWith(FENCE)) {
      fenced = !fenced
      out.push(line)
      continue
    }
    if (fenced) {
      out.push(line)
      continue
    }
    out.push(
      line.replace(BARE_REF, (whole, inner) => {
        const id = inner.trim()
        if (isDef(id)) {
          hits.tscl += 1
          return `[[tscl="${id}"]]`
        }
        if (isTid(id)) {
          hits.node += 1
          return `[[node="${id}"]]`
        }
        hits.unresolved.push(id)
        return whole
      }),
    )
  }
  return { text: out.join('\n'), hits }
}

/**
 * 迁移整个库。
 * @param {{nodekb:string, nodes:Map, defs?:Map}} lib openLibrary 的结果
 * @param {{dryRun?:boolean}} [opts] 默认演练
 */
export function migrateLibrary(lib, opts = {}) {
  const dryRun = opts.dryRun !== false
  const defs = lib.defs || new Map()
  const nodes = lib.nodes
  const isTid = (id) => nodes.has(id)
  const isDef = (id) => defs.has(id)

  const report = { dry_run: dryRun, files: [], node: 0, tscl: 0, unresolved: [], skipped: [] }
  const edits = []
  const visited = new Set()

  for (const node of nodes.values()) {
    if (node.kind !== 'file') continue
    const abs = absOf(lib, node)
    if (!abs) continue
    visited.add(path.resolve(abs))
    let text
    let st1
    try {
      st1 = fs.statSync(abs)
      text = fs.readFileSync(abs, 'utf8')
    } catch (e) {
      report.skipped.push({ path: relOf(lib, abs), why: `读失败: ${e.message}` })
      continue
    }
    if (!text.includes('[[')) continue
    const { text: next, hits } = migrateText(text, { isTid, isDef })
    const changed = hits.node + hits.tscl
    for (const u of hits.unresolved) report.unresolved.push({ path: relOf(lib, abs), ref: u })
    if (!changed) continue
    report.node += hits.node
    report.tscl += hits.tscl
    report.files.push({ path: relOf(lib, abs), count: changed, node: hits.node, tscl: hits.tscl })
    edits.push({ abs, st1, next, path: relOf(lib, abs) })
  }

  if (!dryRun) {
    for (const e of edits) {
      try {
        const st2 = fs.statSync(e.abs)
        if (st2.mtimeMs !== e.st1.mtimeMs || st2.size !== e.st1.size) {
          report.skipped.push({ path: e.path, why: '读后被改动，未覆盖' })
          continue
        }
        fs.writeFileSync(e.abs, e.next, 'utf8')
      } catch (err) {
        report.skipped.push({ path: e.path, why: err.message })
      }
    }
  }

  // 兜底：只报「存在但没进索引」的 md（解析失败的孤儿文件），不重复报已处理的
  for (const abs of allMarkdown(lib.nodekb)) {
    if (visited.has(path.resolve(abs))) continue
    report.skipped.push({ path: relOf(lib, abs), why: '未被解析为目标节点，未处理' })
  }

  return report
}

export function formatMigrate(report) {
  const lines = []
  lines.push(report.dry_run ? '（演练，未落盘；确认后传 dry_run=false 才写）' : '已写入')
  const total = report.files.reduce((s, f) => s + f.count, 0)
  if (!total) {
    lines.push('没有需要迁移的裸引用')
  } else {
    lines.push(`共 ${total} 处裸引用 → ${report.tscl} 处 [[tscl="…"]]、${report.node} 处 [[node="…"]]`)
    for (const f of report.files.slice(0, 20)) lines.push(`  - ${f.path}: ${f.count}（tscl ${f.tscl} / node ${f.node}）`)
    if (report.files.length > 20) lines.push(`  …另有 ${report.files.length - 20} 个文件`)
  }
  if (report.unresolved.length) {
    lines.push(`保留未改 ${report.unresolved.length} 处（指向的 id 既不是节点也不是定义，本来悬空）：`)
    for (const u of report.unresolved.slice(0, 10)) lines.push(`  - ${u.path}: [[${u.ref}]]`)
    if (report.unresolved.length > 10) lines.push(`  …另有 ${report.unresolved.length - 10} 处`)
  }
  if (report.skipped.length) {
    lines.push(`跳过 ${report.skipped.length} 个文件：`)
    for (const s of report.skipped.slice(0, 10)) lines.push(`  - ${s.path}: ${s.why}`)
  }
  return lines.join('\n')
}

export { ROOT_TID }
