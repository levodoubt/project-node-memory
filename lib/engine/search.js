/**
 * search —— 实时检索（零持久化索引）：2-gram 词面倒排 + 多词加权 + LIKE 兜底。
 *
 * 与 Python 版 commands.cmd_search 逐行对齐（同一算法、同一排序、同一片段窗口），
 * 差异只有一个：这里返回结构体，格式化由调用方（工具层/路由层）决定。
 */

import path from 'node:path'
import { render_node, TransclusionError, subtreeTids } from './render.js'

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

/** 节点内的逐行命中：line = 源文件行号（node.lines 提供），contentLine = 本节点正文第几行 */
export function lineHitsOf(node, term, max = 3) {
  const q = String(term).toLowerCase()
  const all = node.content === '' ? [] : String(node.content).split('\n')
  const out = []
  for (let i = 0; i < all.length && out.length < max; i++) {
    if (!all[i].toLowerCase().includes(q)) continue
    out.push({
      contentLine: i + 1,
      line: (node.lines || [])[i] || 0,
      text: all[i].trim().slice(0, 160),
    })
  }
  return out
}

/**
 * 在一个节点的子树里找逐行命中（deep=false 只看本节点）。
 * 给 kb_read find=… 用：先拿「第几行」，再用 offset 去读那一段。
 * 行号是「同一次解析快照内的临时坐标」（文件被改动后要重新解析），所以不写进文档引用。
 */
export function findLines(nodes, tid, term, { max = 20, deep = true, libRoot = '' } = {}) {
  const tids = deep ? [...subtreeTids(nodes, tid)] : [tid]
  const hits = []
  for (const t of tids) {
    const node = nodes.get(t)
    if (!node || !node.content) continue
    const file = relFile(node.source, libRoot)
    for (const h of lineHitsOf(node, term, max - hits.length)) {
      if (hits.length >= max) break
      hits.push({ tid: t, file, title: node.title, ...h })
    }
    if (hits.length >= max) break
  }
  return hits
}

/**
 * `kb_read find=` 的唯一实现：先整串子串匹配，零命中时按词退让（每个词都要出现、不限顺序）。
 *
 * 1.5.17：以前引擎 `cmdRead` 自己实现退让、宿主的 `kb_read` 直接调 `findLines` 只有整串匹配，
 * 工具描述却写着「会退让」——同一份逻辑两处实现，改了一处另一处就漂。现在两边都走这里。
 *
 * @returns {{hits: Array, used: string, loose: boolean}} used 是实际用的检索词（退让时形如 `甲 + 乙`）
 */
export function findWithFallback(nodes, tid, term, { deep = true, max = 20, libRoot = '' } = {}) {
  const raw = String(term ?? '').trim()
  if (!raw) return { hits: [], used: raw, loose: false }
  const hits = findLines(nodes, tid, raw, { deep, max, libRoot })
  if (hits.length) return { hits, used: raw, loose: false }
  // 退让：拆词后每个词都要出现（不要求相邻、不要求顺序）。`Fresnel coefficient` 因此能找到
  // `Fresnel reflection coefficient`；退让后仍不中才算真没命中。
  const rawWords = [...new Set(raw.split(/[\s,，、;；、]+/).filter((w) => w.length >= 2))]
  const words = rawWords.map((w) => w.toLowerCase())
  if (words.length < 2) return { hits: [], used: raw, loose: false }
  const key = (h) => `${h.tid}#${h.contentLine}`
  const sets = words.map((w) => findLines(nodes, tid, w, { deep, max: 400, libRoot }))
  if (!sets.every((s) => s.length)) return { hits: [], used: raw, loose: false }
  const common = sets.slice(1).reduce((acc, s) => {
    const keep = new Set(s.map(key))
    return acc.filter((h) => keep.has(key(h)))
  }, sets[0])
  if (!common.length) return { hits: [], used: raw, loose: false }
  return { hits: common.slice(0, max), used: rawWords.join(' + '), loose: true }
}

/** 绝对路径 → 库内相对路径（没有 libRoot 时原样返回，别造一个假的相对路径） */
function relFile(source, libRoot) {
  const abs = String(source || '').replace(/#L.*$/, '')
  if (!libRoot || !abs) return abs
  const rel = path.relative(libRoot, abs)
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : abs
}

export function formatFind(term, hits) {
  if (!hits.length) return `没找到: ${term}`
  return hits.map((h) => `${h.file}#L${h.line} · ${h.tid}   ${h.text}`).join('\n')
}

/**
 * 检索。
 * @returns {{total:number,count:number,offset:number,hits:Array}}
 */export function search(nodes, query, { type, limit = 10, offset = 0, snippet = 240, defs, libRoot, lines = false } = {}) {
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
      // 片段也要走同一次渲染：`[[tscl="x"]]` 得嵌成它的值，否则搜到值还得再读一次定义
      text = render_node(nodes, node.tid, { defs, libRoot })
    } catch (e) {
      if (!(e instanceof TransclusionError)) throw e
      text = node.content
    }
    let idx0 = terms.length ? text.indexOf(terms[0]) : -1
    if (idx0 < 0) idx0 = 0
    const stable = stableTid(nodes, node.tid)
    const half = Math.max(40, Math.floor(snippet / 2))
    const hit = {
      // tid = 稳定句柄（位置型段落上溯到文件/显式节点），ref = 实际命中节点，positional 标记
      tid: stable,
      ref: node.tid,
      positional: !!node.positional,
      type: node.type,
      title: node.title,
      source: node.source,
      snippet: text.slice(Math.max(0, idx0 - half), idx0 + half + 1), // 保留换行/缩进，不再压平
    }
    // 可选的逐行命中（每个节点最多 3 条）：行号是「同一次快照内」的临时坐标，
    // 拿来喂 kb_read 的 offset，不要写进文档引用
    if (lines) hit.lines = lineHitsOf(node, terms[0] || query, 3)
    hits.push(hit)
  }
  return { total, count: hits.length, offset, hits }
}

/** 命中列表 → 紧凑文本（模型侧默认读这个） */
export function formatSearch(query, result) {
  if (!result.hits.length) return `无匹配: ${query}`
  return result.hits
    .map((h) => {
      let out = `${h.tid}  [${h.type}] ${h.title}\n    …${h.snippet}…`
      if (h.lines && h.lines.length) {
        const file = String(h.source || '').replace(/#L.*$/, '')
        out += '\n' + h.lines.map((l) => `    ${file}#L${l.line}  ${l.text}`).join('\n')
      }
      return out
    })
    .join('\n')
}
