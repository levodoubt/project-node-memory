/**
 * commands —— read / search / diag 的语义层。
 *
 * 逐行对齐 Python 版 commands.py：返回值都是 { text | report, code }，
 * 工具层（host/tools.js）与路由层（host/routes.js）只负责把它包装成工具结果 / HTTP 响应。
 * 移植期用 test/parity.mjs 拿 Python 原实现逐条对拍。
 */

import {
  render_node,
  render_node_window,
  render_subtree,
  toc_lines,
  node_info,
  resolve_path,
  TransclusionError,
} from './render.js'
import { search, formatSearch, findLines, formatFind } from './search.js'
import { diag } from './diag.js'
import { collectDefs, refsToDef, formatDefRead } from './defs.js'

// 整支渲染字符上限（0 = 不限）。防止一次调用打爆上下文（root ≈ 23.5 万字符）
export const DEFAULT_MAXLEN = 50000

/**
 * 把长文本裁到行边界内：先看行数上限，再看字符上限。
 * 不静默丢内容——调用方必须把 take（已给到第几行）回给用户当续读坐标。
 */
export function clipText(text, { maxLines = 0, maxChars = 0 } = {}) {
  const lines = String(text).split('\n')
  let take = lines.length
  let chars = 0
  for (let i = 0; i < lines.length; i++) {
    chars += lines[i].length + 1
    if (maxChars && chars > maxChars) {
      take = i
      break
    }
    if (maxLines && i + 1 >= maxLines) {
      take = i + 1
      break
    }
  }
  take = Math.max(0, Math.min(take, lines.length))
  const kept = lines.slice(0, take).join('\n')
  return { text: kept, take, total: lines.length, chars: kept.length, totalChars: text.length, truncated: take < lines.length }
}

