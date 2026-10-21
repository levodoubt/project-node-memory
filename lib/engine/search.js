/**
 * search —— 实时检索（零持久化索引）：2-gram 词面倒排 + 多词加权 + LIKE 兜底。
 *
 * 与 Python 版 commands.cmd_search 逐行对齐（同一算法、同一排序、同一片段窗口），
 * 差异只有一个：这里返回结构体，格式化由调用方（工具层/路由层）决定。
 */

import { render_node, TransclusionError } from './render.js'

// 中文虚词 2-gram（检索分词时过滤）
const STOP_GRAMS = new Set([
  '怎么', '如何', '是否', '什么', '为什么', '一个', '这种', '那个', '这个',
  '他们', '我们', '你们', '进行', '以及', '还是', '就是', '不是', '没有',
  '可以', '需要', '问题', '情况', '时候', '地方', '东西', '因为', '所以',
  '但是', '然后', '接着', '开始', '最后', '主要', '目前', '已经', '现在',
  '等等', '如果', '那么', '不能', '不会', '应该', '可能',
])

const CJK_RUN = /[\u4e00-\u9fff]+/g
const QUERY_TOKEN = /[\u4e00-\u9fff]+|[a-zA-Z0-9_.-]+/g
const INDEX_TOKEN = /[\u4e00-\u9fff]+|[a-z0-9_]+/g

/** query → 检索 term：非中文 token 原样；连续中文按 2-gram 拆分并过滤虚词 */
export function searchTerms(query) {
  const terms = []
  for (const tok of String(query).match(QUERY_TOKEN) || []) {
    if (/^[\u4e00-\u9fff]+$/.test(tok)) {
      if (tok.length <= 2) {
        if (!STOP_GRAMS.has(tok)) terms.push(tok)
        continue
      }
      const seen = new Set()
      for (let i = 0; i < tok.length - 1; i++) {
        const g = tok.slice(i, i + 2)
        if (!seen.has(g) && !STOP_GRAMS.has(g)) {
          seen.add(g)
          terms.push(g)
        }
        if (terms.length >= 10) break
      }
    } else {
      terms.push(tok)
    }
  }
  return [...new Set(terms)]
}

/** 位置型段落 TID 提升为稳定句柄：沿 parent 上溯到文件/显式节点/文件夹 */
export function stableTid(nodes, tid) {
  let cur = nodes.get(tid)
  while (cur && cur.positional && cur.parent_tid != null && nodes.has(cur.parent_tid)) {
    cur = nodes.get(cur.parent_tid)
  }
  return cur ? cur.tid : tid
}

/**
 * 检索。
 * @returns {{total:number,count:number,offset:number,hits:Array}}
 */
export function search(nodes, query, { type, limit = 10, offset = 0, snippet = 240 } = {}) {
  const terms = searchTerms(query)
  const index = new Map() // gram -> Set(tid)
  for (const node of nodes.values()) {
    const text = `${node.title}\n${node.content}\n${node.tid}`.toLowerCase()
    const grams = new Set()
    for (const tok of text.match(INDEX_TOKEN) || []) {
      if (/^[\x00-\x7f]+$/.test(tok)) {
        grams.add(tok)
      } else {
        for (let i = 0; i < tok.length - 1; i++) grams.add(tok.slice(i, i + 2))
      }
    }
    for (const g of grams) {
      let set = index.get(g)
      if (!set) index.set(g, (set = new Set()))
      set.add(node.tid)
    }
  }

  const scores = new Map()
  for (const g of terms) {
    for (const tid of index.get(g) || []) scores.set(tid, (scores.get(tid) || 0) + 1)
  }

  let rows = []
  if (scores.size) {
    const ranked = [...scores.entries()].sort(
      (a, b) => b[1] - a[1] || nodes.get(a[0]).content.length - nodes.get(b[0]).content.length,
    )
    for (const [tid] of ranked) {
      const node = nodes.get(tid)
      if (type && node.type !== type) continue
      rows.push(node)
    }
  }
  if (!rows.length) {
    // LIKE 兜底：2-gram 未命中（生僻词/整句）时退回子串匹配
    for (const node of nodes.values()) {
      if (type && node.type !== type) continue
      if (!node.title.includes(query) && !node.content.includes(query) && !node.tid.includes(query)) continue
      rows.push(node)
    }
  }

  const total = rows.length
  const hits = []
  for (const node of rows.slice(offset, offset + limit)) {
    let text
    try {
      text = render_node(nodes, node.tid)
    } catch (e) {
      if (!(e instanceof TransclusionError)) throw e
      text = node.content
    }
    let idx0 = terms.length ? text.indexOf(terms[0]) : -1
    if (idx0 < 0) idx0 = 0
    const stable = stableTid(nodes, node.tid)
    const half = Math.max(40, Math.floor(snippet / 2))
    hits.push({
      // tid = 稳定句柄（位置型段落上溯到文件/显式节点），ref = 实际命中节点，positional 标记
      tid: stable,
      ref: node.tid,
      positional: !!node.positional,
      type: node.type,
      title: node.title,
      source: node.source,
      snippet: text.slice(Math.max(0, idx0 - half), idx0 + half + 1), // 保留换行/缩进，不再压平
    })
  }
  return { total, count: hits.length, offset, hits }
}

/** 命中列表 → 紧凑文本（模型侧默认读这个） */
export function formatSearch(query, result) {
  if (!result.hits.length) return `无匹配: ${query}`
  return result.hits.map((h) => `${h.tid}  [${h.type}] ${h.title}\n    …${h.snippet}…`).join('\n')
}
