/**
 * write —— 往库里写内容（**带校验**）。
 *
 * 这是本项目对「Agent 直接用 write/edit 手搭知识库」的回答：
 * 同样是写 md，但写之前校验 TID / 标签独占一行 / 路径在库内，写之后由调用方跑 diag。
 * 手写没有任何一层会拦你，所以规则靠人记；这里的规则是代码。
 */

import fs from 'node:fs'
import path from 'node:path'
import { codeRegions, is_valid_tid, makeFenceTracker } from './parse.js'

const NODE_OPEN = /^<node\b[^>]*>$/m

/** 把行内代码抹成等长空格：`<node>` 写在反引号里是**示例**，不是结构。
 *  解析器已经这么认（inCode），校验器再拿原文拦截就是「比解析器严」——合法写法被拒。 */
function maskInlineCode(line) {
  const regions = codeRegions(line)
  if (!regions.length) return line
  let out = ''
  let pos = 0
  for (const [s, e] of regions) {
    out += line.slice(pos, s) + ' '.repeat(e - s)
    pos = e
  }
  return out + line.slice(pos)
}

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

/** 原文件用什么换行就继续用什么——按 `\n` 硬拼会让 CRLF 文件出现混排。 */
function eolOf(raw) {
  return raw.includes('\r\n') ? '\r\n' : '\n'
}

/** 拆行且不留 `\r`：写完用 `lines.join(eolOf(raw))` 还原，全程单一换行风格。 */
function splitAll(raw) {
  return raw.split(/\r\n|\n|\r/)
}

/**
 * 校验一段将要落盘的内容：node 标签必须独占一行、名字必须是合法 TID。
 *
 * `opts.balance !== false` 时还要求 `<node>` / `<tscl>` 在内容里成对：
 * `</node>` 是包在**本节点外面**的结构，写进正文会把节点提前截断，后面的内容掉到
 * 节点外——回执照样报「写成功」，diag 也只会给一条孤立标签的 warning。
 * 整篇重写（mode=replace）是作者说了算，传 balance:false 关掉这条。
 */
export function validateContent(text, where, opts = {}) {
  // 行号按「用户看到的正文」算：两处写入口落盘前都会剥掉首尾空行，这里同步剥掉，
  // 否则 content 开头多一个换行就会让报错行号整体偏一行（1.5.6 前的报错就偏）。
  const lines = String(text ?? '').replace(/^\n+/, '').split(/\r?\n/)
  const balance = opts.balance !== false
  const fenceOf = makeFenceTracker()
  let opens = 0
  let closes = 0
  let tsclOpens = 0
  let tsclCloses = 0
  // tscl 定义体可以跨行、也可以「开标签 + 正文 + 闭标签 + 同行后缀」写在一行。
  // 只统计行首开标签 / 行尾闭标签，就会把「<tscl id="v">1</tscl> 后面带说明」误判成未闭合——
  // 解析器（mdlib 的 tscl_open 状态机）认这种写法，校验器必须用同一口径。
  let inTscl = false
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    // 围栏（``` / ~~~）里的示例不算真标签，判定口径与解析器共用一份
    if (fenceOf(rawLine) !== 'outside') continue
    // 行内代码里的 `<node>` / `<tscl>` 是示例：解析器不认，校验器也不能拦（否则合法写法被拒）
    const line = inTscl ? rawLine : maskInlineCode(rawLine)
    // 定义体内部：只有独占一行的 </tscl> 才算闭合（解析器也是这么认的）
    if (inTscl) {
      if (/^\s*<\/tscl>\s*$/.test(line)) {
        inTscl = false
        tsclCloses++
      }
      continue
    }
    // 单行 <node …>正文</node>：解析器支持，也不算「把节点截断」，放行
    if (/^\s*<node\b[^>]*>[\s\S]*<\/node>\s*$/.test(line)) continue
    const m = /^\s*<node\b([^>]*)>\s*$/.exec(line)
    if (m) {
      const nameM = /\bname\s*=\s*"([^"]*)"/.exec(m[1]) || /\bname\s*=\s*'([^']*)'/.exec(m[1])
      if (!nameM) fail(`${where}:${i + 1} <node> 缺少 name=`)
      const tid = nameM[1]
      if (!is_valid_tid(tid)) fail(`${where}:${i + 1} 非法 TID「${tid}」：只能用字母/数字/汉字与 : . _ -`)
      opens++
      continue
    }
    if (/^\s*<\/node>\s*$/.test(line)) {
      closes++
      continue
    }
    if (/^\s*<tscl\b/.test(line)) {
      tsclOpens++
      const afterOpen = line.slice(line.indexOf('>') + 1)
      if (/<\/tscl>/.test(afterOpen)) tsclCloses++
      else inTscl = true
      continue
    }
    // 走到这里还带 node 标签的，就是「半个」标签：独行开标签被上面接走了，
    // 剩下的形态（行首 <node …>正文 没有闭合、正文里夹 </node>）都会让解析器丢内容或截断节点。
    const inline = /<node\b|<\/node>/.test(line)
    if (inline) {
      fail(
        `${where}:${i + 1} <node> / </node> 必须独占一行或写成单行 <node …>正文</node>` +
          `（现在是「${rawLine.trim().slice(0, 60)}」）`,
      )
    }
  }
  if (balance) {
    if (closes > opens) {
      fail(
        `${where}: 正文里有 ${closes} 个 </node> 却只有 ${opens} 个 <node> 开标签——` +
          `这个标签是包在**本节点外面**的结构，写进正文会把节点提前截断（后面的内容掉到节点外，` +
          `库里看起来却「写成功了」）。要整篇重写请用相对路径 + mode=replace。`,
      )
    }
    if (opens > closes) {
      fail(
        `${where}: 正文里有 ${opens} 个 <node> 开标签、只有 ${closes} 个 </node>——` +
          `未闭合的标签会吞掉后面的结构（后面的节点/段直接从库里消失）。` +
          `要新建节点请把 </node> 写全，或改用相对路径 + mode=replace。`,
      )
    }
    if (tsclOpens !== tsclCloses) {
      fail(
        `${where}: 正文里有 ${tsclOpens} 个 <tscl …> 开标签、${tsclCloses} 个 </tscl>——` +
          `未闭合的定义会吞掉后面的内容。请写全，或改用相对路径 + mode=replace。`,
      )
    }
  }
  return true
}

