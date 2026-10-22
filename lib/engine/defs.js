/**
 * defs —— 全库 `<tscl id="x">…</tscl>` 定义表。
 *
 * 定义可以写在任何节点正文里（通常写在 facts/ 的自然语言段落里，也可以就近写在
 * 引用它的文档旁）。这里把全书扫一遍，产出 id → { id, body, ownerTid, source }。
 *
 * 不做的事：不判断「该不该只有一处」以外的语义——重复、与节点 TID 撞名、嵌套开标签、
 * 无人引用，全部以 problems 形式交回给 diag 定级。
 */

import { extract_defs } from './parse.js'

const NESTED_OPEN = /<tscl\b[^>]*>(?:(?!<\/tscl>)[\s\S])*?<tscl\b/

/**
 * @param {Map<string, {tid:string, content:string, source:string, title:string}>} nodes
 * @returns {{ defs: Map<string, object>, problems: object[] }}
 */
export function collectDefs(nodes) {
  const defs = new Map()
  const problems = []

  for (const node of nodes.values()) {
    const content = node.content || ''
    if (!content.includes('<tscl')) continue
    if (NESTED_OPEN.test(content)) {
      problems.push({ code: 'nested-tscl', tid: node.tid, where: node.source })
    }
    for (const [id, body] of extract_defs(content)) {
      const prev = defs.get(id)
      if (prev) {
        prev.count += 1
        prev.owners.push(node.tid)
        problems.push({
          code: 'dup-def',
          id,
          owners: prev.owners.slice(),
          where: node.source,
        })
        continue
      }
      defs.set(id, {
        id,
        body,
        ownerTid: node.tid,
        ownerTitle: node.title || '',
        source: node.source || '',
        count: 1,
        owners: [node.tid],
      })
    }
  }

  return { defs, problems }
}

/** 定义体是否有跨行内容（跨行定义不能内联进表格单元格） */
export function isMultiline(body) {
  return String(body || '').replace(/\s+$/, '').includes('\n')
}
