/**
 * advice —— 知识库「可改进」建议。
 *
 * 和 warnings 的区别：warnings 是「你写坏了」（悬空引用、重复 TID），
 * advice 是「写对了、但结构上还能更省」——不影响 exit_code，CI 不该因为它失败。
 *
 * 每条 advice 都带 fix：告诉 Agent 具体怎么改。只报能改的，不报主观的。
 */

import fs from 'node:fs'
import path from 'node:path'
import { codeRegions } from './parse.js'

const MIN_STR = 8
const MAX_STR = 80

/**
 * 抹掉围栏块（``` 与 ~~~，按 parse.js 的同一份口径），保留换行与偏移：
 * 代码里的「字面值」不该被当成可提炼的重复内容，也不该被当成标题行。
 */
function stripFences(text) {
  const s = String(text || '')
  const regions = codeRegions(s).filter(([a, b]) => s.slice(a, b).includes('\n'))
  if (!regions.length) return s
  let out = ''
  let pos = 0
  for (const [a, b] of regions) {
    out += s.slice(pos, a) + s.slice(a, b).replace(/[^\n]/g, ' ')
    pos = b
  }
  return out + s.slice(pos)
}

/** 候选「重复字面值」：整行、长度 8–80、不是语法/标题/表格/引用/公式/小标签。 */
function candidateLines(node) {
  const out = []
  for (const raw of stripFences(node.content).split('\n')) {
    const line = raw.trim()
    if (line.length < MIN_STR || line.length > MAX_STR) continue
    if (/^(#|<|\||\[\[|\]\(|[-*+]\s|\d+\.\s|>|!\[|\\|\$\$)/.test(line)) continue
    if (/^(https?:|\/|[A-Za-z]:\\)/.test(line)) continue
    // 小标签、公式、代码味太重的一律不算「值」
    if (/^(\*\*|__).+(\*\*|__)[:：]?$/.test(line)) continue
    if (/[:：]$/.test(line)) continue
    if (/\$|\\[A-Za-z]/.test(line)) continue
    if (!/[\p{L}\p{N}]/u.test(line)) continue
    // 纯符号/结构性行（如 "---" "==="）没有信息量
    if ((line.match(/[\p{L}\p{N}]/gu) || []).length < 4) continue
    out.push(line)
  }
  return out
}

function defTexts(defs) {
  const texts = []
  for (const d of defs.values()) texts.push(String(d.body || ''))
  return texts
}

/**
 * @param {Map} nodes
 * @param {Map} defs
 * @param {string} libRoot  .nodekb 目录
 * @param {object} opts { minFragNodes, fragChars, longSection, maxItems }
 */
export function computeAdvice(nodes, defs, libRoot, opts = {}) {
  const minFragNodes = opts.minFragNodes || 10
  const fragChars = opts.fragChars || 500
  const longSection = opts.longSection || 10000
  const maxItems = opts.maxItems || 5
  const out = []
  // 回执/报错/advice 一律给库内相对路径（与写入口径一致）；落在库外的只留文件名
  const relOf = (abs) => {
    const rel = libRoot ? path.relative(libRoot, abs) : abs
    const norm = rel.split(path.sep).join('/')
    return norm.startsWith('..') ? path.basename(abs) : norm
  }

  // ① 碎片文件：同一个父节点下大量「整篇都很小」的文件，说明该合并
  //
  // 判据必须看整篇（子树总量），不能只看文件节点自己的正文：`# 标题` 到第一个 `##`
  // 之间往往只有一两句导语，正文全在 `##` 段里——而「一文件一章节」正是本插件推荐的
  // 组织方式，只看正文必然把 20 个健康的大文件全判成「碎片」。
  const kids = new Map()
  for (const n of nodes.values()) {
    if (n.parent_tid == null) continue
    if (!kids.has(n.parent_tid)) kids.set(n.parent_tid, [])
    kids.get(n.parent_tid).push(n)
  }
  const subtreeLen = (root) => {
    let total = 0
    const walk = (n) => {
      total += String(n.content || '').length
      for (const k of kids.get(n.tid) || []) walk(k)
    }
    walk(root)
    return total
  }
  for (const [parentTid, list] of kids) {
    const files = list.filter((k) => k.kind === 'file')
    const small = files.filter((k) => subtreeLen(k) < fragChars)
    if (files.length >= minFragNodes && small.length >= minFragNodes) {
      out.push({
        code: 'merge-fragments',
        node: parentTid,
        message: `${parentTid} 下有 ${small.length} 个 md 整篇不足 ${fragChars} 字符`,
        fix: `可考虑按主题合并成较少文件，或把重复片段提成一个 [[tscl="…"]] 定义。碎片文件多了，读一次要开十几次 kb_read。`,
      })
    }
  }

  // ② 重复字面值：同一串出现在 ≥2 个节点里，且不在定义里 → 建议提成 tscl
  const defsText = defTexts(defs)
  const where = new Map()
  for (const n of nodes.values()) {
    const seen = new Set()
    for (const line of candidateLines(n)) {
      if (seen.has(line)) continue // 同一个节点里出现两次不算「散在多处」
      seen.add(line)
      if (!where.has(line)) where.set(line, [])
      where.get(line).push(n.tid)
    }
  }
  const dups = []
  for (const [line, owners] of where) {
    if (owners.length < 2) continue
    if (defsText.some((t) => t.includes(line))) continue
    dups.push({ line, owners })
  }
  dups.sort((a, b) => b.owners.length - a.owners.length || a.line.length - b.line.length)
  for (const d of dups.slice(0, 2)) {
    out.push({
      code: 'extract-tscl',
      message: `同一句出现在 ${d.owners.length} 个节点：${d.owners.slice(0, 3).join('、')}${d.owners.length > 3 ? ' 等' : ''}`,
      fix: `把「${d.line.slice(0, 40)}${d.line.length > 40 ? '…' : ''}」定义一次：<tscl id="…">…</tscl>，各引用处写 [[tscl="…"]]。改一次即全库同步。如果该句非有价值信息，可无视本 advice`,
    })
  }

  // ③ 库根缺入口
  if (libRoot) {
    const entry = path.join(libRoot, 'index', 'entry.md')
    if (!fs.existsSync(entry)) {
      out.push({
        code: 'missing-entry',
        node: 'index',
        message: '库根没有 index/entry.md（入口）',
        fix: '`kb_write(kb="<库>", target="index/entry.md", mode="create")` 写一个入口：这个库有哪几个主题、各自在哪个 TID。',
      })
    }
  }

  // ④ 文件没有 H1：树里只剩文件名，看不出主题
  let noH1 = 0
  const noH1Sample = []
  for (const n of nodes.values()) {
    if (n.kind !== 'file') continue
    let head = ''
    // 文件节点的 source 是绝对 posix 路径（`D:/…/a.md`）；再 join 会得到 `D:\库\D:\…`。
    const srcPath = String(n.source || '').split('#')[0]
    const file = path.isAbsolute(srcPath) ? srcPath : path.join(libRoot || '.', srcPath)
    try {
      head = fs.readFileSync(file, 'utf8').slice(0, 400)
    } catch {
      continue
    }
    if (!/^#\s+/m.test(head)) {
      noH1++
      if (noH1Sample.length < 2) noH1Sample.push(relOf(n.source.split('#')[0]))
    }
  }
  if (noH1) {
    out.push({
      code: 'missing-h1',
      message: `${noH1} 个 md 没有一级标题（如 ${noH1Sample.join('、')}）`,
      fix: '每个 md 第一行写 `# 主题名`。否则节点树里只有文件名，读者看不出这页讲什么。',
    })
  }

  // ⑤ 段节点过长：抽取粒度失效
  let longCount = 0
  let longSample = ''
  for (const n of nodes.values()) {
    if (n.kind !== 'section') continue
    const len = String(n.content || '').length
    if (len > longSection) {
      longCount++
      if (!longSample) longSample = `${n.tid}（${len} 字符）`
    }
  }
  if (longCount) {
    out.push({
      code: 'long-section',
      message: `${longCount} 个段节点超过 ${longSection} 字符（如 ${longSample}）`,
      fix: '可考虑拆成几个 `##` 小节，或在段落里用 `<tscl>` 把稳定的事实提出来——整段读进来太贵。注意拆节会重排位置型 TID（`文件:2.1` 这类），已有链接会漂：要稳定锚点就配显式 `<node>`，或提到独立文件、原节留一行指针。',
    })
  }

  return out.slice(0, maxItems)
}
