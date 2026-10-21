/**
 * parse —— TID 语法层：`<tscl id="TID">` 定义、`[[TID]]` 引用、slug 归一化。
 *
 * 与 Python 版 nodekb/kb/parse.py 一一对应（本文件是移植，语义必须保持一致）：
 * - TID 合法性：小写字母/数字/CJK 开头，仅含 a-z0-9 CJK : . _ -
 * - 类型名：小写字母/数字/CJK 开头，仅含 a-z0-9 CJK _ -（不含冒号，避免与 TID 分隔符混淆）
 * - slugify：小写 → 非 [字母数字._-] 转 '-' → 压缩连续 '-' → 去两端 -_
 */

const CJK = '\\u4e00-\\u9fff'

// 引用：[[TID]]（允许 CJK，便于中文文件名/标题直接进入 TID）
export const REF_SOURCE = '\\[\\[([a-zA-Z0-9\\u4e00-\\u9fff:._-]+)\\]\\]'

const TSCL_SOURCE = '<tscl id="([^"]+)">([\\s\\S]*?)<\\/tscl>'
const TID_RE = new RegExp(`^[a-z0-9${CJK}][a-z0-9${CJK}:._-]*$`)
const TYPE_RE = new RegExp(`^[a-z0-9${CJK}][a-z0-9${CJK}_-]*$`)

/** 新的 [[...]] 正则实例（global 正则有 lastIndex 状态，绝不共享） */
export function refRegex() {
  return new RegExp(REF_SOURCE, 'g')
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

/** 提取全部 <tscl> 定义 → [[tid, text]]（保序） */
export function extract_defs(content) {
  const out = []
  for (const m of String(content).matchAll(new RegExp(TSCL_SOURCE, 'gs'))) {
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

/** 剥离 <tscl> 标签本身，保留内部文本（渲染投影的基础变换） */
export function strip_tags(content) {
  return String(content).replace(new RegExp(TSCL_SOURCE, 'gs'), '$2')
}

/** 同一节点内重复定义的 tid */
export function find_duplicate_defs(content) {
  const seen = new Map()
  for (const [tid] of extract_defs(content)) seen.set(tid, (seen.get(tid) || 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([tid]) => tid)
}
