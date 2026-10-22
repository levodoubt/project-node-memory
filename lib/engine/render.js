/**
 * render —— 基于内存节点模型的渲染层（md 即库，无持久化状态）。
 *
 * 1.1 起引用分两种，写法与结果都不同：
 * - `[[node="x"]]` → 链接，**不展开**。结构由节点承担，引用只留一行指针。
 * - `[[tscl="x"]]` → 值嵌入：替换成 `<tscl id="x">…</tscl>` 的定义体。
 * - `[[x]]`        → 1.x 旧语法，先查定义、再查节点；2.0 移除（diag 报 warning）。
 *
 * 为什么不展开节点：整支复制会让同一句话在库里出现两次、改一处忘另一处——这正是
 * nodekb 想消灭的重复。需要「完整内容」时走 kb_read target=…（整支投影），而不是复制文本。
 *
 * 其它导出：toc_lines / toc_tree / node_info / resolve_path；环检测抛 TransclusionError。
 */

import path from 'node:path'
import { anyRefRegex, strip_tags, strip_defs, codeRegions, inCode } from './parse.js'
import { ROOT_TID } from './mdlib.js'

const MAX_EMBED = 64 // 单次渲染最多展开的宏个数（防病态文件自引用爆炸）

export class TransclusionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransclusionError'
  }
}

function children(nodes, tid) {
  const out = []
  for (const n of nodes.values()) if (n.parent_tid === tid) out.push(n)
  out.sort((a, b) => (a.sort - b.sort) || (a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0))
  return out
}

function cycle_msg(seen, target, nodes) {
  const chain = [...seen, target].map((s) => String(s).replace(/^tscl:/, 'tscl:'))
  let msg = `循环引用: ${chain.join(' -> ')}`
  const node = nodes.get(target)
  if (node && node.source) msg += `（重复节点源: ${node.source}）`
  return msg
}

const fileOf = (source) => String(source || '').replace(/#L\d+(-L\d+)?$/, '')

function lineOf(source) {
  const m = /#L(\d+)/.exec(String(source || ''))
  return m ? Number(m[1]) : 0
}

/** 节点 → 一行 md 链接。文件夹没有可点的文件，就给粗体标题。 */
function linkTo(node, ctx) {
  const label = String(node.title || node.tid).replace(/[[\]]/g, (c) => '\\' + c)
  const file = fileOf(node.source)
  if (!file) return `**${label}**`
  let target = file
  if (ctx && ctx.libRoot) {
    const rel = path.relative(ctx.libRoot, file)
    if (rel && !rel.startsWith('..')) target = rel.split(path.sep).join('/')
  }
  const line = node.kind === 'section' || node.positional ? lineOf(node.source) : 0
  return `[${label}](${target}${line ? `#L${line}` : ''})`
}

function resolveNode(nodes, id) {
  if (nodes.has(id)) return nodes.get(id)
  const hit = resolve_path(nodes, id)
  return hit ? nodes.get(hit) : null
}

/**
 * 把正文里的三种引用渲染掉。
 * ctx = { defs: Map<id,{body,ownerTid,source}>, libRoot?: string }
 */
export function expand(text, nodes, seen = [], ctx = {}) {
  const defs = (ctx && ctx.defs) || new Map()
  // 同一支里既打印定义体、又在引用处展开，会让一个值出现两遍：第二遍渲染时抹掉定义块
  const rawText = ctx && ctx.suppress && ctx.suppress.size ? strip_defs(text, ctx.suppress) : text
  // 定义块在正文里就地显示为它的内容（标签本身不出现）
  const source = strip_tags(rawText)
  const regions = codeRegions(source)
  const out = []
  let pos = 0
  let embeds = 0
  for (const m of String(source).matchAll(anyRefRegex())) {
    if (inCode(regions, m.index)) continue // 代码里的 [[…]] 是示例，原样保留
    out.push(String(source).slice(pos, m.index))
    const kind = m[1] !== undefined ? 'node' : m[2] !== undefined ? 'tscl' : 'legacy'
    const id = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]
    let handled = false

    // 值嵌入：tscl 显式请求，或旧语法且确有同名定义
    if ((kind === 'tscl' || kind === 'legacy') && defs.has(id)) {
      if (ctx && ctx.expanded) ctx.expanded.add(id)
      const key = 'tscl:' + id
      if (seen.includes(key)) throw new TransclusionError(cycle_msg(seen, key, nodes))
      if (++embeds > MAX_EMBED) {
        throw new TransclusionError(`宏展开超过 ${MAX_EMBED} 次（疑似病态引用）: ${id}`)
      }
      const body = String(defs.get(id).body || '').replace(/\s+$/, '')
      out.push(expand(body, nodes, [...seen, key], ctx))
      handled = true
    }

    // 结构引用：只出链接，不再复制子树
    if (!handled && (kind === 'node' || kind === 'legacy')) {
      const node = resolveNode(nodes, id)
      if (node) {
        out.push(linkTo(node, ctx))
        handled = true
      }
    }

    if (!handled) out.push(m[0]) // 悬空：保留原文，diag 报告
    pos = m.index + m[0].length
  }
  out.push(String(source).slice(pos))
  return out.join('')
}

