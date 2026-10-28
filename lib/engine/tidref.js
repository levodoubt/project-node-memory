/**
 * tidref —— 散文与行内代码里「TID 形状」文本的可解析性检查（1.5.12 起）。
 *
 * 为什么单独一层：`kb_diag` 校验的只是 `[[node="…"]]` / `[[tscl="…"]]` 这两种真引用，
 * 而各库的维护手册都要求「讲语法时把示例写进反引号」——于是 `doc:01:1.6` 这种手写错的 TID
 * 全库没人管，要等读者撞上才发现。本机五个库为此各造了一套脚本
 * （`kb_tidref_check.mjs` / `_check_tids.py` / `nodekb-check.mjs`），这里收回插件。
 *
 * 口径（宁可漏报，也不误报）：
 * - 只看围栏外的行：围栏里是命令与示例，`GET http://…`、`C:\path` 之类误报太多。
 * - 先抹掉真引用、URL、markdown 链接目标——那些已有专门校验或与 TID 无关。
 * - token 形如 `命名空间:其余`，且命名空间必须是**本库真实存在的**（某个 TID 的首段、目录 type、`root`）。
 * - 能解析（精确 / 三级前缀 / tscl 定义 id）就跳过；小写后能解析 → 报「TID 一律小写」。
 * - 其余报「不可解析」，并给最多 3 个最接近的候选（同命名空间、末段相同或包含）。
 */

import { resolve_path } from './render.js'
import { makeFenceTracker } from './parse.js'

/** 本库「合法的命名空间」：所有 TID 的首段 + 目录节点的 type + root */
export function tidNamespaces(nodes) {
  const ns = new Set(['root'])
  for (const n of nodes.values()) {
    const first = String(n.tid || '').split(':')[0]
    if (first && first !== String(n.tid)) ns.add(first)
    if (n.kind === 'folder' && n.type) ns.add(String(n.type))
  }
  return ns
}

// 去掉 URL 与 markdown 链接目标（链接文本保留：那里也可能写着 TID）
const URL_RE = /https?:\/\/\S+/g
const MD_TARGET_RE = /\]\([^)]*\)/g
// 真引用（`[[node="x"]]` / `[[tscl="x"]]` / 旧式裸引用）已由 diag 校验，这里抹掉免得重复计数
const REF_RE = /\[\[[^\]]*\]\]/g
// token：`命名空间:其余`，命名空间以字母开头；前后不能再接路径分隔符/冒号（避免截断 `a:b:c`）
const TOKEN_RE = /(^|[^\w:/.\\-])([A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff:._-]*)/g
const MAX_ITEMS = 20
// 占位符与反例：各库手册都写「反例一律带 × 前缀」「`doc:x:1.1` 这种简写不合法」，
// 这些是教学示例而不是笔误，扫进来只会让人觉得这条警告没用。
const PLACEHOLDER_RE = /^(slug|name|tid|id|xxx|yyy|x|y)(:.*)?$/i

// 同一行里出现 `doc/03-build.md` 这种「路径 → TID」的对照时，`doc:03-build` 是示例不是笔误
const PATH_RE = /([A-Za-z][A-Za-z0-9._-]*)\/([A-Za-z0-9\u4e00-\u9fff._-]+(?:\/[A-Za-z0-9\u4e00-\u9fff._-]+)*)\.md\b/g

function maskLine(line) {
  return line
    .replace(URL_RE, (m) => ' '.repeat(m.length))
    .replace(MD_TARGET_RE, (m) => ' '.repeat(m.length))
    .replace(REF_RE, (m) => ' '.repeat(m.length))
}

function resolves(nodes, defs, token) {
  if (nodes.has(token)) return token
  if (defs && defs.has(token)) return token
  try {
    const hit = resolve_path(nodes, token)
    if (hit) return hit
  } catch {
    // 前缀有歧义：不算解析成功，但也别当场炸
  }
  return null
}

