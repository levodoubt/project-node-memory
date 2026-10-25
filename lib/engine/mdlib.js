/**
 * mdlib —— md 即库的解析层（零持久化状态）。
 *
 * 移植自 nodekb/kb/mdlib.py，模型完全一致：
 * - 文件夹 → 节点（type=文件夹名，parent=父文件夹）
 * - md 文件 → 文件节点（tid=`{文件夹tid}:{文件名}`，parent=所在文件夹）
 * - `<node name="X" parent="Y" type="Z">文本</node>` 显式节点：
 *   parent 缺省 = 文件内第一个 <node> 段的 name（文件根），否则文件节点
 *   type 缺省 = 所在文件夹名
 * - 非节点文本按最近 `##` H2 拆分为隐式节点：tid=`{文件tid}:{章节号}`，positional=true
 *
 * 所有文本皆节点；content 为原文（含 `[[TID]]` 引用），渲染层展开。
 */

import fs from 'node:fs'
import path from 'node:path'
import { slugify, makeFenceTracker, parseAttrs } from './parse.js'

const H1_RE = /^#\s+(.*)$/
const H2_RE = /^##\s+(.*)$/
const NUM_HEAD = /^\d+(\.\d+)*$/

export const ROOT_TID = 'root'

/** Python str.splitlines 的等价实现（末尾换行不产生空行） */
export function splitLines(text) {
  if (text === '') return []
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** 段级 TID：标题首 token 为数字编号时用编号，否则用序号 */
export function section_tid(file_tid, title, idx) {
  const first = title ? (title.trim().split(/\s+/)[0] || '').replace(/[。：:]+$/, '') : ''
  if (NUM_HEAD.test(first)) return `${file_tid}:${first}`
  return `${file_tid}:${idx}`
}

function newNode(tid, title, type, parent, sort, source, content, kind) {
  return {
    tid,
    title,
    type,
    parent_tid: parent,
    sort,
    content: content === undefined ? [] : content,
    source,
    kind: kind || 'node',
  }
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/**
 * 解析单个 md 文件为节点列表（文件节点 + 隐式 H2 段 + 显式 <node>，按物理行序）。
 */
export function parse_file(absPath, file_tid, folder_type, parent_tid, problems) {
  const text = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF+/, '')
  const lines = splitLines(text)
  const rel = toPosix(absPath)
  const warn = (msg) => {
    if (Array.isArray(problems)) problems.push(`${msg}（${rel}）`)
  }

  // 1) 先找 H1（围栏内的 # 不算标题）：它决定文件节点的 title，且整行不进任何节点正文
  let h1 = null
  let h1_line = 0
  const h1Fence = makeFenceTracker()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (h1Fence(line) !== 'outside') continue
    const m = H1_RE.exec(line)
    if (m) {
      h1 = m[1].trim()
      h1_line = i + 1
      break
    }
  }

  const nodes = []
  const file_node = newNode(
    file_tid,
    h1 || path.basename(absPath, path.extname(absPath)),
    folder_type,
    parent_tid,
    0,
    `${rel}#L1-L${lines.length}`,
    [],
    'file',
  )
  nodes.push(file_node)
  file_node.content_line = h1_line ? h1_line + 1 : 1

  let first_node_tid = null // 文件根（第一个 <node> 的 name）
  let sec_node = null
  let sec_index = 0
  const stack = [] // 显式 <node> 嵌套栈
  const fenceOf = makeFenceTracker() // 围栏内一律视为原文，不做任何标记解析（``` 与 ~~~ 同等）
  let tscl_open = false // <tscl> 定义块内不做结构解析（宏体可含任意 md）

  const default_parent = () => (first_node_tid ? first_node_tid : file_tid)
  // 内容落到哪：最内层 <node> 栈 → 当前 H2 段 → 文件节点
  const content_target = () => (stack.length ? stack[stack.length - 1] : sec_node || file_node)

  for (let i = 0; i < lines.length; i++) {
    const lineno = i + 1
    const line = lines[i]
    if (lineno === h1_line) continue
    // 围栏标记行与围栏内正文：按原文收下，不做结构解析
    if (fenceOf(line) !== 'outside') {
      content_target().content.push(line)
      continue
    }
    // <tscl> 定义块内部一律按原文处理：不切 H2、不建节点、不弹栈
    if (tscl_open) {
      content_target().content.push(line)
      if (/^\s*<\/tscl>\s*$/.test(line)) tscl_open = false
      continue
    }
    if (/^\s*<tscl\b/.test(line)) {
      content_target().content.push(line)
      const afterOpen = line.slice(line.indexOf('>') + 1)
      if (!/<\/tscl>/.test(afterOpen)) tscl_open = true
      continue
    }
    if (stack.length) {
      if (line.trim() === '</node>') {
        stack.pop()
        continue
      }
      // 内层 <node>（须单行闭合；只认行首，正文里提到 <node> 不算）
      if (line.replace(/^\s+/, '').startsWith('<node')) {
        const attrs = parseAttrs(line)
        const name = (attrs.name || attrs.tid || '').trim()
        if (name) {
          const n = newNode(
            name,
            (attrs.title || '').trim() || name,
            (attrs.type || '').trim() || folder_type,
            (attrs.parent || '').trim() || default_parent(),
            lineno,
            `${rel}#L${lineno}`,
          )
          n.content_line = lineno + 1
          nodes.push(n)
          const gt = line.indexOf('>')
          const rest = gt >= 0 ? line.slice(gt + 1) : ''
          if (rest.includes('</node>')) {
            n.content.push(rest.split('</node>')[0])
            const after = rest.split('</node>').slice(1).join('</node>')
            if (after) stack[stack.length - 1].content.push(after)
          } else {
            stack.push(n)
          }
        } else {
          // 缺 name/tid：不能静默吞掉（否则开标签消失、闭标签漏进正文）
          warn(`显式节点缺 name（或 tid）属性: <node> 在第 ${lineno} 行，整段按正文处理`)
          content_target().content.push(line)
        }
        continue
      }
      stack[stack.length - 1].content.push(line)
      continue
    }
    if (line.trim() === '</node>') {
      warn(`孤立的 </node>: 第 ${lineno} 行没有对应的 <node>（已忽略，不会漏进正文）`)
      continue
    }
    if (line.replace(/^\s+/, '').startsWith('<node')) {
      const attrs = parseAttrs(line)
      const name = (attrs.name || attrs.tid || '').trim()
      if (name) {
        const parent = (attrs.parent || '').trim() || default_parent()
        const ptype = (attrs.type || '').trim() || folder_type
        const title = (attrs.title || '').trim() || name
        const n = newNode(name, title, ptype, parent, lineno, `${rel}#L${lineno}`)
        n.content_line = lineno + 1
        nodes.push(n)
        if (first_node_tid === null) first_node_tid = name
        const gt = line.indexOf('>')
        const rest = gt >= 0 ? line.slice(gt + 1) : ''
        if (rest.includes('</node>')) {
          // 单行 <node>…文本…</node>
          n.content.push(rest.split('</node>')[0])
        } else {
          stack.push(n)
        }
      } else {
        warn(`显式节点缺 name（或 tid）属性: <node> 在第 ${lineno} 行，整段按正文处理`)
        ;(sec_node || file_node).content.push(line)
      }
      continue
    }
    const m2 = H2_RE.exec(line)
    if (m2) {
      sec_index += 1
      const title = m2[1].trim() || '(unnamed)'
      const tid = section_tid(file_tid, title, sec_index)
      sec_node = newNode(tid, title, folder_type, default_parent(), lineno, `${rel}#L${lineno}`, [], 'section')
      sec_node.positional = true // 位置型段落 TID：插章节就漂移，不可作引用/检索句柄
      sec_node.content_line = lineno + 1
      nodes.push(sec_node)
      continue
    }
    ;(sec_node || file_node).content.push(line)
  }

  // 收尾兜底：未闭合的结构在解析时是「安静地吞掉后面所有内容」——段节点凭空消失、
  // 正文被并进上一个节点，而 diag 原本一个字都不报。写入侧已经拦了，但手改 / git 合并 /
  // mode=replace 逃生口都绕得过去，所以解析器收尾必须自己报一声。
  if (stack.length) {
    const open = stack[stack.length - 1]
    warn(
      `未闭合的 <node>: 从「${open.tid}」的开标签（第 ${open.sort} 行）起` +
        `一直没遇到独占一行的 </node>，后面的标题与节点都被并进了它的正文（段节点会从库里消失）`,
    )
  }
  if (tscl_open) warn('未闭合的 <tscl>: 定义块没等到独占一行的 </tscl>，文件后半段都被当成定义体吞掉了')

  for (const n of nodes) {
    const joined = n.content.join('\n')
    // trim 会吃掉节点正文开头的空行；行号基准要跟着往下挪，否则引用定位偏前。
    const leadChars = joined.length - joined.replace(/^\s+/, '').length
    const leadLines = (joined.slice(0, leadChars).match(/\n/g) || []).length
    n.content_line = Number(n.content_line || 1) + leadLines
    n.content = joined.trim()
  }
  return nodes
}

