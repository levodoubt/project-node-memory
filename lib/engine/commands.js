/**
 * commands —— read / search / diag 的语义层。
 *
 * 逐行对齐 Python 版 commands.py：返回值都是 { text | report, code }，
 * 工具层（host/tools.js）与路由层（host/routes.js）只负责把它包装成工具结果 / HTTP 响应。
 * 移植期用 test/parity.mjs 拿 Python 原实现逐条对拍。
 */

import { render_node, render_subtree, toc_lines, node_info, resolve_path, TransclusionError } from './render.js'
import { search, formatSearch } from './search.js'
import { diag } from './diag.js'
import { collectDefs, refsToDef, formatDefRead } from './defs.js'

// 整支渲染字符上限（0 = 不限）。防止一次调用打爆上下文（root ≈ 23.5 万字符）
export const DEFAULT_MAXLEN = 50000

/** 渲染上下文：有传入就用传入的（宿主侧会缓存），否则现扫一遍定义表 */
export function renderCtx(nodes, defs, libRoot) {
  if (defs) return { defs, libRoot }
  return { defs: collectDefs(nodes).defs, libRoot }
}

/** 读取：默认整支；node=仅该节点；toc=目录；raw=元信息 */
export function cmdRead(nodes, target, { node = false, raw = false, toc = false, maxlen = 0, defs, libRoot } = {}) {
  let tid
  try {
    tid = resolve_path(nodes, target)
  } catch (e) {
    return { text: e.message, code: 2 }
  }
  if (tid === null) {
    // 不是节点：再看是不是一个 tscl 定义 id（值的老家可能只是一句话）
    const defsMap = defs || collectDefs(nodes).defs
    const def = defsMap.get(target)
    if (def) return { text: formatDefRead(def, refsToDef(nodes, target, def.ownerTid)), code: 0, def: target }
    const cands = [...nodes.keys()]
      .filter((t) => t.startsWith(target) || t.startsWith(target + ':'))
      .sort()
      .slice(0, 10)
    let msg = `未找到节点: ${target}`
    if (cands.length) msg += '；候选: ' + cands.join('、')
    const defSuffix = [...defsMap.keys()].filter((d) => d.includes(target)).sort().slice(0, 5)
    if (defSuffix.length) msg += '；同名 tscl 定义候选: ' + defSuffix.join('、')
    return { text: msg, code: 2 }
  }
  try {
    if (toc) return { text: toc_lines(nodes, tid).join('\n'), code: 0 }
    if (raw) return { text: JSON.stringify(node_info(nodes, tid), null, 2), code: 0 }
    const ctx = renderCtx(nodes, defs, libRoot)
    if (node) {
      let out = render_node(nodes, tid, ctx)
      const kids = [...nodes.values()].filter((c) => c.parent_tid === tid)
      if (kids.length) {
        // 反直觉提示：带 ## 子节的页面只读 node 只回前言
        out += `\n\n（本节点含 ${kids.length} 个子节：正文在子节里；看结构用 toc 模式，看整支不要传 node）`
      }
      return { text: out, code: 0 }
    }
    const out = render_subtree(nodes, tid, 1, ctx)
    if (maxlen && out.length > maxlen) {
      return {
        text:
          `渲染超上限: ${out.length} 字符 > ${maxlen}。` +
          `建议只读单节点或指定小节 tid；如确实需要整支，maxlen 传 0 强制全量。`,
        code: 2,
      }
    }
    return { text: out, code: 0 }
  } catch (e) {
    if (e instanceof TransclusionError) return { text: `错误: ${e.message}`, code: 2 }
    return { text: e && e.message ? e.message : String(e), code: 2 }
  }
}

/** 检索 */
export function cmdSearch(nodes, query, opts = {}) {
  const result = search(nodes, query, opts)
  return { result, text: formatSearch(query, result), code: result.hits.length ? 0 : 1 }
}

/** 自检 */
export function cmdDiag(nodes, { problems = [], strict = false, libRoot, defs } = {}) {
  return diag(nodes, { problems, strict, libRoot, defs })
}
