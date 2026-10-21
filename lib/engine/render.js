/**
 * render —— 基于内存节点模型的渲染层（md 即库，无持久化状态）。
 *
 * - render_node / render_subtree：[[TID]] 就地填充（transclusion 展开）
 * - toc_lines：目录视图（tid · 标题 · 字符数，不渲染正文）
 * - node_info：节点元信息（含 source 行号）
 * - 环检测：展开路径重复出现同一 TID 抛 TransclusionError；悬空引用保留 [[TID]] 原文
 */

import { refRegex } from './parse.js'

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
  let msg = `循环引用: ${[...seen, target].join(' -> ')}`
  const node = nodes.get(target)
  if (node && node.source) msg += `（重复节点源: ${node.source}）`
  return msg
}

/** 容器节点（文件夹/文件）转译：整支子树投影（`## 标题` + 内容 + 子节递归） */
function project_container(nodes, tid, seen) {
  const node = nodes.get(tid)
  const parts = []
  const title = node.title || tid
  if (title !== tid) parts.push('## ' + title) // 显式节点（title===tid）内联时不输出标题，避免列表内噪音
  parts.push(expand(node.content, nodes, seen))
  for (const child of children(nodes, tid)) {
    parts.push(project_container(nodes, child.tid, [...seen, child.tid]))
  }
  return parts.join('\n\n')
}

function expand(text, nodes, seen) {
  const out = []
  let pos = 0
  for (const m of String(text).matchAll(refRegex())) {
    out.push(text.slice(pos, m.index))
    const target = m[1]
    if (seen.includes(target)) throw new TransclusionError(cycle_msg(seen, target, nodes))
    const nxt = [...seen, target]
    const node = nodes.get(target)
    if (node) {
      // 仅 文件夹/文件 容器展开整支子树；显式 <node> 原子引用只展开自身（避免同文件兄弟被连带展开）
      if (node.kind === 'folder' || node.kind === 'file') out.push(project_container(nodes, target, nxt))
      else out.push(expand(node.content, nodes, nxt))
    } else {
      out.push(m[0]) // 悬空：保留原文，diag 报告
    }
    pos = m.index + m[0].length
  }
  out.push(text.slice(pos))
  return out.join('')
}

/** 渲染单节点内容（不含标题行） */
export function render_node(nodes, tid) {
  const node = nodes.get(tid)
  if (!node) throw new Error(`节点不存在: ${tid}`)
  return expand(node.content, nodes, [tid])
}

/** 渲染整支：递归子树为带标题层级的 md */
export function render_subtree(nodes, tid, level = 1) {
  const node = nodes.get(tid)
  if (!node) throw new Error(`节点不存在: ${tid}`)
  const title = node.title || tid
  const head = '#'.repeat(level) + ' ' + title
  const parts = [head, expand(node.content, nodes, [tid])]
  for (const child of children(nodes, tid)) parts.push(render_subtree(nodes, child.tid, level + 1))
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

/** 路径解析（三级）：精确 TID → 段边界前缀唯一 → 裸前缀（模糊）唯一 */
export function resolve_path(nodes, p) {
  if (nodes.has(p)) return p
  const keys = [...nodes.keys()]
  let hits = keys.filter((t) => t === p || t.startsWith(p + ':')).sort()
  if (hits.length === 1) return hits[0]
  if (!hits.length) {
    // 段边界无命中 → 裸前缀模糊（fact:mod → fact:modid / fact:modid-places / fact:modid-trap）
    hits = keys.filter((t) => t.startsWith(p)).sort()
    if (hits.length === 1) return hits[0]
  }
  return null
}
