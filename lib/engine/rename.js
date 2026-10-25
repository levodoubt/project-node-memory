/**
 * rename —— 改文件节点名并把 [[TID]] 引用一起搬走。
 *
 * 为什么需要它：nodekb 的 TID 由「文件夹 TID + 文件名 slug」派生，
 * 所以重命名一个 md 会让它的 TID 变掉，散落各处的 `[[doc:03-x]]` 立刻变成悬空引用。
 * 手工改名的代价是事后跑 kb_diag 再逐个 grep，所以把「改名 + 重写引用」做成一个原子动作。
 *
 * 三条纪律（抄 dsh-tiddlywiki 的教训）：
 * 1. 写前重读：算好新内容后再 stat 一次，mtime/size 变了就跳过并报出来，绝不覆盖别人刚改的东西。
 * 2. 围栏内的 `[[...]]` 不重写（parser 也不把它当引用，改了反而破坏示例代码）。
 * 3. 只改 TID 这一层：`[[old]]` 与 `[[old:1.2]]` 都搬，`[[oldx]]` 这种前缀相同的别动。
 */

import fs from 'node:fs'
import path from 'node:path'
import { slugify } from './parse.js'
import { ROOT_TID } from './mdlib.js'
import { resolve_path } from './render.js'

const FENCE = '```'

/** 把引用体（`[[…]]` 中间那段）换成新 TID；不是这个 TID 的返回 null。 */
function rewriteInner(inner, oldTid, newTid) {
  // 新语法：[[node="TID"]] / [[tscl="TID"]]
  const quoted = /^(node|tscl)\s*=\s*"([^"]*)"$/.exec(inner)
  if (quoted) {
    const [, kind, id] = quoted
    if (id === oldTid) return `[[${kind}="${newTid}"]]`
    if (id.startsWith(oldTid + ':')) return `[[${kind}="${newTid}${id.slice(oldTid.length)}"]]`
    return null
  }
  // 旧语法：[[TID]] / [[TID:子节点]]
  if (inner === oldTid) return `[[${newTid}]]`
  if (inner.startsWith(oldTid + ':')) return `[[${newTid}${inner.slice(oldTid.length)}]]`
  return null
}

/** 把 `<node tid="oldTid…">`（以及 `name="oldTid…"` 别名）里的旧 TID 前缀换掉；不是它返回 null。 */
function rewriteAttr(value, oldTid, newTid) {
  if (value === oldTid) return newTid
  if (value.startsWith(oldTid + ':')) return newTid + value.slice(oldTid.length)
  return null
}

/** 把一段文本里的 oldTid 引用改写成 newTid（三种写法都覆盖，含 `oldTid:…` 子节点引用与 tid=/name= 属性）。 */
export function rewriteRefsInText(text, oldTid, newTid) {
  const lines = String(text).split('\n')
  const out = []
  let count = 0
  let fenced = false
  for (const line of lines) {
    if (line.trim().startsWith(FENCE)) {
      fenced = !fenced
      out.push(line)
      continue
    }
    if (fenced) {
      out.push(line)
      continue
    }
    let next = line.replace(/\[\[([^[\]]+)\]\]/g, (whole, inner) => {
      const swapped = rewriteInner(inner, oldTid, newTid)
      if (swapped === null) return whole
      count += 1
      return swapped
    })
    // 节点属性里的 TID 也是引用：<node tid="doc:a:bad"> 改名后必须跟着走，
    // 否则文件 TID 变成 doc:c、嵌套节点还叫 doc:a:bad，diag 也看不出来。
    next = next.replace(/(\b(?:tid|name)\s*=\s*")([^"]*)(")/g, (whole, pre, value, post) => {
      const swapped = rewriteAttr(value, oldTid, newTid)
      if (swapped === null) return whole
      count += 1
      return pre + swapped + post
    })
    out.push(next)
  }
  return { text: out.join('\n'), count }
}

function absOf(lib, node) {
  // source 是「绝对路径#L1-L22」（相对路径只在库根被移走时才可能出现）
  const raw = String(node.source || '').split('#')[0]
  if (!raw) return ''
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(lib.nodekb, raw)
}

function relOf(lib, abs) {
  return path.relative(lib.nodekb, abs).split(path.sep).join('/')
}

/** 收集库里所有 md（跳过点目录，与 parse_library 一致） */
function allMarkdown(nodekb) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) out.push(p)
    }
  }
  walk(nodekb)
  return out
}

/**
 * 重命名一个文件节点，并把它引用的 TID 搬过去。
 * @param {{nodekb:string, nodes:Map}} lib openLibrary 的结果
 * @param {string} target 文件节点 TID，或相对路径 `doc/03-x.md`
 * @param {string} newName 新文件名（.md 可省略）
 * @param {{dryRun?:boolean}} [opts]
 */
