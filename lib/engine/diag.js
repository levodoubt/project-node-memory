/**
 * diag —— 结构自检。
 *
 * errors  = 真损坏（悬空/位置型引用、循环、孤儿、树环、重复 TID、重复/冲突/悬空的 tscl 定义），退出码 2。
 * warnings = 疑似漂移（跨节点重复块 / 节点内重复行 / 旧语法 / 无人引用的定义），默认只报；strict 时算失败。
 *
 * 逐行对齐 Python 版 commands.cmd_diag（含 _is_boilerplate 的全部豁免规则）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { extractRefs, extract_refs, makeFenceTracker } from './parse.js'
import { render_node, resolve_path, TransclusionError } from './render.js'
import { collectDefs, isMultiline } from './defs.js'
import { staleTidWarnings } from './tidref.js'
import { checkRules, loadRules } from './rules.js'

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

/**
 * 读库根的 diag_ignore.json：{"blocks": [...], "lines": [...], "tids": [...], "advice": [...]}。
 * 前三项是正则列表；`advice` 是 `{code?, tid?}` 对象列表，用来压 advice（1.5.15 起）——
 * advice 只说「还能更省」，但每个库总有几处是刻意留下的（超长的年表、故意拆不开的清单），
 * 没有豁免通道时 Agent 只能每次读完全部 advice 再自己筛。
 */
function loadIgnore(libRoot) {
  const empty = { blocks: [], lines: [], tids: [], warnings: [], advice: [] }
  if (!libRoot) return empty
  const p = path.join(libRoot, IGNORE_FILE)
  let data
  try {
    if (!fs.statSync(p).isFile()) return empty
    data = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return empty
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return empty
  return {
    blocks: compileRules(data.blocks),
    lines: compileRules(data.lines),
    tids: compileRules(data.tids),
    // 1.5.17：整条 warning 的正则豁免。以前只有 blocks/lines（专给「内容重复」用），
    // 别的 warning 想「这条我确认过」就只能看它一直挂着。
    warnings: compileRules(data.warnings),
    advice: compileAdviceRules(data.advice),
  }
}

/** 每条减免规则：{code?: RegExp, tid?: RegExp}；两个都缺的那条规则作废（否则会把全部 advice 抹掉） */
function compileAdviceRules(items) {
  const out = []
  for (const item of Array.isArray(items) ? items : []) {
    const one = item && typeof item === 'object' && !Array.isArray(item) ? item : { code: item }
    const rule = {}
    for (const key of ['code', 'tid']) {
      if (one[key] === undefined || one[key] === null) continue
      try {
        rule[key] = new RegExp(String(one[key]))
      } catch {
        /* 非法正则跳过这一项 */
      }
    }
    if (rule.code || rule.tid) out.push(rule)
  }
  return out
}

/** advice 豁免：`{code: 'long-section', tid: 'lesson:0'}` 同时匹配才算命中 */
function filterAdvice(advice, rules) {
  if (!rules || !rules.length) return advice
  return advice.filter((a) => {
    const code = String((a && a.code) || '')
    const tid = String((a && (a.node || a.tid)) || '')
    return !rules.some((r) => (!r.code || r.code.test(code)) && (!r.tid || r.tid.test(tid)))
  })
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
      out.push(
        `内容重复（可能漂移）: ${uniq.join(', ')} 共有块「${b.slice(0, 60)}${b.length > 60 ? '…' : ''}」` +
          `（真要有意共用：在库根 diag_ignore.json 的 blocks 加一条正则，或用 warnings 组按整条文案豁免）`,
      )
    }
  }
  return out.slice(0, 20)
}

