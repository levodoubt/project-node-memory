/**
 * defs —— 全库 `<tscl id="x">…</tscl>` 定义表。
 *
 * 定义可以写在任何节点正文里（通常写在 facts/ 的自然语言段落里，也可以就近写在
 * 引用它的文档旁）。这里把全书扫一遍，产出 id → { id, body, ownerTid, source }。
 *
 * 不做的事：不判断「该不该只有一处」以外的语义——重复、与节点 TID 撞名、嵌套开标签、
 * 无人引用，全部以 problems 形式交回给 diag 定级。
 */

import { codeRegions, extract_defs, extractRefs } from './parse.js'

const NESTED_OPEN = /<tscl\b[^>]*>(?:(?!<\/tscl>)[\s\S])*?<tscl\b/

/** 把代码区段（围栏块与行内代码）抹成等长空格：那里的标签是示例，不参与结构判断 */
function maskCode(text) {
  const regions = codeRegions(text)
  if (!regions.length) return text
  let out = ''
  let cursor = 0
  for (const [a, b] of regions) {
    if (a < cursor) continue
    out += text.slice(cursor, a) + ' '.repeat(b - a)
    cursor = b
  }
  return out + text.slice(cursor)
}

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
    // 行内代码里提到 `<tscl>` / `<node>` 是「在讲语法」，不是嵌套的开标签
    if (NESTED_OPEN.test(maskCode(content))) {
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

/** 谁在正文里引用了这个定义（[[tscl="id"]]，或指向它的旧语法裸引用）
 *  → [{tid,title,source,line,legacy,self}]
 *  ownerTid 只用来标记「定义所在节点自己也引用了一次」（self:true）；计数时排除，
 *  但列表里保留，免得用户以为那处引用凭空消失。line 是文件内的绝对行号。 */
export function refsToDef(nodes, id, ownerTid = '') {
  const out = []
  for (const node of nodes.values()) {
    const content = String(node.content || '')
    if (!content.includes(id)) continue
    const base = Number(node.content_line || 1)
    for (const ref of extractRefs(content)) {
      if (ref.id !== id) continue
      if (ref.kind !== 'tscl' && ref.kind !== 'legacy') continue
      out.push({
        tid: node.tid,
        title: node.title || '',
        source: node.source || '',
        line: base + content.slice(0, ref.index).split('\n').length - 1,
        legacy: ref.kind === 'legacy',
        self: Boolean(ownerTid) && node.tid === ownerTid,
      })
    }
  }
  return out
}

/** 定义 → 人读文本（kb_read 按 tscl id 读、面板点宏时跳转用） */
export function formatDefRead(def, refs = []) {
  const fileOf = (source) => String(source || '').split('#')[0].split(/[\\/]/).filter(Boolean).slice(-2).join('/')
  const src = fileOf(def.source)
  const lines = [`定义体 <tscl id="${def.id}"> · 定义在 ${def.ownerTid}${src ? `（${src}）` : ''}`, '', String(def.body || '').replace(/\s+$/, '')]
  if (def.count > 1) lines.push('', `重复定义 ${def.count} 处（必须只剩一处）: ${def.owners.join('、')}`)
  const outside = refs.filter((r) => !r.self)
  const selfRefs = refs.filter((r) => r.self)
  if (outside.length) {
    lines.push('', `被引用 ${outside.length} 处：`)
    for (const r of outside) {
      const at = fileOf(r.source)
      lines.push(`- ${r.tid}${r.title ? ` · ${r.title}` : ''}${at ? `（${at}#L${r.line}）` : ''}${r.legacy ? `  ← 旧语法，建议 [[tscl="${def.id}"]]` : ''}`)
    }
  } else {
    lines.push('', '尚未被任何 [[tscl="…"]] 引用。')
  }
  if (selfRefs.length) {
    const where = selfRefs
      .map((r) => `${fileOf(r.source) || r.tid}#L${r.line}`)
      .join('、')
    lines.push('', `定义所在节点自己也引用了 ${selfRefs.length} 次（不计入上面的引用数）: ${where}`)
  }
  return lines.join('\n')
}