function folder_tid(rel_parts) {
  if (!rel_parts.length) return ROOT_TID
  return rel_parts.map(slugify).join(':')
}

/**
 * 解析 `.nodekb/` 库为节点映射（Map，保持插入顺序 = 物理顺序）。
 *
 * problems 传数组时：重复 TID 降级为「跳过冲突项 + 记录问题」，其余照读；
 * 不传时重复 TID 直接抛错（fail-fast）。
 */
export function parse_library(lib_dir, problems) {
  const root = path.resolve(lib_dir)
  let st
  try {
    st = fs.statSync(root)
  } catch {
    throw new Error(`库目录不存在: ${lib_dir}`)
  }
  if (!st.isDirectory()) throw new Error(`库目录不存在: ${lib_dir}`)

  const nodes = new Map()
  nodes.set(
    ROOT_TID,
    newNode(ROOT_TID, '.nodekb', 'root', null, 0, '', '', 'folder'),
  )

  const duplicate = (tid, what) => {
    if (!Array.isArray(problems)) throw new Error(`重复 TID: ${tid}（${what} 与现有节点冲突）`)
    problems.push(`重复 TID: ${tid}（${what} 冲突，已跳过）`)
  }

  const walk = (dir, rel_parts) => {
    const ftid = folder_tid(rel_parts)
    const ftype = rel_parts.length ? slugify(rel_parts[rel_parts.length - 1]) : 'root'
    const ptid = folder_tid(rel_parts.slice(0, -1))

    let skipFiles = false
    if (ftid !== ROOT_TID) {
      if (nodes.has(ftid)) {
        duplicate(ftid, `文件夹 ${dir}`)
        skipFiles = true // 与 Python 一致：本层文件跳过，子目录照走
      } else {
        nodes.set(
          ftid,
          newNode(ftid, rel_parts[rel_parts.length - 1], ftype, ptid, rel_parts.length, '', '', 'folder'),
        )
      }
    }

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 跳过 .git 等点目录，避免污染节点树
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort()

    for (const name of skipFiles ? [] : files) {
      if (!name.endsWith('.md')) continue
      const md = path.join(dir, name)
      const stem = slugify(path.basename(name, path.extname(name)))
      const fileTid = ftid !== ROOT_TID ? `${ftid}:${stem}` : stem
      for (const node of parse_file(md, fileTid, ftype, ftid, problems)) {
        if (nodes.has(node.tid)) {
          duplicate(node.tid, name)
          continue
        }
        nodes.set(node.tid, node)
      }
    }

    for (const name of dirs) walk(path.join(dir, name), [...rel_parts, name])
  }

  walk(root, [])
  return nodes
}

/** 一级节点列表（parent 为 null），按 sort 排序 */
export function lib_root_tids(nodes) {
  return [...nodes.values()]
    .filter((n) => n.parent_tid === null)
    .sort((a, b) => a.sort - b.sort)
    .map((n) => n.tid)
}