export function renameFileNode(lib, target, newName, opts = {}) {
  const nodes = lib.nodes
  const wanted = String(target || '').trim()
  if (!wanted) throw new Error('target 不能为空')

  let node = nodes.get(wanted)
  if (!node) {
    // 允许直接给相对路径（doc/03-x.md、lessons/004-…）：走与 kb_read 相同的三级路径解析
    let tid = null
    try {
      tid = resolve_path(nodes, wanted)
    } catch {
      tid = null
    }
    if (tid) node = nodes.get(tid)
  }
  if (!node) {
    // source 存的是绝对路径，按「库根 + 相对路径」比较（大小写与分隔符都归一）
    const rel = wanted.split(path.sep).join('/').replace(/^\.?\/+/, '')
    const want = path.normalize(path.join(lib.nodekb, rel))
    node = [...nodes.values()].find((n) => n.kind === 'file' && absOf(lib, n) === want)
  }
  if (!node) throw new Error(`未找到节点: ${wanted}（可先 kb_read --toc 看 TID 清单；也可以给相对路径 doc/03-x.md）`)
  if (node.kind !== 'file') {
    throw new Error(`只能重命名文件节点；${node.tid} 是 ${node.kind} 节点（目录改名请直接改文件夹）`)
  }

  const from = absOf(lib, node)
  if (!fs.existsSync(from)) throw new Error(`源文件不存在: ${relOf(lib, from)}`)

  let name = String(newName || '').trim()
  if (!name) throw new Error('new_name 不能为空')
  if (!name.endsWith('.md')) name += '.md'
  const to = path.join(path.dirname(from), name)
  if (path.resolve(to) === path.resolve(from)) throw new Error('新旧文件名相同，没有要改的')
  if (fs.existsSync(to)) throw new Error(`目标已存在: ${relOf(lib, to)}`)

  const stem = name.replace(/\.md$/, '')
  const parent = node.parent_tid || ROOT_TID
  const newTid = parent === ROOT_TID ? slugify(stem) : `${parent}:${slugify(stem)}`
  if (newTid === node.tid) {
    throw new Error(`新文件名 slug 化后与旧 TID 相同（${newTid}），引用无需改动；只改大小写等请直接改文件`)
  }

  const report = {
    from: relOf(lib, from),
    to: relOf(lib, to),
    tid: node.tid,
    new_tid: newTid,
    dry_run: Boolean(opts.dryRun),
    rewritten: [],
    skipped: [],
  }

  // 先算出要改哪些文件（读 → 重写），最后才动文件系统
  const edits = []
  for (const file of allMarkdown(lib.nodekb)) {
    let text
    let st1
    try {
      st1 = fs.statSync(file)
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      report.skipped.push({ path: relOf(lib, file), why: `读失败: ${e.message}` })
      continue
    }
    if (!text.includes(node.tid)) continue
    const { text: next, count } = rewriteRefsInText(text, node.tid, newTid)
    if (!count) continue
    edits.push({ file, st1, next, count })
  }

  if (opts.dryRun) {
    for (const e of edits) report.rewritten.push({ path: relOf(lib, e.file), count: e.count })
    return report
  }

  fs.renameSync(from, to)
  report.renamed = true

  for (const e of edits) {
    const target2 = e.file === from ? to : e.file
    try {
      const st2 = fs.statSync(target2)
      if (st2.mtimeMs !== e.st1.mtimeMs || st2.size !== e.st1.size) {
        report.skipped.push({ path: relOf(lib, target2), why: '读后被改动，未覆盖' })
        continue
      }
      fs.writeFileSync(target2, e.next, 'utf8')
      report.rewritten.push({ path: relOf(lib, target2), count: e.count })
    } catch (err) {
      report.skipped.push({ path: relOf(lib, target2), why: err.message })
    }
  }

  return report
}

/** 人读的回执 */
export function formatRename(report) {
  const lines = []
  const head = report.dry_run ? '（演练，未落盘）' : ''
  lines.push(`${head}已重命名「${report.from}」→「${report.to}」`)
  lines.push(`TID: ${report.tid} → ${report.new_tid}`)
  if (report.rewritten.length) {
    const total = report.rewritten.reduce((s, r) => s + r.count, 0)
    lines.push(`更新了 ${total} 处引用（${report.rewritten.length} 个文件）`)
    for (const r of report.rewritten.slice(0, 10)) lines.push(`  - ${r.path}: ${r.count}`)
    if (report.rewritten.length > 10) lines.push(`  …另有 ${report.rewritten.length - 10} 个文件`)
  } else {
    lines.push('没有需要改写的引用')
  }
  if (report.skipped.length) {
    lines.push(`跳过 ${report.skipped.length} 个文件（未覆盖）：`)
    for (const s of report.skipped.slice(0, 10)) lines.push(`  - ${s.path}: ${s.why}`)
  }
  return lines.join('\n')
}