/**
 * 改写一个 `## 段` 节点：保留标题行，只换正文。
 *
 * 保守的地方：段内若有 `<node>` / `<tscl>` 开标签，整段替换会连带删掉它们，
 * 所以直接拒绝并给出逃生口（相对路径 + mode=replace）。宁可让 Agent 多一步，
 * 也不要静默丢节点。
 */
function writeSection(lib, node, target, content) {
  // node.source 是绝对路径#L1-L22；回执与报错里一律用库内相对路径，
  // 和 create/append 保持一致（否则 mode=node 回执会冒出整条绝对路径）。
  const abs = absIn(lib.nodekb, node.source.split('#')[0])
  const rel = path.relative(lib.nodekb, abs).split(path.sep).join('/')
  if (!fs.existsSync(abs)) fail(`源文件不存在: ${abs}`)
  const raw = fs.readFileSync(abs, 'utf8')
  const eol = eolOf(raw)
  const lines = splitAll(raw)
  const hm = /#L(\d+)/.exec(node.source || '')
  if (!hm) fail(`${rel} 里的「${node.title}」没有行号，无法定位；请用相对路径 + mode=replace`)
  const from = Number(hm[1]) - 1
  const head = lines[from] || ''
  if (!/^#{1,2}\s/.test(head) || head.replace(/^#{1,2}\s+/, '').trim() !== String(node.title).trim()) {
    fail(
      `「${node.title}」现在不在第 ${from + 1} 行了（那一行是「${head.trim().slice(0, 40)}」）。` +
        `文件可能刚被改过：先 kb_read 重看，或用相对路径 + mode=replace 整篇重写。`,
    )
  }
  // 段的边界 = 下一个 H1/H2 之前（文件末尾也算）；围栏内的 `# 注释` 不算标题。
  let end = from + 1
  const fenceAt = makeFenceTracker()
  while (end < lines.length) {
    if (fenceAt(lines[end]) !== 'outside') {
      end++
      continue
    }
    if (/^#{1,2}\s/.test(lines[end])) break
    end++
  }
  let bodyEnd = end
  while (bodyEnd > from + 1 && lines[bodyEnd - 1].trim() === '') bodyEnd--
  const risky = []
  const fenceInside = makeFenceTracker()
  for (let i = from + 1; i < bodyEnd; i++) {
    if (fenceInside(lines[i]) !== 'outside') continue // 围栏里的标签/标题是示例，不算结构
    if (/^\s*(<node\b|<tscl\b)/.test(lines[i])) risky.push(`${i + 1}: ${lines[i].trim().slice(0, 50)}`)
    // 更深的标题（###…）也是结构：替换整段会把它和它下面的内容一起删掉，而且事后 diag 查不出来
    else if (/^#{1,6}\s/.test(lines[i])) risky.push(`${i + 1}: ${lines[i].trim().slice(0, 50)}`)
  }
  if (risky.length) {
    fail(
      `「${node.title}」这一段里有 ${risky.length} 处会被整段替换删掉的结构（更深的标题或 <node>/<tscl> 标签）——已拒绝。\n` +
        risky.slice(0, 3).map((s) => '  ' + s).join('\n') +
        `\n要改这一整段，请用相对路径 ${rel} + mode=replace（整篇）；只想改这段正文就先把这些子节/节点移出去。`,
    )
  }
  validateContent(content, rel)
  // 允许把本段标题一并贴回来（kb_read 渲染出来就带标题）：首行等于本段标题时剥掉，
  // 否则会在文件里插出第二个同名段——段被静默劈成两半，回执照样报「已写入」。
  let bodyText = content.replace(/^\n+|\n+$/g, '')
  const firstLine = bodyText.split('\n')[0]
  if (/^#{1,6}\s/.test(firstLine) && firstLine.replace(/^#{1,6}\s+/, '').trim() === String(node.title).trim()) {
    bodyText = bodyText.split('\n').slice(1).join('\n').replace(/^\n+|\n+$/g, '')
  }
  // 剩下的标题行是真的结构：写进正文会新开一个段，同样把本段劈成两半。
  // 想要子节就用相对路径 + mode=replace 重写整篇，别在段正文里塞标题。
  const headingCheck = makeFenceTracker()
  for (const line of bodyText.split('\n')) {
    if (headingCheck(line) !== 'outside') continue
    if (/^#{1,6}\s/.test(line)) {
      fail(
        `要写的正文里有标题行「${line.trim().slice(0, 40)}」——段正文里插标题会新开一个段（静默把本段劈成两半）。` +
          `\n要拆段请用相对路径 ${rel} + mode=replace 整篇重写。`,
      )
    }
  }
  // 写成「标题 / 空行 / 正文 / 空行」：标题贴着正文在多处 markdown 渲染里会被当成同一个段落，
  // 而紧贴下一个段标题又会让两段粘在一起（排版问题，不影响解析，但没理由留给用户手修）。
  //
  // 替换区间一律取**未 trim 的 `end`**：段尾原有的空行随区间一起被换掉，而不是「留着旧的、再补一个新的」。
  // 旧实现用 bodyEnd（退到尾部空行之前）+ body 固定补一个尾部 ''，于是每写一次就多长一个空行
  // （2→3→4…），段又是最高频的写入形态，长期迭代的文档会越来越松散。
  const region = bodyText.length ? ['', ...bodyText.split('\n'), ''] : ['']
  lines.splice(from + 1, end - (from + 1), ...region)
  fs.writeFileSync(abs, lines.join(eol), 'utf8')
  return {
    rel,
    abs,
    bytes: Buffer.byteLength(content, 'utf8'),
    mode: 'node',
    created: false,
    tid: target,
    kind: 'section',
    lines: `${from + 2}–${from + 1 + region.length}`,
  }
}

/**
 * @param {{nodekb:string, nodes:Map}} lib 已打开的库
 * @param {{target:string, content:string, mode?:'append'|'replace'|'create'|'node'}} input
 * @returns {{rel:string, abs:string, bytes:number, mode:string, created:boolean, tid?:string}}
 */
export function writeInto(lib, input) {
  const target = String(input.target || '').trim()
  // 内容先归一成 LF：模型从 CRLF 文件里抄一段回来必然带着 `\r`，
  // 再按文件的 eol 拼回去就成了 `\r\r\n`（字节坏了、回执和 diag 却都说正常）。
  const content = String(input.content ?? '').replace(/\r\n?/g, '\n')
  let mode = String(input.mode || '').trim()
  if (!target) fail('target 必填：库内相对路径（如 doc/03-build.md）或显式节点 TID（如 fact:abi）')
  if (!content) fail('content 必填：本次要写入的内容')

  const looksPath = /\.md$/i.test(target) || target.includes('/') || target.includes('\\')
  // 显式节点的 TID 不一定含冒号（`<node name="abi">` 的 TID 就是 `abi`，库根文件 `README.md` 是 `readme`），
  // 所以**先查库里有没有这个 TID**，查不到才退回「含冒号」的启发式，最后当路径。
  const isKnownTid = lib.nodes.has(target)
  const tidLike = isKnownTid || (!looksPath && target.includes(':'))

  if (mode === 'node' && !tidLike) {
    fail(
      `mode=node 只能改节点 TID（如 doc:03-x，或 <node name="abi"> 的 abi）；` +
        `「${target}」是文件路径，请用 append / replace / create。`,
    )
  }

  if (tidLike) {
    mode = mode || 'node'
    if (mode !== 'node') fail(`target「${target}」是 TID，只能配 mode=node（或改用相对路径 + append/replace/create）`)
    const node = lib.nodes.get(target)
    if (!node) fail(`库里没有显式节点「${target}」。要新建文件请用相对路径（如 lessons/003.md）`)
    if (node.kind === 'section') return writeSection(lib, node, target, content)
    if (node.kind !== 'node') {
      fail(`「${target}」是 ${node.kind} 节点，不是 <node> 块也不能整段替换；请用相对路径 + mode=replace`)
    }
    // 同上：回执与报错统一用库内相对路径（source 里存的是绝对路径#L1-L22）
    const srcAbs = node.source.split('#')[0]
    const abs = path.isAbsolute(srcAbs) ? path.normalize(srcAbs) : absIn(lib.nodekb, srcAbs)
    const rel = path.relative(lib.nodekb, abs).split(path.sep).join('/')
    if (!fs.existsSync(abs)) fail(`源文件不存在: ${abs}`)
    const raw = fs.readFileSync(abs, 'utf8')
    // 用 source 里的行号定位开标签，再**向后扫**找最近的 </node>。
    // （旧实现只扫 from..from+1，于是「标签独占一行」的合法块永远定位失败——死锁。）
    const hm = /#L(\d+)(?:-L(\d+))?/.exec(node.source || '')
    if (!hm) fail('这个节点没有行号信息，无法就地改写；请用相对路径 + mode=replace 整篇重写')
    const from = Number(hm[1]) - 1
    const eol = eolOf(raw)
    const lines = splitAll(raw)
    let openAt = -1
    let closeAt = -1
    // 围栏里的 <node>…</node> 是示例，扫标签时必须跳过（否则示例的 </node> 会被当成真闭合）
    const fenceOf = makeFenceTracker()
    for (let i = from; i < lines.length; i++) {
      if (fenceOf(lines[i]) !== 'outside') continue
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
    fs.writeFileSync(abs, lines.join(eol), 'utf8')
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

  // 既不是已知 TID、也不像路径（没有 .md、没有目录分隔符）：别在库根造出解析器看不见的垃圾文件
  if (!looksPath && !target.includes(':')) {
    fail(
      `没有名为「${target}」的节点，它也不像库内路径。` +
        `要新建文件请写带 .md 的相对路径（如 notes/${target}.md）；要改已有节点请用它的 TID（kb_read --toc 可查）。`,
    )
  }
  if (!/\.md$/.test(target)) {
    // 建议的名字要真的可用：大写扩展名（notes/x.MD）时不能把刚被拒的原样贴回去
    const suggest = /\.md$/i.test(target) ? target.replace(/\.md$/i, '.md') : target + '.md'
    fail(`库文件必须是 .md（小写扩展名）：把 target 写成「${suggest}」`)
  }
  mode = mode || 'append'
  if (!['append', 'replace', 'create'].includes(mode)) fail(`未知 mode: ${mode}（可用 append / replace / create / node）`)
  const abs = absIn(lib.nodekb, target)
  const rel = path.relative(lib.nodekb, abs).split(path.sep).join('/') || target
  // 点开头的目录/文件（.draft/x.md、.hidden.md）会被解析器跳过：写进去等于写了个看不见的文件
  const dotSeg = rel.split('/').find((s) => s.startsWith('.'))
  if (dotSeg !== undefined) {
    fail(
      `路径里有点开头的目录/文件（「${dotSeg}」在 ${rel} 里）：解析器会跳过它们，写进去等于写了个看不见的文件。` +
        `换成不以点开头的名字，或先确认这份内容属于库外。`,
    )
  }
  const existing = readText(abs)
  if (mode === 'create' && existing !== null) fail(`${rel} 已存在。要追加用 mode=append，要整篇覆盖用 mode=replace`)
  // 整篇重写是作者说了算（一份文件里可以有多对 <node>），其余模式要求标签成对
  validateContent(content, rel, { balance: mode !== 'replace' })

  let next
  if (mode === 'replace' || existing === null) {
    next = content.endsWith('\n') ? content : content + '\n'
  } else {
    // 追加也跟随原文件换行：CRLF 文件里塞进去的 "\n" 会变成混排。
    // 末尾统一由这里补一个 eol：内容自带的结尾换行直接剥掉（否则 CRLF 文件里混进裸 LF）。
    const eol = eolOf(existing)
    const sep = /\n$/.test(existing) ? eol : eol + eol
    const body = content.replace(/^\n+/, '').replace(/\n+$/, '')
    if (!body.trim()) fail('content 里只有空行，没有实际内容')
    next = existing + sep + body + eol
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, next, 'utf8')
  return { rel, abs, bytes: Buffer.byteLength(content, 'utf8'), mode, created: existing === null }
}

export { NODE_OPEN }