/** 渲染单节点内容（不含标题行） */
export function render_node(nodes, tid, ctx = {}) {
  const node = nodes.get(tid)
  if (!node) throw new Error(`节点不存在: ${tid}`)
  return expand(node.content, nodes, [tid], ctx)
}

/** 渲染整支：递归子树为带标题层级的 md（节点引用只在原文位置出现一次）
 *  两遍：第一遍收集「在这支里被展开过的定义」，第二遍把这些定义块从正文里抹掉——
 *  否则同一支里既打印定义体、又在引用处展开一次，同一个值出现两遍。 */
export function render_subtree(nodes, tid, level = 1, ctx = {}) {
  const node = nodes.get(tid)
  if (!node) throw new Error(`节点不存在: ${tid}`)
  if (!ctx._pass2) {
    const expanded = new Set()
    renderSubtreeRaw(nodes, tid, level, { ...ctx, expanded })
    const inside = subtreeTids(nodes, tid)
    const suppress = new Set(
      [...expanded].filter((id) => {
        const def = ctx && ctx.defs ? ctx.defs.get(id) : null
        return def && inside.has(def.ownerTid)
      }),
    )
    return renderSubtreeRaw(nodes, tid, level, { ...ctx, _pass2: true, suppress })
  }
  return renderSubtreeRaw(nodes, tid, level, ctx)
}

/** 子树内的全部 TID（含自身） */
export function subtreeTids(nodes, tid) {
  const out = new Set()
  const walk = (t) => {
    if (out.has(t) || !nodes.has(t)) return
    out.add(t)
    for (const c of children(nodes, t)) walk(c.tid)
  }
  walk(tid)
  return out
}

function renderSubtreeRaw(nodes, tid, level, ctx) {
  const node = nodes.get(tid)
  if (!node) throw new Error(`节点不存在: ${tid}`)
  const title = node.title || tid
  const head = '#'.repeat(level) + ' ' + title
  const parts = [head, expand(node.content, nodes, [tid], ctx)]
  for (const child of children(nodes, tid)) parts.push(renderSubtreeRaw(nodes, child.tid, level + 1, ctx))
  return parts.join('\n\n')
}

/** 目录视图：每节点一行（tid · 标题 · 字符数） */
export function toc_lines(nodes, tid, level = 0) {
  const node = nodes.get(tid)
  if (!node) return [`未找到节点: ${tid}`]
  const lines = [`${'  '.repeat(level)}- ${node.tid} · ${node.title || '(无标题)'} · ${node.content.length} 字符`]
  for (const child of children(nodes, tid)) lines.push(...toc_lines(nodes, child.tid, level + 1))
  return lines
}

/** 目录树（给 HTML 面板用，与 toc_lines 同源） */
export function toc_tree(nodes, tid, depth = 0) {
  const node = nodes.get(tid)
  if (!node) return null
  return {
    tid: node.tid,
    title: node.title || '',
    type: node.type,
    kind: node.kind,
    positional: !!node.positional,
    chars: node.content.length,
    source: node.source,
    children: children(nodes, tid).map((c) => toc_tree(nodes, c.tid, depth + 1)).filter(Boolean),
  }
}

export function node_info(nodes, tid) {
  const node = nodes.get(tid)
  if (!node) throw new Error(`节点不存在: ${tid}`)
  // 字段与 Python 版严格一致（kind/positional 由调用方按需补，避免 raw 输出漂移）
  return {
    tid: node.tid,
    type: node.type,
    title: node.title,
    parent_tid: node.parent_tid,
    sort: node.sort,
    source: node.source,
    content: node.content,
  }
}

/** 路径解析（三级）：精确 TID → 段边界前缀唯一 → 裸前缀（模糊）唯一。
 *  空串与 "." 都当库根（README 一直这么写，代码以前只认空串）。 */
export function resolve_path(nodes, p) {
  const raw = String(p ?? '').trim()
  const target = raw === '' || raw === '.' || raw === './' ? ROOT_TID : raw
  if (nodes.has(target)) return target
  const keys = [...nodes.keys()]
  let hits = keys.filter((t) => t === target || t.startsWith(target + ':')).sort()
  if (hits.length === 1) return hits[0]
  if (!hits.length) {
    // 段边界无命中 → 裸前缀模糊（fact:mod → fact:modid / fact:modid-places / fact:modid-trap）
    hits = keys.filter((t) => t.startsWith(target)).sort()
    if (hits.length === 1) return hits[0]
  }
  // 多个命中：只要其中有唯一的「文件/文件夹」节点，它就是用户想要的
  // （doc:02 命中 doc:02-运行环境 与 doc:02-运行环境:2.1 —— 后者是前者的子节）
  if (hits.length > 1) {
    const containers = hits.filter((t) => {
      const n = nodes.get(t)
      return n && (n.kind === 'file' || n.kind === 'folder')
    })
    if (containers.length === 1) return containers[0]
    // 都在同一文件里：取最短的那个（父节点）
    const shortest = hits.reduce((a, b) => (b.length < a.length ? b : a))
    if (hits.every((t) => t.startsWith(shortest))) return shortest
  }
  return null
}