/** 最接近的几个候选：同命名空间，且末段相同或互相包含（简写/漏写文件名时最有用） */
function nearest(nodes, token, ns) {
  const last = token.slice(token.lastIndexOf(':') + 1)
  const out = []
  for (const tid of nodes.keys()) {
    if (tid === token) continue
    if (!tid.startsWith(ns + ':')) continue
    if (tid.endsWith(':' + last) || tid.includes(last) || last.includes(tid.slice(tid.lastIndexOf(':') + 1))) out.push(tid)
  }
  return out.sort().slice(0, 3)
}

/**
 * @param {Map<string, object>} nodes
 * @param {Map<string, object>} defs
 * @param {{ignore?: RegExp[], skip?: Set<string>}} [opts] skip＝已经按「悬空引用」报过的 id，
 *   同一处不再重复报一条「不可解析的 TID 文本」（两条都在说「这个 TID 不存在」，读的人只会更懵）
 * @returns {string[]} 形如 `不可解析的 TID 文本: doc:x 本节点第 3 行「doc:01:1.6」；最接近: …`
 */
export function staleTidWarnings(nodes, defs, { ignore = [], skip = null } = {}) {
  const ns = tidNamespaces(nodes)
  const seen = new Set()
  const out = []
  for (const node of nodes.values()) {
    const lines = String(node.content || '').split(/\r\n|[\n\r]/)
    // 围栏口径只此一份：``` 与 ~~~ 同等、闭围栏不短于开围栏（parse.js）
    const fenceOf = makeFenceTracker()
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      if (fenceOf(raw) !== 'outside') continue
      const line = maskLine(raw)
      // 本行里「路径 → TID」的对照（`doc/03-build.md` ⇒ `doc:03-build`），提到的那串 TID 是示例
      const illustrated = []
      PATH_RE.lastIndex = 0
      let pm
      while ((pm = PATH_RE.exec(raw))) {
        const segs = pm[2].split('/')
        illustrated.push(pm[1] + ':' + segs.join(':'))
        illustrated.push(pm[1] + ':' + segs[segs.length - 1])
      }
      TOKEN_RE.lastIndex = 0
      let m
      while ((m = TOKEN_RE.exec(line))) {
        const token = m[2]
        if (!token || seen.has(token + '\u0000' + node.tid)) continue
        const cut = token.indexOf(':')
        const name = token.slice(0, cut)
        if (!cut || !ns.has(name)) continue
        if (/\.\.|\.$/.test(token)) continue
        // 紧挨在 ×/✗ 前缀后面的（允许空格/反引号），是手册里刻意写的反例
        const at = m.index + m[1].length
        if (/[×✗]/.test(raw.slice(Math.max(0, at - 6), at))) continue
        const rest = token.slice(cut + 1).replace(/[,.;:]+$/, '') // 句末标点不算 TID 的一部分
        if (!rest || PLACEHOLDER_RE.test(rest)) continue
        const clean = name + ':' + rest
        if (illustrated.some((p) => clean === p || clean.startsWith(p + ':'))) continue
        if (ignore.some((rx) => rx.test(clean))) continue
        if (skip && skip.has(clean)) continue
        if (resolves(nodes, defs, clean)) continue
        seen.add(clean + '\u0000' + node.tid)
        // 行号按**文件行号**报：node.lines 与 content 逐行对齐（正文里已去掉 H1 与标签行）
        const lineNo = Array.isArray(node.lines) && node.lines[i] ? node.lines[i] : i + 1
        const lower = clean.toLowerCase()
        if (lower !== clean && resolves(nodes, defs, lower)) {
          out.push(`TID 大小写不合规: ${node.tid} 文件第 ${lineNo} 行「${clean}」→ 应写「${lower}」（TID 一律小写）`)
        } else {
          const near = nearest(nodes, clean, name)
          out.push(
            `不可解析的 TID 文本: ${node.tid} 文件第 ${lineNo} 行「${clean}」` +
              (near.length ? `；最接近: ${near.join('、')}` : ''),
          )
        }
        if (out.length >= MAX_ITEMS) return out
      }
    }
  }
  return out
}