/** 节点内重复行：同一节点里 ≥40 字符的正文行出现 2+ 次 */
export function intraDupLines(nodes, ignore = []) {
  const out = []
  for (const n of nodes.values()) {
    const counts = new Map()
    // 围栏口径只此一份（parse.js 的 makeFenceTracker），``` 与 ~~~ 同等对待
    const fenceOf = makeFenceTracker()
    for (const line of String(n.content).split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)) {
      const s = line.trim()
      if (fenceOf(line) !== 'outside') continue
      if (s.startsWith('|') || !s) continue
      if (s.length >= 40 && /[a-zA-Z0-9\u4e00-\u9fff]/.test(s)) {
        if (isBoilerplate(s) || ignore.some((rx) => rx.test(s))) continue
        counts.set(s, (counts.get(s) || 0) + 1)
      }
    }
    for (const [s, c] of counts) {
      if (c >= 2) {
        out.push(
          `节点内重复行: ${n.tid} 出现 ${c} 次「${s.slice(0, 60)}${s.length > 60 ? '…' : ''}」` +
            `（同一段公式/基线确实要重复：在 diag_ignore.json 的 lines 或 warnings 里加一条正则豁免）`,
        )
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
export function diag(nodes, { problems = [], strict = false, libRoot, defs = null, advice = [] } = {}) {
  // 解析期的「形状问题」分两级：真损坏（重复 TID、树环）算 error；
  // 手写 <node> 出错（缺 name、孤立 </node>）算 warning —— 那行按正文处理，库仍可用。
  const SOFT_PARSE = /^(显式节点缺|孤立的 <\/node>)/
  const errors = problems.filter((p) => !SOFT_PARSE.test(String(p)))
  const warnings = problems.filter((p) => SOFT_PARSE.test(String(p)))

  // 定义表：全库 <tscl id="x">…</tscl>
  let defsMap = defs
  if (!defsMap) {
    const collected = collectDefs(nodes)
    defsMap = collected.defs
    for (const p of collected.problems) {
      if (p.code === 'dup-def') errors.push(`重复定义（必须恰好一处）: <tscl id="${p.id}"> 出现在 ${p.owners.join('、')}`)
      else if (p.code === 'nested-tscl') errors.push(`嵌套 <tscl> 开标签: ${p.tid}`)
    }
  }
  for (const id of defsMap.keys()) {
    if (nodes.has(id)) errors.push(`命名空间冲突: tscl 定义 "${id}" 与节点 TID 同名（一个名字只能有一种含义）`)
  }
  const referenced = new Set()
  // 已经按「悬空引用」报过的 id：下一个循环里的「不可解析的 TID 文本」不再复读一遍
  const dangling = new Set()

  for (const node of nodes.values()) {
    const content = String(node.content || '')
    for (const ref of extractRefs(content)) {
      const lineOfRef = content.slice(0, ref.index).split('\n').pop() || ''
      if (ref.kind === 'tscl' || (ref.kind === 'legacy' && defsMap.has(ref.id))) {
        if (ref.kind === 'tscl') referenced.add(ref.id)
        if (!defsMap.has(ref.id)) {
          errors.push(`悬空 tscl 引用: ${node.tid} → [[tscl="${ref.id}"]]`)
          continue
        }
        if (ref.kind === 'legacy') {
          warnings.push(`旧语法（实为宏）: ${node.tid} → [[${ref.id}]]，请写成 [[tscl="${ref.id}"]]`)
        }
        const body = defsMap.get(ref.id).body
        if (/^\s*\|/.test(lineOfRef) && isMultiline(body)) {
          warnings.push(`跨行宏被内联进表格单元格: ${node.tid} → [[tscl="${ref.id}"]]（表格里只放单行宏）`)
        }
        continue
      }

      if (ref.kind === 'legacy') {
        warnings.push(`旧语法: ${node.tid} → [[${ref.id}]]，请写成 [[node="${ref.id}"]]（2.0 将移除裸引用）`)
      }

      // 节点引用（node= 或旧语法）：允许三级前缀唯一解析，与 kb_read 一致
      const hit = nodes.has(ref.id) ? ref.id : resolve_path(nodes, ref.id)
      if (!hit) {
        dangling.add(ref.id)
        // 一句话讲清两种可能：真链接写错了，或者这里只是**举例**却写成了链接。
        // 以前只说「悬空引用」，于是文档里想展示 `[[node="doc:示例"]]` 写法的人只能看见
        // 「本条引用未解析」+ 另一条「TID 前缀指向不存在的节点」两条都说「不存在」的告警。
        errors.push(
          `悬空引用: ${node.tid} → ${ref.raw}` +
            `（目标不存在：要么 TID 写错了，要么这里只是举例——举例请用反引号包起来：\`${ref.raw}\`）`,
        )
        continue
      }
      const segs = hit.split(':')
      if (segs.length >= 3 && POSITIONAL_SEG.test(segs[segs.length - 1])) {
        // 位置型段落 TID（文件:序号）：插章节就漂移。1.1 起 node 引用只是链接、
        // 不再复制正文，误指也就跳错一节 → 降为 warning。
        warnings.push(`位置型 TID 链接（插章节会漂移）: ${node.tid} → ${ref.raw}`)
      }
    }

    // 定义写在表格行里：表格只放单行宏，定义体含 | 会破格
    if (content.includes('<tscl')) {
      const lines = content.split('\n')
      for (let li = 0; li < lines.length; li++) {
        if (!/<tscl\b/.test(lines[li])) continue
        if (/^\s*\|/.test(lines[li])) {
          warnings.push(`定义写在表格行里: ${node.tid} 第 ${li + 1} 行 → <tscl>（定义体含 | 会破格；把定义移到正文段落）`)
        }
      }
    }
  }

  for (const def of defsMap.values()) {
    if (!referenced.has(def.id)) {
      warnings.push(`未被引用的定义: <tscl id="${def.id}">（在 ${def.ownerTid}）`)
    }
  }

  for (const tid of nodes.keys()) {
    try {
      render_node(nodes, tid, { defs: defsMap })
    } catch (e) {
      if (e instanceof TransclusionError) errors.push(`循环引用 @${tid}: ${e.message}`)
      else throw e
    }
  }
  for (const node of nodes.values()) {
    if (node.parent_tid != null && !nodes.has(node.parent_tid)) {
      errors.push(`孤儿节点: ${node.tid} (父 ${node.parent_tid} 不存在)`)
    }
    // 改名/删文件后遗留：嵌套节点的 TID 还带着旧文件的前缀（doc:a:bad 里的 doc:a 已经没了）。
    // 只在「前缀本身像本库的 TID」时提醒：它的上一级必须真是一个目录节点，否则自定义 TID（fact:abi）会误报。
    const tid = String(node.tid || '')
    const cut = tid.lastIndexOf(':')
    if (cut > 0 && node.parent_tid != null && nodes.has(node.parent_tid)) {
      const prefix = tid.slice(0, cut)
      const branch = prefix.lastIndexOf(':')
      const branchTid = branch > 0 ? prefix.slice(0, branch) : ''
      const branchNode = branchTid ? nodes.get(branchTid) : null
      const isBranch = branchNode && (branchNode.kind === 'folder' || branchNode.kind === 'file')
      if (prefix !== node.parent_tid && !nodes.has(prefix) && isBranch) {
        warnings.push(`TID 前缀指向不存在的节点: ${tid}（前缀 ${prefix}，改名或删除后遗留；改成 ${node.parent_tid}:…）`)
      }
    }
  }
  detectTreeCycles(nodes, errors)

  const root = libRoot || libRootOf(nodes)
  const ignore = loadIgnore(root)
  warnings.push(...dupBlocks(nodes, ignore.blocks), ...intraDupLines(nodes, ignore.lines))
  // 散文/反引号里手写的 TID（`kb_diag` 原本只校验 [[node="…"]]，这类笔误要等读者撞上）
  warnings.push(...staleTidWarnings(nodes, defsMap, { ignore: ignore.tids, skip: dangling }))

  // 库自己声明的规矩（.nodekb/rules.json）：引用风格、文件体积。没这个文件时零告警
  const rulesInfo = loadRules(root)
  for (const p of rulesInfo.problems) warnings.push(`${p.message}`)
  if (rulesInfo.rules) {
    for (const w of checkRules(nodes, rulesInfo.rules, root)) warnings.push(w.message)
  }

  // `warnings` 组：整条 warning 的文本正则豁免（有意共用的内容、确认过的历史遗留）
  const shownWarnings = ignore.warnings.length ? warnings.filter((w) => !ignore.warnings.some((rx) => rx.test(w))) : warnings
  const report = {
    exit_code: errors.length || (strict && shownWarnings.length) ? 2 : 0,
    errors,
    warnings: shownWarnings,
    // advice 可以被 diag_ignore.json 的 advice 规则压掉（code/tid 都命中才算）
    advice: Array.isArray(advice) ? filterAdvice(advice, ignore.advice) : [],
    node_count: nodes.size,
    def_count: defsMap.size,
    types: typeCounts(nodes),
  }
  // advice 只是「还能更好」，不影响 exit_code / status
  if (!errors.length && !shownWarnings.length) report.status = 'ok'
  return { report, code: report.exit_code }
}
