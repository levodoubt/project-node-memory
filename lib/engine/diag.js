/**
 * diag —— 结构自检。
 *
 * errors  = 真损坏（悬空/位置型引用、循环、孤儿、树环、重复 TID），退出码 2。
 * warnings = 疑似漂移（跨节点重复块 / 节点内重复行），默认只报；strict 时算失败。
 *
 * 逐行对齐 Python 版 commands.cmd_diag（含 _is_boilerplate 的全部豁免规则）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { extract_refs } from './parse.js'
import { render_node, TransclusionError } from './render.js'

const POSITIONAL_SEG = /^\d+(\.\d+)*$/
const DUP_MIN_LEN = 40 // 视为漂移候选的文本块最短长度
const DUP_NAV_ALNUM = 24 // 去掉链接/URL 后实义字符少于此值 → 导航/出处样板
const IGNORE_FILE = 'diag_ignore.json'
const URL_RE = /https?:\/\/\S+/g
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g
const REF_RE = /\[\[[^\]]*\]\]/g
const ALNUM_RE = /[\p{L}\p{N}_]/gu
const BULLET_RE = /^(?:[-*+]\s+|\d+[.)]\s+)/

/** 从节点 source 反查库根（.nodekb 目录），用于读本地豁免文件 */
export function libRootOf(nodes) {
  for (const n of nodes.values()) {
    const src = String(n.source || '').split('#')[0]
    if (!src) continue
    let dir = path.dirname(path.resolve(src))
    for (;;) {
      if (path.basename(dir) === '.nodekb') return dir
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

function compileRules(items) {
  const out = []
  for (const item of items || []) {
    try {
      out.push(new RegExp(String(item)))
    } catch {
      /* 非法正则跳过 */
    }
  }
  return out
}

/** 读库根的 diag_ignore.json：{"blocks": [...], "lines": [...]}，两项都是正则列表 */
function loadIgnore(libRoot) {
  if (!libRoot) return { blocks: [], lines: [] }
  const p = path.join(libRoot, IGNORE_FILE)
  let data
  try {
    if (!fs.statSync(p).isFile()) return { blocks: [], lines: [] }
    data = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return { blocks: [], lines: [] }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { blocks: [], lines: [] }
  return { blocks: compileRules(data.blocks), lines: compileRules(data.lines) }
}

function norm(blk) {
  return blk.split(/\s+/).filter(Boolean).join(' ')
}

/**
 * 样板判定：导航/出处注记、纯链接、URL、HTML 碎片、参数块。
 * 这些块跨页面「重复」是设计使然，一旦上报健康检查就长期变红、随后被无视。
 */
export function isBoilerplate(blk) {
  const s = String(blk).trim()
  if (!s) return true
  const lines = s.split('\n').map((ln) => ln.trim()).filter(Boolean)
  const body = lines.filter((ln) => !ln.startsWith('>'))
  if (!body.length) return true // 整块都是引用注记
  const core = body
  const first = core[0].replace(/^[*_> ]+/, '')
  if (first.startsWith('<')) return true // HTML 碎片
  if (new RegExp(`^(?:${URL_RE.source})$`).test(first)) return true // 裸 URL 行
  const joined = core.join('\n')
  // 导航块里链接文本本身就是文件名，不能算「内容」：整段链接先剔除再计实义字符
  const stripped = joined.replace(URL_RE, '').replace(MD_LINK_RE, '').replace(REF_RE, '')
  if ((stripped.match(ALNUM_RE) || []).length < DUP_NAV_ALNUM) return true
  if (core.every((ln) => BULLET_RE.test(ln) || ln.startsWith('|')) && !/[。，]/.test(joined)) {
    return true // 整块都是列表项/表格行且无叙述句（参数块）
  }
  return false
}

/** 内容漂移：物理重复的文本块（同一段文字出现在 2+ 节点，且不是转译引用 / 样板） */
export function dupBlocks(nodes, ignore = []) {
  const byBlock = new Map()
  for (const n of nodes.values()) {
    for (const blk of String(n.content).split(/\n\s*\n/)) {
      const b = norm(blk)
      if (b.length < DUP_MIN_LEN || isBoilerplate(blk)) continue
      if (ignore.some((rx) => rx.test(b))) continue
      const list = byBlock.get(b) || []
      list.push(n.tid)
      byBlock.set(b, list)
    }
  }
  const out = []
  for (const [b, tids] of byBlock) {
    const uniq = [...new Set(tids)].sort()
    if (uniq.length >= 2) {
      // 跨节点漂移；单节点内部重复不报
      out.push(`内容重复（可能漂移）: ${uniq.join(', ')} 共有块「${b.slice(0, 60)}${b.length > 60 ? '…' : ''}」`)
    }
  }
  return out.slice(0, 20)
}

/** 节点内重复行：同一节点里 ≥40 字符的正文行出现 2+ 次 */
export function intraDupLines(nodes, ignore = []) {
  const out = []
  for (const n of nodes.values()) {
    const counts = new Map()
    let fenced = false
    for (const line of String(n.content).split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)) {
      const s = line.trim()
      if (s.startsWith('```')) {
        fenced = !fenced
        continue
      }
      if (fenced || s.startsWith('|') || !s) continue
      if (s.length >= 40 && /[a-zA-Z0-9\u4e00-\u9fff]/.test(s)) {
        if (isBoilerplate(s) || ignore.some((rx) => rx.test(s))) continue
        counts.set(s, (counts.get(s) || 0) + 1)
      }
    }
    for (const [s, c] of counts) {
      if (c >= 2) {
        out.push(`节点内重复行: ${n.tid} 出现 ${c} 次「${s.slice(0, 60)}${s.length > 60 ? '…' : ''}」`)
        break // 每节点只报 1 条，避免刷屏
      }
    }
  }
  return out.slice(0, 20)
}

function detectTreeCycles(nodes, problems) {
  for (const tid of nodes.keys()) {
    let cur = tid
    const seen = []
    const seenSet = new Set()
    while (cur != null && nodes.has(cur)) {
      if (seenSet.has(cur)) {
        problems.push(`树环: ${[...seen, cur].join(' -> ')}`)
        break
      }
      seenSet.add(cur)
      seen.push(cur)
      cur = nodes.get(cur).parent_tid
    }
  }
}

function typeCounts(nodes) {
  const counts = new Map()
  for (const n of nodes.values()) counts.set(n.type, (counts.get(n.type) || 0) + 1)
  return Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

/**
 * 自检。
 * @returns {{report:object, code:number}}
 */
export function diag(nodes, { problems = [], strict = false, libRoot } = {}) {
  const errors = [...problems]

  for (const node of nodes.values()) {
    for (const refTid of extract_refs(node.content)) {
      if (!nodes.has(refTid)) {
        errors.push(`悬空引用: ${node.tid} → [[${refTid}]]`)
      } else {
        const segs = refTid.split(':')
        if (segs.length >= 3 && POSITIONAL_SEG.test(segs[segs.length - 1])) {
          // 位置型段落 TID（文件:序号）：插章节就漂移，禁止作为引用目标
          errors.push(`位置型 TID 引用（插章节会漂移）: ${node.tid} → [[${refTid}]]`)
        }
      }
    }
  }
  for (const tid of nodes.keys()) {
    try {
      render_node(nodes, tid)
    } catch (e) {
      if (e instanceof TransclusionError) errors.push(`循环引用 @${tid}: ${e.message}`)
      else throw e
    }
  }
  for (const node of nodes.values()) {
    if (node.parent_tid != null && !nodes.has(node.parent_tid)) {
      errors.push(`孤儿节点: ${node.tid} (父 ${node.parent_tid} 不存在)`)
    }
  }
  detectTreeCycles(nodes, errors)

  const root = libRoot || libRootOf(nodes)
  const ignore = loadIgnore(root)
  const warnings = [...dupBlocks(nodes, ignore.blocks), ...intraDupLines(nodes, ignore.lines)]

  const code = errors.length || (strict && warnings.length) ? 2 : 0
  const report = {
    exit_code: code,
    errors,
    warnings,
    node_count: nodes.size,
    types: typeCounts(nodes),
  }
  if (!errors.length && !warnings.length) report.status = 'ok'
  return { report, code }
}
