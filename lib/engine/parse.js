/**
 * parse —— TID 语法层：`<tscl id="TID">` 定义、`[[TID]]` 引用、slug 归一化。
 *
 * 与 Python 版 nodekb/kb/parse.py 一一对应（本文件是移植，语义必须保持一致）：
 * - TID 合法性：小写字母/数字/CJK 开头，仅含 a-z0-9 CJK : . _ -
 * - 类型名：小写字母/数字/CJK 开头，仅含 a-z0-9 CJK _ -（不含冒号，避免与 TID 分隔符混淆）
 * - slugify：小写 → 非 [字母数字._-] 转 '-' → 压缩连续 '-' → 去两端 -_
 */

const CJK = '\\u4e00-\\u9fff'

// 引用（1.1 起双语法）：
//   [[node="tid 或相对路径"]]  → 链接（不展开）
//   [[tscl="id"]]              → 值嵌入（替换成 <tscl> 定义体）
//   [[tid]]                    → 旧语法，1.x 兼容并按目标类型推断，2.0 移除
export const REF_SOURCE = '\\[\\[([a-zA-Z0-9\\u4e00-\\u9fff:._-]+)\\]\\]'
export const NODE_REF_SOURCE = '\\[\\[node\\s*=\\s*"([^"]+)"\\]\\]'
export const TSCL_REF_SOURCE = '\\[\\[tscl\\s*=\\s*"([^"]+)"\\]\\]'
const LEGACY_REF_SOURCE = '\\[\\[(?!node\\s*=|tscl\\s*=)([a-zA-Z0-9\\u4e00-\\u9fff:._-]+)\\]\\]'
const ANY_REF_SOURCE =
  `\\[\\[node\\s*=\\s*"([^"]+)"\\]\\]|\\[\\[tscl\\s*=\\s*"([^"]+)"\\]\\]|` +
  `\\[\\[(?!node\\s*=|tscl\\s*=)([a-zA-Z0-9\\u4e00-\\u9fff:._-]+)\\]\\]`

const TSCL_SOURCE = '<tscl id="([^"]+)">([\\s\\S]*?)<\\/tscl>'
const TID_RE = new RegExp(`^[a-z0-9${CJK}][a-z0-9${CJK}:._-]*$`)
const TYPE_RE = new RegExp(`^[a-z0-9${CJK}][a-z0-9${CJK}_-]*$`)

/** 新的 [[...]] 正则实例（global 正则有 lastIndex 状态，绝不共享） */
export function refRegex() {
  return new RegExp(REF_SOURCE, 'g')
}

export function nodeRefRegex() {
  return new RegExp(NODE_REF_SOURCE, 'g')
}

export function tsclRefRegex() {
  return new RegExp(TSCL_REF_SOURCE, 'g')
}

/** 三种引用合一的 global 正则（组 1=node 组 2=tscl 组 3=legacy），渲染用 */
export function anyRefRegex() {
  return new RegExp(ANY_REF_SOURCE, 'g')
}

/** 一次扫过三种引用（保序），返回 [{kind:'node'|'tscl'|'legacy', id, raw, index}]
 *  围栏与行内代码里的 `[[…]]` 是「示例」，不是引用：跳过（否则写文档会自我投毒）。 */
export function extractRefs(text) {
  const src = String(text)
  const regions = codeRegions(src)
  const out = []
  for (const m of src.matchAll(new RegExp(ANY_REF_SOURCE, 'g'))) {
    if (inCode(regions, m.index)) continue
    const kind = m[1] !== undefined ? 'node' : m[2] !== undefined ? 'tscl' : 'legacy'
    const id = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]
    out.push({ kind, id, raw: m[0], index: m.index })
  }
  return out
}

/** 代码区段（围栏块与行内代码），[start, end) 半开区间，按出现顺序 */
export function codeRegions(text) {
  const s = String(text)
  const regions = []
  let offset = 0
  let open = -1
  let openMark = ''
  for (const line of s.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (m) {
      if (open < 0) {
        open = offset
        openMark = m[1]
      } else if (m[1][0] === openMark[0] && m[1].length >= openMark.length) {
        regions.push([open, offset + line.length])
        open = -1
      }
    }
    offset += line.length + 1
  }
  if (open >= 0) regions.push([open, s.length])
  for (const m of s.matchAll(/(`+)([^`\n]*?)\1/g)) {
    const start = m.index
    if (!regions.some(([a, b]) => start >= a && start < b)) regions.push([start, start + m[0].length])
  }
  return regions
}

export function inCode(regions, index) {
  return regions.some(([a, b]) => index >= a && index < b)
}

export function is_valid_tid(tid) {
  return TID_RE.test(String(tid))
}

export function is_valid_type(type) {
  return TYPE_RE.test(String(type))
}

/** 文件名/标题 → TID 段 */
export function slugify(name) {
  let s = String(name).toLowerCase()
  // Python 的 \w 在 UNICODE 下含各语种字母数字：用 \p{L}\p{N}_ 对齐，避免把 é/ü 误伤成 '-'
  s = s.replace(/[^\p{L}\p{N}._-]/gu, '-')
  s = s.replace(/-+/g, '-')
  return s.replace(/^[-_]+/, '').replace(/[-_]+$/, '')
}

/** 提取全部 <tscl> 定义 → [[tid, text]]（保序）。代码块里的定义是示例，不算定义。 */
export function extract_defs(content) {
  const src = String(content)
  const regions = codeRegions(src)
  const out = []
  for (const m of src.matchAll(new RegExp(TSCL_SOURCE, 'gs'))) {
    if (inCode(regions, m.index)) continue
    out.push([m[1], m[2]])
  }
  return out
}

/** 提取全部 [[TID]] 引用（保序，允许重复） */
export function extract_refs(content) {
  const out = []
  for (const m of String(content).matchAll(refRegex())) out.push(m[1])
  return out
}

/** 抹掉指定 id 的定义块（整块删除，不只是标签）。代码块里的不算定义，保持原样。 */
export function strip_defs(content, ids) {
  const src = String(content)
  if (!ids || !ids.size) return src
  const regions = codeRegions(src)
  return src.replace(new RegExp(TSCL_SOURCE, 'gs'), (m, id, body, offset) =>
    !inCode(regions, offset) && ids.has(id) ? '' : m,
  )
}

/** 剥离 <tscl> 标签本身，保留内部文本（渲染投影的基础变换）。代码块里的标签是示例，保留原样。 */
export function strip_tags(content) {
  const src = String(content)
  const regions = codeRegions(src)
  return src.replace(new RegExp(TSCL_SOURCE, 'gs'), (m, id, body, offset) =>
    inCode(regions, offset) ? m : body,
  )
}

/** 同一节点内重复定义的 tid */
export function find_duplicate_defs(content) {
  const seen = new Map()
  for (const [tid] of extract_defs(content)) seen.set(tid, (seen.get(tid) || 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([tid]) => tid)
}
