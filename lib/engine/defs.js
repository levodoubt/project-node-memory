/**
 * defs —— 全库 `<tscl id="x">…</tscl>` 定义表。
 *
 * 定义可以写在任何节点正文里（通常写在 facts/ 的自然语言段落里，也可以就近写在
 * 引用它的文档旁）。这里把全书扫一遍，产出 id → { id, body, ownerTid, source }。
 *
 * 不做的事：不判断「该不该只有一处」以外的语义——重复、与节点 TID 撞名、嵌套开标签、
 * 无人引用，全部以 problems 形式交回给 diag 定级。
 */

import { extract_defs, extractRefs } from './parse.js'

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

/** 谁在正文里引用了这个定义（[[tscl="id"]]，或指向它的旧语法裸引用）→ [{tid,title,source,line,legacy}] */
export function refsToDef(nodes, id) {
  const out = []
  for (const node of nodes.values()) {
    const content = String(node.content || '')
    if (!content.includes(id)) continue
    for (const ref of extractRefs(content)) {
      if (ref.id !== id) continue
      if (ref.kind !== 'tscl' && ref.kind !== 'legacy') continue
      out.push({
        tid: node.tid,
        title: node.title || '',
        source: node.source || '',
        line: content.slice(0, ref.index).split('\n').length,
        legacy: ref.kind === 'legacy',
      })
    }
  }
  return out
}

/** 定义 → 人读文本（kb_read 按 tscl id 读、面板点宏时跳转用） */
export function formatDefRead(def, refs = []) {
  const src = String(def.source || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/')
  const lines = [`定义体 <tscl id="${def.id}"> · 定义在 ${def.ownerTid}${src ? `（${src}）` : ''}`, '', String(def.body || '').replace(/\s+$/, '')]
  if (def.count > 1) lines.push('', `重复定义 ${def.count} 处（必须只剩一处）: ${def.owners.join('、')}`)
  if (refs.length) {
    lines.push('', `被引用 ${refs.length} 处：`)
    for (const r of refs) {
      const at = String(r.source || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/')
      lines.push(`- ${r.tid}${r.title ? ` · ${r.title}` : ''}${at ? `（${at}#L${r.line}）` : ''}${r.legacy ? `  ← 旧语法，建议 [[tscl="${def.id}"]]` : ''}`)
    }
  } else {
    lines.push('', '尚未被任何 [[tscl="…"]] 引用。')
  }
  return lines.join('\n')
}