const fileOfSource = (source) => String(source || '').replace(/#L.*$/, '')

/** 渲染上下文：有传入就用传入的（宿主侧会缓存），否则现扫一遍定义表 */
export function renderCtx(nodes, defs, libRoot) {
  if (defs) return { defs, libRoot }
  return { defs: collectDefs(nodes).defs, libRoot }
}

/** 读取：默认整支；node=仅该节点；toc=目录；raw=元信息。
 *
 * 1.5.9 起多三个可选参数，默认行为不变：
 * - offset/limit：mode=node 时按「本节点正文行」开窗（1 起），返回头里有文件行号；
 *   mode=subtree 时按「渲染结果的第几行」开窗（坐标不同，头部会写明）。
 * - find：先给命中行（文件行号），再拿 offset 去读那一段。
 * - 超 maxlen 不再报错，改成截断 + 续读坐标。
 */
export function cmdRead(
  nodes,
  target,
  { node = false, raw = false, toc = false, maxlen = 0, offset = 0, limit = 0, find = '', depth = null, defs, libRoot } = {},
) {
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
    if (toc) {
      // depth：往下展开几层（默认 2，0 表示只列目标节点本身）。
      // 目录是「先定位再细读」用的，整支递归会让大库的 toc 一次吐上千 token。
      const lines = toc_lines(nodes, tid, 0, depth === null || depth === undefined ? {} : { depth: Number(depth) })
      return { text: lines.join('\n'), code: 0 }
    }
    if (raw) return { text: JSON.stringify(node_info(nodes, tid), null, 2), code: 0 }
    const ctx = renderCtx(nodes, defs, libRoot)
    const nodeObj = nodes.get(tid)

    // find：只给命中行，不给正文（省得为了找一个词读整段）
    const term = String(find ?? '').trim()
    if (term) {
      let hits = findLines(nodes, tid, term, { deep: !node, max: 20, libRoot: ctx.libRoot })
      let used = term
      let loose = false
      if (!hits.length) {
        // 子串没中时按词退让：每个词都要出现、不限顺序、不限相邻。
        // `Fresnel coefficient` 因此能找到 `Fresnel reflection coefficient`。
        // 退让后仍不中才报未命中，保证「零命中」依然意味着真的没有。
        const rawWords = [...new Set(term.split(/[\s,，、;；、]+/).filter((w) => w.length >= 2))]
        const words = rawWords.map((w) => w.toLowerCase())
        if (words.length >= 2) {
          const key = (h) => `${h.tid}#${h.contentLine}`
          const sets = words.map((w) => findLines(nodes, tid, w, { deep: !node, max: 400, libRoot: ctx.libRoot }))
          if (sets.every((s) => s.length)) {
            const common = sets.slice(1).reduce((acc, s) => {
              const keep = new Set(s.map(key))
              return acc.filter((h) => keep.has(key(h)))
            }, sets[0])
            if (common.length) {
              hits = common.slice(0, 20)
              used = rawWords.join(' + ')
              loose = true
            }
          }
        }
      }
      if (!hits.length) {
        return { text: `未命中: ${term}（${node ? '本节点' : '本支'}）`, code: 1, find: term, hits: 0 }
      }
      const how = loose ? `（整串没中，改成「每个词都要出现」的退让匹配：${used}）` : ''
      const head =
        `找到 ${hits.length} 处（${node ? '本节点' : '本支'}，最多列 20 处）${how}。` +
        `行号是文件行号；mode=node 时把「节点正文第几行」当 offset，subtree 时按渲染行数。\n`
      return { text: head + formatFind(used, hits), code: 0, find: term, hits: hits.length, loose }
    }

    if (node) {
      const win = render_node_window(nodes, tid, ctx, { offset, limit })
      let body = win.text
      let clipped = null
      if (maxlen && body.length > maxlen) {
        clipped = clipText(body, { maxChars: maxlen })
        body = clipped.text
      }
      const file = fileOfSource(nodeObj.source)
      const windowed = Number(offset) > 1 || Number(limit) > 0 || !!clipped || win.end < win.total || win.start > 1
      let text = body
      if (windowed) {
        const loc = `[${file}#L${win.first}-L${win.last} · 本节点第 ${win.start}–${win.end} 行 / 共 ${win.total} 行]`
        text = `${loc}\n\n${body}`
        if (clipped) {
          text +=
            `\n\n（已按 maxlen=${maxlen} 截断：本窗口 ${body.length} 字符 / 共 ${win.text.length} 字符；` +
            `继续用 offset=${win.start + clipped.take}）`
        } else if (win.end < win.total) {
          text += `\n\n（本节点后面还有 ${win.total - win.end} 行，继续用 offset=${win.end + 1}）`
        }
      }
      const kids = [...nodes.values()].filter((c) => c.parent_tid === tid)
      if (kids.length) {
        // 反直觉提示：带 ## 子节的页面只读 node 只回前言
        text += `\n\n（本节点含 ${kids.length} 个子节：正文在子节里；看结构用 toc 模式，看整支不要传 node）`
      }
      return { text, code: 0 }
    }

    let out = render_subtree(nodes, tid, 1, ctx)
    const all = String(out).split('\n')
    const total = all.length
    const start = Math.max(1, Number(offset) || 1)
    const want = Number(limit) > 0 ? Number(limit) : total - start + 1
    const takeLines = Math.max(0, Math.min(want, total - start + 1))
    let body = all.slice(start - 1, start - 1 + takeLines).join('\n')
    let clipped = null
    if (maxlen && body.length > maxlen) {
      clipped = clipText(body, { maxChars: maxlen })
      body = clipped.text
    }
    const shown = clipped ? clipped.take : takeLines
    const last = start + shown - 1
    const windowed = start > 1 || Number(limit) > 0 || !!clipped
    let text = body
    if (windowed) {
      text = `[整支第 ${start}–${Math.max(start, last)} 行 / 共 ${total} 行]\n\n${body}`
      const next = last + 1
      if (next <= total) {
        text += `\n\n（后面还有 ${total - last} 行，继续用 offset=${next}${maxlen ? `（maxlen=${maxlen}）` : ''}）`
      }
    }
    return { text, code: 0 }
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
export function cmdDiag(nodes, { problems = [], strict = false, libRoot, defs, advice = [] } = {}) {
  // advice 必须原样透传：命令行（`nodekb diag`）算好的 advice 以前在这里被丢掉，
  // 于是 `nodekb diag` 永远显示 advice 0，而同样的库在工具层却有建议。
  return diag(nodes, { problems, strict, libRoot, defs, advice })
}
