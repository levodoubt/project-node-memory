/**
 * write —— 往库里写内容（**带校验**）。
 *
 * 这是本项目对「Agent 直接用 write/edit 手搭知识库」的回答：
 * 同样是写 md，但写之前校验 TID / 标签独占一行 / 路径在库内，写之后由调用方跑 diag。
 * 手写没有任何一层会拦你，所以规则靠人记；这里的规则是代码。
 */

import fs from 'node:fs'
import path from 'node:path'
import { is_valid_tid } from './parse.js'

const NODE_OPEN = /^<node\b[^>]*>$/m
const NODE_TAG_LINE = /^\s*<\/?node\b[^>]*>\s*$/m

function fail(msg) {
  throw new Error(msg)
}

/** 库内相对路径 → 绝对路径；越界直接拒绝 */
function absIn(nodekb, rel) {
  const abs = path.resolve(nodekb, rel)
  const root = path.resolve(nodekb)
  const a = process.platform === 'win32' ? abs.toLowerCase() : abs
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  if (a !== r && !a.startsWith(r + path.sep)) fail(`拒绝写库外路径: ${rel}`)
  return abs
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 校验一段将要落盘的内容：node 标签必须独占一行、名字必须是合法 TID */
export function validateContent(text, where) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 反引号/围栏里的示例不算真标签
    if (/^\s*(```|~~~)/.test(line)) {
      // 跳过围栏块
      const fence = line.trim().slice(0, 3)
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence)) i++
      continue
    }
    const m = /^\s*<node\b([^>]*)>\s*$/.exec(line)
    if (m) {
      const nameM = /\bname\s*=\s*"([^"]*)"/.exec(m[1]) || /\bname\s*=\s*'([^']*)'/.exec(m[1])
      if (!nameM) fail(`${where}:${i + 1} <node> 缺少 name=`)
      const tid = nameM[1]
      if (!is_valid_tid(tid)) fail(`${where}:${i + 1} 非法 TID「${tid}」：只能用字母/数字/汉字与 : . _ -`)
      continue
    }
    const inline = /<node\b|<\/node>/.test(line)
    if (inline && !NODE_TAG_LINE.test(line)) {
      fail(`${where}:${i + 1} <node> / </node> 必须独占一行（现在是「${line.trim().slice(0, 60)}」）`)
    }
  }
  return true
}

/**
 * @param {{nodekb:string, nodes:Map}} lib 已打开的库
 * @param {{target:string, content:string, mode?:'append'|'replace'|'create'|'node'}} input
 * @returns {{rel:string, abs:string, bytes:number, mode:string, created:boolean, tid?:string}}
 */
export function writeInto(lib, input) {
  const target = String(input.target || '').trim()
  const content = String(input.content ?? '')
  let mode = String(input.mode || '').trim()
  if (!target) fail('target 必填：库内相对路径（如 doc/03-build.md）或显式节点 TID（如 fact:abi）')
  if (!content) fail('content 必填：本次要写入的内容')

  const looksPath = /\.md$/i.test(target) || target.includes('/') || target.includes('\\')
  const looksTid = !looksPath && target.includes(':')

  if (looksTid) {
    mode = mode || 'node'
    if (mode !== 'node') fail(`target「${target}」是 TID，只能配 mode=node（或改用相对路径 + append/replace/create）`)
    const node = lib.nodes.get(target)
    if (!node) fail(`库里没有显式节点「${target}」。要新建文件请用相对路径（如 lessons/003.md）`)
    if (node.kind !== 'node') {
      fail(`「${target}」是 ${node.kind === 'section' ? '位置型段落（## 标题）' : node.kind} 节点，不是 <node> 块；改写 ## 段落请用相对路径 + mode=replace`)
    }
    const rel = node.source.split('#')[0]
    const abs = path.isAbsolute(rel) ? path.normalize(rel) : absIn(lib.nodekb, rel)
    if (!fs.existsSync(abs)) fail(`源文件不存在: ${abs}`)
    const raw = fs.readFileSync(abs, 'utf8')
    // 用 source 里的行号定位开标签，再**向后扫**找最近的 </node>。
    // （旧实现只扫 from..from+1，于是「标签独占一行」的合法块永远定位失败——死锁。）
    const hm = /#L(\d+)(?:-L(\d+))?/.exec(node.source || '')
    if (!hm) fail('这个节点没有行号信息，无法就地改写；请用相对路径 + mode=replace 整篇重写')
    const from = Number(hm[1]) - 1
    const lines = raw.split('\n')
    let openAt = -1
    let closeAt = -1
    for (let i = from; i < lines.length; i++) {
      if (openAt < 0) {
        if (/^\s*<node\b/.test(lines[i])) {
          openAt = i
          // 单行形式 <node …>正文</node>
          if (/<\/node>/.test(lines[i])) {
            closeAt = i
            break
          }
        }
        continue
      }
      if (/^\s*<\/node>\s*$/.test(lines[i])) {
        closeAt = i
        break
      }
    }
    if (openAt < 0) fail(`无法在 ${rel} 第 ${from + 1} 行起找到 <node> 开标签；内容可能已被改动，先 kb_read 重看`)
    if (closeAt < 0) {
      fail(
        `无法在 ${rel} 定位 </node>：开标签在第 ${openAt + 1} 行，` +
          `向后扫到文件末（第 ${lines.length} 行）都没有独占一行的 </node>。` +
          `请补上闭合标签，或用相对路径 + mode=replace 整篇重写`,
      )
    }
    validateContent(content, path.basename(abs))
    const bodyLines = content.replace(/^\n+|\n+$/g, '').split('\n')
    if (openAt === closeAt) {
      // 单行 <node …>旧正文</node> → 就地换掉中间那段
      const line = lines[openAt]
      const gt = line.indexOf('>')
      const head = line.slice(0, gt + 1)
      lines[openAt] = `${head}${bodyLines.join(' ')}</node>`
    } else {
      lines.splice(openAt + 1, closeAt - openAt - 1, ...bodyLines)
    }
    fs.writeFileSync(abs, lines.join('\n'), 'utf8')
    return {
      rel,
      abs,
      bytes: Buffer.byteLength(content, 'utf8'),
      mode,
      created: false,
      tid: target,
      // 回执里给真实行区间，便于核对
      lines: `${openAt + 1}–${closeAt + 1}`,
    }
  }

  mode = mode || 'append'
  if (!['append', 'replace', 'create'].includes(mode)) fail(`未知 mode: ${mode}（可用 append / replace / create / node）`)
  const rel = path.relative(lib.nodekb, absIn(lib.nodekb, target)) || target
  const abs = absIn(lib.nodekb, target)
  const existing = readText(abs)
  if (mode === 'create' && existing !== null) fail(`${rel} 已存在。要追加用 mode=append，要整篇覆盖用 mode=replace`)
  validateContent(content, rel)

  let next
  if (mode === 'replace' || existing === null) {
    next = content.endsWith('\n') ? content : content + '\n'
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n'
    next = existing + sep + content.replace(/^\n+/, '') + (content.endsWith('\n') ? '' : '\n')
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, next, 'utf8')
  return { rel, abs, bytes: Buffer.byteLength(content, 'utf8'), mode, created: existing === null }
}

export { NODE_OPEN }
