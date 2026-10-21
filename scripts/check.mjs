#!/usr/bin/env node
/**
 * 离线自检：不装 DSH、不开浏览器，在 Node 里把两面都跑一遍。
 *
 *   node scripts/check.mjs
 *
 * 覆盖：
 *   1. package.json 的清单契约（exports / dsh.bundle.patch / dsh.client.platform / files）
 *   2. cordis.patch.yml 的 name 必须是包名
 *   3. 宿主面：import 得到 apply/inject；tools.register 收到 6 个工具；真跑 kb_read/kb_search/kb_diag
 *   4. 宿主面：webServer.register 收到 kind=prefix 的 /nodekb/api
 *   5. 浏览器面：在 vm 里跑 lib/client.js，捕获得 load({id,factory})，断言 id === 包名
 *   6. 浏览器面：桩 ctx 跑 apply，断言两个槽位都注册上；再跑一次 Panel() 走通渲染路径
 *   7. 两侧都不许 import @deepseek-ai/*
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const url = (p) => pathToFileURL(p).href

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

// ── 1. 清单契约 ────────────────────────────────────────────────────────────
section('清单契约')
ok('name 是 project-node-memory', pkg.name === 'project-node-memory', pkg.name)
ok('type=module', pkg.type === 'module')
ok('exports["."] 指向 lib/index.js', pkg.exports && pkg.exports['.'] && pkg.exports['.'].default === './lib/index.js')
ok('exports["./client"] 指向 lib/client.js', pkg.exports && pkg.exports['./client'] && pkg.exports['./client'].default === './lib/client.js')
ok('dsh.bundle.patch 存在', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml')
ok('dsh.client.platform === "web"', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web')
ok('dsh.compatibility.dsh 有值', pkg.dsh && pkg.dsh.compatibility && typeof pkg.dsh.compatibility.dsh === 'string')
ok('没有 dsh.engines.dsh（没人读它）', !(pkg.dsh && pkg.dsh.engines))
ok('没有 @deepseek-ai/* 依赖', !JSON.stringify(pkg.dependencies || {}).includes('@deepseek-ai'))
ok('没有 @deepseek-ai/* peerDependencies', !JSON.stringify(pkg.peerDependencies || {}).includes('@deepseek-ai'))
ok('files 白名单含 lib', Array.isArray(pkg.files) && pkg.files.includes('lib'))
ok('files 白名单含 cordis.patch.yml', Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'))

const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
ok('patch 里 name 是包名', new RegExp(`name:\\s*${pkg.name}\\b`).test(patch), patch.trim())

// ── 2. 源码不得 import 运行时 ───────────────────────────────────────────────
section('源码卫生')
for (const file of walk(path.join(root, 'lib'))) {
  const src = fs.readFileSync(file, 'utf8')
  ok(`${path.relative(root, file)} 不含 @deepseek-ai`, !/from\s+['"]@deepseek-ai|require\(['"]@deepseek-ai/.test(src))
  ok(`${path.relative(root, file)} 是 LF 行尾`, !src.includes('\r\n'))
}

// ── 3. 宿主面 ──────────────────────────────────────────────────────────────
section('宿主面')
const host = await import(url(path.join(root, 'lib/index.js')))
ok('导出 apply()', typeof host.apply === 'function')
ok('导出 name 与包名一致', host.name === pkg.name, host.name)
ok('inject 含 tools 与 webServer', Array.isArray(host.inject) && host.inject.includes('tools') && host.inject.includes('webServer'))

const registered = []
const routes = []
const stubCtx = {
  tools: { register: (t) => { registered.push(t); return () => {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
}
const dispose = host.apply(stubCtx, {})
ok('apply 返回 disposer', typeof dispose === 'function')
const names = registered.map((t) => t.name)
ok('注册 9 个工具', registered.length === 9, names.join(','))
for (const want of ['kb_list', 'kb_read', 'kb_search', 'kb_diag', 'kb_backlinks', 'kb_init', 'kb_write', 'kb_rename', 'kb_vcs_status']) {
  ok(`工具 ${want} 在册`, names.includes(want))
}
ok('每个工具都有 description', registered.every((t) => typeof t.description === 'string' && t.description.length > 20))
ok('每个工具都有 parameters.type=object', registered.every((t) => t.parameters && t.parameters.type === 'object'))
ok('每个工具都有 output.render', registered.every((t) => t.output && typeof t.output.render === 'function'))
ok('路由 kind=prefix 且 path=/nodekb/api', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/nodekb/api', JSON.stringify(routes.map((r) => r.path)))

// 升级时旧 route 还没释放：注册不能因此让整行激活失败
let dupThrew = null
try {
  host.apply(
    {
      tools: { register: () => () => {} },
      webServer: { register: () => { throw new Error('webserver: duplicate prefix route "/nodekb/api"') } },
    },
    {},
  )
} catch (e) {
  dupThrew = e
}
ok('route 重复时 apply 不抛（降级为跳过注册）', dupThrew === null, dupThrew && dupThrew.message)
ok(
  'route 重复时仍把请求转发到最新处理器（新旧符号都写）',
  typeof globalThis[Symbol.for('project-node-memory.live-handler.v1')] === 'function' &&
    typeof globalThis[Symbol.for('dsh-nodekb.live-handler.v1')] === 'function',
  typeof globalThis[Symbol.for('project-node-memory.live-handler.v1')],
)

// 宿主若拒收某一条工具定义，只有那一个消失，其余照旧（整批 map 会带走全部）
{
  const solo = []
  host.apply(
    {
      tools: {
        register: (t) => {
          if (t.name === 'kb_read') throw new Error('unsupported parameter schema')
          solo.push(t.name)
          return () => {}
        },
      },
      webServer: { register: () => () => {} },
    },
    {},
  )
  const toolsMod = await import(url(path.join(root, 'lib/host/tools.js')))
  ok('单个工具注册失败不带走其余的', solo.length === 8 && !solo.includes('kb_read'), solo.join(','))
  ok('失败清单可自证', JSON.stringify(toolsMod.toolState().failed) === '["kb_read"]' && toolsMod.toolState().registered === 8, JSON.stringify(toolsMod.toolState()))
}

// 改名前的旧 route（闭包里的旧符号）在调用时必须转到跳板 —— 「改名不重启」全靠这一步
{
  const SYM_NEW = Symbol.for('project-node-memory.live-handler.v1')
  const SYM_OLD = Symbol.for('dsh-nodekb.live-handler.v1')
  const prevNew = globalThis[SYM_NEW]
  const prevOld = globalThis[SYM_OLD]
  let forwarded = 0
  // 两个符号都换成计数器：不依赖当前实现先读哪一个
  globalThis[SYM_NEW] = async () => {
    forwarded++
  }
  globalThis[SYM_OLD] = async () => {
    forwarded++
  }
  const fakeRes = { statusCode: 0, setHeader() {}, end() {}, writeHead() {}, write() {} }
  await routes[0].handler({ url: '/nodekb/api/libs' }, fakeRes)
  ok('旧路由被调用时转发给最新处理器', forwarded === 1, String(forwarded))
  globalThis[SYM_NEW] = prevNew
  globalThis[SYM_OLD] = prevOld
}

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const FIX = 'test/fixtures/sample'
const kbList = await byName.kb_list.execute({}, {})
ok('kb_list 返回文本', typeof kbList.text === 'string' && kbList.text.includes('nodekb'), kbList.text && kbList.text.slice(0, 80))

const readToc = await byName.kb_read.execute({ lib: FIX, target: 'doc:index', mode: 'toc' }, {})
ok('kb_read toc 列出子节', readToc.text.includes('doc:index:'), readToc.text.slice(0, 120))
const readOne = await byName.kb_read.execute({ lib: FIX, target: 'fact:abi-trap', mode: 'node' }, {})
ok('kb_read node 读到正文', readOne.text.includes('拷贝'), readOne.text.slice(0, 80))
ok('kb_read node 回填了 tid/type', readOne.tid === 'fact:abi-trap' && readOne.type === 'fact', `${readOne.tid}/${readOne.type}`)
const readSub = await byName.kb_read.execute({ lib: FIX, target: 'doc', mode: 'subtree', maxlen: 0 }, {})
ok('kb_read subtree 展开引用', readSub.text.includes('## ') && readSub.chars > 40, String(readSub.chars))

const searched = await byName.kb_search.execute({ lib: FIX, query: '拷贝' }, {})
ok('kb_search 有命中', searched.total > 0 && searched.hits.length > 0, JSON.stringify(searched.total))
ok('kb_search 命中带稳定 tid', searched.hits.every((h) => typeof h.tid === 'string' && h.tid.length > 0))

const backl = await byName.kb_backlinks.execute({ lib: FIX, target: 'fact:abi' }, {})
ok('kb_backlinks 找到引用者', backl.count > 0, String(backl.count))
ok('kb_backlinks 认出 doc:index', backl.backlinks.some((b) => b.tid === 'doc:index'), JSON.stringify(backl.backlinks.map((b) => b.tid)))

let diagThrew = null
try {
  await byName.kb_diag.execute({ lib: FIX }, {})
} catch (e) {
  diagThrew = e
}
ok('kb_diag 在 errors 非空时抛错', diagThrew !== null)
ok('错误码是 KB_DIAG_FAILED', diagThrew && diagThrew.code === 'KB_DIAG_FAILED', diagThrew && diagThrew.code)

const { diag } = await import(url(path.join(root, 'lib/engine/diag.js')))
const { parse_library } = await import(url(path.join(root, 'lib/engine/mdlib.js')))
const problems = []
const nodes = parse_library(path.join(root, FIX, '.nodekb'), problems)
const { report, code } = diag(nodes, { problems, strict: false, libRoot: path.join(root, FIX, '.nodekb') })
ok('diag 退出码非 0（夹具里故意有坏引用）', code !== 0, String(code))
ok('diag 抓到悬空引用', report.errors.some((e) => e.includes('悬空引用')), JSON.stringify(report.errors))
ok('diag 抓到位置型引用', report.errors.some((e) => e.includes('位置型')), JSON.stringify(report.errors))
ok('diag 报告 nodes/types', typeof report.node_count === 'number' && typeof report.types === 'object')

// ── 4. 浏览器面 ────────────────────────────────────────────────────────────
section('浏览器面')
const clientSrc = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')
let captured = null
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init === undefined ? null : init }),
}
const docStub = {
  getElementById: () => null,
  createElement: () => ({ set id(v) {}, textContent: '' }),
  head: { appendChild: () => {} },
}
const sandbox = {
  console,
  document: docStub,
  fetch: () => Promise.reject(new Error('offline')),
  setTimeout,
  encodeURIComponent,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = {
  load: (spec) => {
    captured = spec
  },
}
sandbox.window.React = reactStub
vm.createContext(sandbox)
let threw = null
try {
  vm.runInContext(clientSrc, sandbox, { filename: 'lib/client.js' })
} catch (e) {
  threw = e
}
ok('client.js 可在脚本沙箱里执行', threw === null, threw && threw.message)
ok('调用了 __ModuleLoader__.load', captured !== null)
ok('load 的 id 是包名', captured && captured.id === pkg.name, captured && captured.id)
ok('factory 是函数', captured && typeof captured.factory === 'function')

const req = (name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
}
const plugin = captured.factory(req)
ok('factory 返回 apply()', typeof plugin.apply === 'function')
ok('inject 含 slots', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

const slots = []
const slotCtx = { slots: { register: (spec) => { slots.push(spec); return () => {} } } }
const clientDispose = plugin.apply(slotCtx)
ok('client apply 返回 disposer', typeof clientDispose === 'function')
ok('注册 2 个槽位', slots.length === 2, JSON.stringify(slots.map((s) => s.name)))
ok('sidebar.panellist id=nodekb', slots.some((s) => s.name === 'sidebar.panellist' && s.id === 'nodekb'))
ok('main key=nodekb', slots.some((s) => s.name === 'main' && s.key === 'nodekb'))
ok('label 是 thunk', slots.filter((s) => s.name === 'sidebar.panellist').every((s) => typeof s.label === 'function'))
ok('侧栏显示名是「项目节点知识库」', (() => {
  const s = slots.find((x) => x.name === 'sidebar.panellist')
  return s && s.label() === '项目节点知识库'
})(), (() => { const s = slots.find((x) => x.name === 'sidebar.panellist'); return s && s.label() })())
ok('load 的 id 等于新的包名', captured.id === 'project-node-memory', captured.id)
ok('样式表 id 跟着改名', clientSrc.includes("'project-node-memory-style'"))

// 回归：槽位晚声明时走 slots.inject 等声明，而不是当场抛「is not declared」。
// （DSH 的 main 槽由侧栏条目声明，冷启动时可能晚于本插件 apply。）
{
  const armed = []
  const lateSlots = {
    register: (spec) => { armed.push(spec); return () => {} },
    inject: (name, cb) => { armed.push({ name, cb }); return () => {} },
  }
  plugin.apply({ slots: lateSlots })
  const waiting = armed.filter((x) => x.cb)
  ok('有 inject 时先挂声明钩子（不立即 register）', waiting.length === 2 && armed.length === 2, JSON.stringify(armed.map((x) => x.name || x.cb)))
  ok('钩住的槽名正确', waiting.map((x) => x.name).join(',') === 'sidebar.panellist,main', waiting.map((x) => x.name).join(','))
  for (const w of waiting) w.cb()
  ok('声明后真注册两个槽位', armed.filter((x) => x.register === undefined && x.name && !x.cb).length === 2 || armed.length === 4)
}

let tree = null
let renderErr = null
try {
  tree = plugin.Panel()
} catch (e) {
  renderErr = e
}
ok('Panel() 渲染不抛', renderErr === null, renderErr && renderErr.message)
ok('Panel() 返回 nkb-root', tree && tree.props && tree.props.className === 'nkb-root', tree && tree.props && tree.props.className)
ok('Panel 有 head 与 body', tree && tree.children.length === 2)
ok('Icon() 返回 svg', (() => {
  try { return plugin.Icon({ size: 18 }).type === 'svg' } catch { return false }
})())

// 节点图布局：纯函数，直接驱动
{
  const I = plugin.__internals
  const mk = (tid, type, kids) => ({ tid, title: tid, type, kind: 'section', children: kids || [] })
  const root = mk('root', 'root', [
    mk('a', 'doc', [mk('a:1', 'doc'), mk('a:2', 'doc')]),
    mk('b', 'todo'),
  ])
  ok('__internals 暴露布局函数', !!I && typeof I.layoutGraph === 'function')
  const lay = I.layoutGraph(root, { dir: 'TB', maxDepth: 9, hidden: {}, collapsed: {} })
  ok('布局含全部节点与边', lay.items.length === 5 && lay.edges.length === 4, `${lay.items.length}/${lay.edges.length}`)
  ok('根在顶部', lay.items.find((i) => i.tid === 'root').y === 0)
  ok('同层 y 相同', lay.items.filter((i) => i.depth === 1).every((i) => i.y === lay.items.find((x) => x.tid === 'a').y))
  ok('布局给出正的外框', lay.width > 0 && lay.height > 0, `${lay.width}x${lay.height}`)
  const lr = I.layoutGraph(root, { dir: 'LR', maxDepth: 9, hidden: {}, collapsed: {} })
  ok('LR 时深度换成 x', lr.items.find((i) => i.tid === 'a').x > 0 && lr.items.find((i) => i.tid === 'a').y >= 0)
  const byDepth = I.layoutGraph(root, { dir: 'TB', maxDepth: 1, hidden: {}, collapsed: {} })
  ok('maxDepth=1 只留两层', byDepth.items.length === 3 && !byDepth.items.some((i) => i.tid === 'a:1'), String(byDepth.items.length))
  const hid = I.layoutGraph(root, { dir: 'TB', maxDepth: 9, hidden: { todo: true }, collapsed: {} })
  ok('隐藏类型生效', !hid.items.some((i) => i.tid === 'b'))
  const col = I.layoutGraph(root, { dir: 'TB', maxDepth: 9, hidden: {}, collapsed: { a: true } })
  ok('折叠节点不再展开子节点', !col.items.some((i) => i.tid === 'a:1'))
  ok('edgePath 产出 SVG path', /^M[\d.]+,/.test(I.edgePath({ x: 0, y: 0 }, { x: 100, y: 100 }, true)))
}

// markdown 渲染：块解析是纯函数，先测数据形状再测组件
{
  const I = plugin.__internals
  const blocks = I.mdBlocks(
    ['# 标题', '', '前言 **粗** 与 `码` 和 [[fact:abi]]', '', '- 一', '- 二', '', '1. 甲', '', '> 引用', '', '---', '', '```js', '# 不是标题', 'x()', '```', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
  )
  const kinds = blocks.map((b) => b.k)
  ok('md 解析出标题/段落/列表/引用/分隔线/代码/表格', ['h', 'p', 'list', 'list', 'quote', 'hr', 'code', 'table'].every((k) => kinds.includes(k)), kinds.join(','))
  ok('标题层级正确', blocks.find((b) => b.k === 'h').level === 1)
  ok('代码块内容原样保留（内部 # 不被当标题）', (() => {
    const c = blocks.find((b) => b.k === 'code')
    return c.text === '# 不是标题\nx()' && c.lang === 'js'
  })())
  ok('表格切了表头与一行数据', (() => {
    const t = blocks.find((b) => b.k === 'table')
    return t.head.join('|') === 'a|b' && t.rows.length === 1
  })())
  ok('有序/无序列表分开解析', blocks.filter((b) => b.k === 'list').map((b) => b.items[0].ordered).join(',') === 'false,true')
  const inline = I.mdInline('**粗** `码` [[fact:abi]] [链](https://x.y)', null, 'k')
  ok('行内解析出 strong/code/TID 链接/外链', inline.filter((x) => x && x.type).map((x) => x.type).join(',') === 'strong,code,span,a', inline.map((x) => (x && x.type) || typeof x).join(','))
  ok('同一类型颜色恒定、不同类型不同色', I.typeColor('doc') === I.typeColor('doc') && I.typeColor('doc') !== I.typeColor('todo'))
  ok('未知类型也能取色', /hsl\(/.test(I.typeColor('从未见过的类型')))
  const mdTree = I.Md({ text: '# 标题\n\n- 一\n- 二\n\n段落 `x`' })
  ok('Md 渲染出 nkb-md 容器与三个块', mdTree.props.className === 'nkb-md' && mdTree.children[0].length === 3, String(mdTree.children[0] && mdTree.children[0].length))
  // 宽表格必须被包在横向滚动容器里，否则会顶出右栏
  const tblTree = I.Md({ text: '| a | b |\n| --- | --- |\n| 1 | 2 |' })
  const tblNode = tblTree.children[0][0]
  ok('表格外面套 nkb-tablewrap', tblNode.props.className === 'nkb-tablewrap' && tblNode.children[0].type === 'table', tblNode.props.className)
  ok('CSS 给 .nkb-tablewrap 横向滚动', /\.nkb-tablewrap\{[^}]*overflow-x:auto/.test(clientSrc))
  ok('CSS 给 .nkb-md 兜住 flex 高度（min-height:0）', /\.nkb-md\{[^}]*min-height:0/.test(clientSrc))
  ok('右栏正文有 10000 字符上限', clientSrc.includes('var TEXT_LIMIT = 10000') && clientSrc.includes('已显示前 '))
}

// LaTeX → MathML
{
  const I = plugin.__internals
  const tex = (s) => I.texToMathML(s, false)
  ok('分数', tex('\\frac{a}{b}').includes('<mfrac>'))
  ok('上标', tex('x^2').includes('<msup>') && tex('x^2').includes('<mn>2</mn>'))
  ok('下标', tex('a_i').includes('<msub>'))
  ok('上下标同体', tex('x_i^2').includes('<msubsup>'))
  ok('指数只挂最后一个字母（TeX 原子语义）', (() => {
    const m = tex('mc^2')
    return m.includes('<msup><mi>c</mi>') && !m.includes('<mi>mc</mi>')
  })())
  ok('\\left…\\right 成组后整体带上标', /<msup><mrow><mo fence/.test(tex('\\left( x \\right)^2')))
  ok('根号', tex('\\sqrt{x}').includes('<msqrt>'))
  ok('n 次根', tex('\\sqrt[3]{x}').includes('<mroot>'))
  ok('希腊字母走 mi', /<mi>α<\/mi>/.test(tex('\\alpha')))
  ok('关系符走 mo', /<mo>≤<\/mo>/.test(tex('\\le')))
  ok('求和是 largeop', /largeop="true"/.test(tex('\\sum_{i=1}^{n} x_i')))
  ok('函数名直立', /<mi mathvariant="normal">sin<\/mi>/.test(tex('\\sin x')))
  ok('带括号矩阵两行两列', (() => {
    const m = tex('\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}')
    return (m.match(/<mtr>/g) || []).length === 2 && (m.match(/<mtd>/g) || []).length === 4
  })())
  ok('cases 左侧花括号', /fence="true"[^>]*>\{/.test(tex('\\begin{cases}x & y\\\\ z & w\\end{cases}')))
  ok('转义尖括号不注入标签', I.texToMathML('a<b', false).includes('&lt;'))
  ok('未知命令不抛', tex('\\notacommand{x}').includes('notacommand'))
  ok('display 带 block 属性', I.texToMathML('x', true).includes('display="block"'))
  ok('$$ 成为独立公式块', (() => {
    const bs = I.mdBlocks('前言\n\n$$\nE = mc^2\n$$\n\n后记')
    const mm = bs.filter((b) => b.k === 'math')
    return mm.length === 1 && mm[0].text.trim() === 'E = mc^2'
  })())
  ok('```math 围栏也是公式块', (() => {
    const bs = I.mdBlocks('```math\na^2+b^2=c^2\n```')
    return bs.length === 1 && bs[0].k === 'math'
  })())
  ok('行内 $x^2$ 渲染成 MathML', (() => {
    const parts = I.mdInline('面积 $a^2$ 与 `$not math$`', null, 'k')
    const mathEl = parts.find((p) => p && p.props && p.props.className === 'nkb-math')
    const codeEl = parts.find((p) => p && p.type === 'code')
    return !!mathEl && mathEl.props.dangerouslySetInnerHTML.__html.includes('<msup>') && !!codeEl && codeEl.children[0] === '$not math$'
  })())
}

// ── 5. 路由 HTTP 端到端（面板真正吃的那几个 JSON）─────────────────────────
section('路由 HTTP 端到端')
{
  const http = await import('node:http')
  if (typeof globalThis.fetch !== 'function') {
    console.log('  --  Node 没有 fetch，跳过')
  } else {
    let routeHandler = null
    const fakeWs = path.resolve(root, FIX)
    const routeCtx = {
      tools: { register: () => () => {} },
      webServer: { register: (r) => { routeHandler = r.handler; return () => {} } },
      get: (k) => (k === 'workspaceRegistry'
        ? { list: () => [{ id: 'w1', title: 'fixture', path: fakeWs }, { id: 'w2', title: 'elsewhere', path: path.resolve(root, 'nope') }] }
        : undefined),
    }
    host.apply(routeCtx, {})
    const server = http.createServer((req, res) => routeHandler(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const base = `http://127.0.0.1:${port}/nodekb/api`
    const j = async (p) => {
      const r = await fetch(base + p)
      return { status: r.status, body: await r.json() }
    }
    const lib = encodeURIComponent(FIX)
    try {
      const libs = await j('/libs')
      ok('GET /libs 200 且有 libs 数组', libs.status === 200 && Array.isArray(libs.body.libs))

      const wss = await j('/workspaces')
      ok('GET /workspaces 200 且总有 workspaces 数组', wss.status === 200 && Array.isArray(wss.body.workspaces), String(wss.status))
      ok('/workspaces 映射注册表的 id/title/path', wss.body.workspaces.length === 2 && wss.body.workspaces[0].path === fakeWs, JSON.stringify(wss.body.workspaces).slice(0, 120))
      ok('/workspaces 标出哪些目录有 .nodekb', wss.body.workspaces[0].nodekb === true && wss.body.workspaces[1].nodekb === false)

      const tree2 = await j(`/tree?lib=${lib}`)
      ok('GET /tree 200', tree2.status === 200, String(tree2.status))
      ok('tree 根是 root 且有节点', tree2.body.tree && tree2.body.tree.tid === 'root' && tree2.body.nodeCount > 0, String(tree2.body.nodeCount))
      ok('tree 节点带 children/chars', Array.isArray(tree2.body.tree.children) && typeof tree2.body.tree.chars === 'number')

      // ws 参数：面板没有会话上下文，靠人指定工作区。这里把它指到上一级，
      // 同一个 lib 字符串只有 honor ws 才能解析成功。
      const parentWs = encodeURIComponent(path.dirname(root))
      const wsTree = await j(`/tree?ws=${parentWs}&lib=${encodeURIComponent(path.basename(root) + '/' + FIX)}`)
      ok('ws 参数被采纳（相对路径按 ws 解析）', wsTree.status === 200 && wsTree.body.nodeCount > 0, `${wsTree.status} ${JSON.stringify(wsTree.body).slice(0, 80)}`)

      const node2 = await j(`/node?lib=${lib}&tid=${encodeURIComponent('doc:index')}&mode=subtree`)
      ok('GET /node 200 且正文含标题', node2.status === 200 && node2.body.text.includes('编译契约'), String(node2.status))
      ok('node 带 tid/mode/children', node2.body.tid === 'doc:index' && node2.body.mode === 'subtree' && Array.isArray(node2.body.children))

      const nodeNode = await j(`/node?lib=${lib}&tid=${encodeURIComponent('fact:abi')}&mode=node`)
      ok('mode=node 只回本节点', nodeNode.status === 200 && !nodeNode.body.text.includes('## '), nodeNode.body.text.slice(0, 40))

      const bad = await j(`/node?lib=${lib}&tid=${encodeURIComponent('nope:nope')}`)
      ok('找不到节点回 404', bad.status === 404 && typeof bad.body.error === 'string')

      const srch = await j(`/search?lib=${lib}&q=${encodeURIComponent('拷贝')}`)
      ok('GET /search 有命中且带 text', srch.status === 200 && srch.body.hits.length > 0 && srch.body.text.includes('拷贝'))

      const dg = await j(`/diag?lib=${lib}`)
      ok('GET /diag 报出错误', dg.status === 200 && Array.isArray(dg.body.errors) && dg.body.errors.length > 0)

      const src2 = await j(`/source?lib=${lib}&tid=${encodeURIComponent('fact:abi')}`)
      ok('GET /source 200 且带行号', src2.status === 200 && Array.isArray(src2.body.lines) && typeof src2.body.lines[0].number === 'number', String(src2.status))
      ok('/source 的 offset 从 1 起', src2.body.offset >= 1 && src2.body.totalLines >= 1)

      const bl = await j(`/backlinks?lib=${lib}&tid=${encodeURIComponent('fact:abi')}`)
      ok('GET /backlinks 200 且有行', bl.status === 200 && bl.body.backlinks.length > 0)

      const unknown = await j('/nope')
      ok('未知端点回 404', unknown.status === 404)

      const dry = await j(`/rename?lib=${lib}&target=${encodeURIComponent('doc:index')}&new_name=guide&dry_run=1`)
      ok('GET /rename (dry_run) 报出新旧 TID', dry.status === 200 && dry.body.dry_run === true && dry.body.new_tid === 'doc:guide', JSON.stringify(dry.body).slice(0, 120))
      ok('dry_run 不动文件', fs.existsSync(path.join(root, FIX, '.nodekb/doc/index.md')))

      // 面板没有会话上下文：Agent 调过工具后，面板应能跟着那个工作区走（放在最后做，会改变默认工作区）
      await byName.kb_read.execute({ target: 'fact:abi', mode: 'node' }, { workspace: path.join(root, FIX) })
      const libs2 = await j('/libs')
      ok(
        '无 ws 时回落到最近一次工具用过的工作区',
        libs2.body.libs.some((l) => path.normalize(l.path) === path.join(root, FIX)),
        JSON.stringify(libs2.body.libs).slice(0, 140),
      )
    } catch (e) {
      ok('HTTP 段跑完不抛错', false, e && e.message)
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

// ── 6. 改名与引用重写 ──────────────────────────────────────────────────────
section('改名与引用重写')
try {
  const { rewriteRefsInText, renameFileNode } = await import(url(path.join(root, 'lib/engine/rename.js')))
  const { parse_library } = await import(url(path.join(root, 'lib/engine/mdlib.js')))

  const sample = '见 [[doc:index]] 与 [[doc:index:3.1]] 与 [[doc:indexx]]\n```\n[[doc:index]]\n```\n收尾'
  const out = rewriteRefsInText(sample, 'doc:index', 'doc:guide')
  ok('整 TID 与子节点引用都搬走', out.count === 2, String(out.count))
  ok('搬后是 [[doc:guide]]', out.text.includes('[[doc:guide]]'))
  ok('子节点变 [[doc:guide:3.1]]', out.text.includes('[[doc:guide:3.1]]'))
  ok('前缀相同的别的 TID 不动', out.text.includes('[[doc:indexx]]'))
  ok('围栏内不重写', out.text.split('```')[1].includes('[[doc:index]]'))

  // 在夹具的副本上真改名（绝不碰仓库里的夹具）
  const tmp = path.join(root, '.tmp-rename')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  fs.cpSync(path.join(root, FIX), tmp, { recursive: true })
  try {
    const nodes = parse_library(path.join(tmp, '.nodekb'), [])
    const lib = { nodekb: path.join(tmp, '.nodekb'), nodes }
    const before = [...nodes.keys()]

    const rep = renameFileNode(lib, 'doc:index', 'guide')
    ok('改名回执给出新旧 TID', rep.tid === 'doc:index' && rep.new_tid === 'doc:guide', `${rep.tid}→${rep.new_tid}`)
    ok('文件真的搬了', fs.existsSync(path.join(tmp, '.nodekb/doc/guide.md')) && !fs.existsSync(path.join(tmp, '.nodekb/doc/index.md')))
    ok('重写了引用', rep.rewritten.length >= 1, JSON.stringify(rep.rewritten))
    const guideText = fs.readFileSync(path.join(tmp, '.nodekb/doc/guide.md'), 'utf8')
    ok('自引用 [[doc:index:3.1]] 变 [[doc:guide:3.1]]', guideText.includes('[[doc:guide:3.1]]') && !guideText.includes('[[doc:index'))

    const after = parse_library(path.join(tmp, '.nodekb'), [])
    ok('重解析后旧 TID 消失', !after.has('doc:index') && before.includes('doc:index'))
    ok('重解析后新 TID 在册', after.has('doc:guide'))
    ok('子节点 TID 跟着换根', [...after.keys()].some((t) => t.startsWith('doc:guide:')))

    // 干跑不落盘（用自引用的 doc:index，确保"会改哪些引用"非空）
    fs.cpSync(path.join(root, FIX), path.join(tmp, 'dry'), { recursive: true })
    const nodes2 = parse_library(path.join(tmp, 'dry/.nodekb'), [])
    const dry = renameFileNode({ nodekb: path.join(tmp, 'dry/.nodekb'), nodes: nodes2 }, 'doc:index', 'guide', { dryRun: true })
    ok(
      'dry_run 报出将改的文件但不落盘',
      dry.dry_run === true && dry.rewritten.length >= 1 && !dry.renamed && fs.existsSync(path.join(tmp, 'dry/.nodekb/doc/index.md')),
      JSON.stringify(dry).slice(0, 120),
    )

    // 目标已存在必须拒绝
    let existsErr = null
    try {
      renameFileNode({ nodekb: path.join(tmp, 'dry/.nodekb'), nodes: nodes2 }, 'doc:fact', 'index')
    } catch (e) {
      existsErr = e
    }
    ok('目标已存在时拒绝', existsErr !== null && /已存在/.test(existsErr.message), existsErr && existsErr.message)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
} catch (e) {
  ok('改名测试能跑通', false, e && e.message)
}

// ── 库发现：技能目录下钻 ────────────────────────────────────────────────────
section('库发现（工作区里找 .nodekb）')
{
  const { resolveLibrary, listLibraries, discoverLibraries } = await import(url(path.join(root, 'lib/engine/registry.js')))
  const tmp = path.join(root, '.tmp-discover')
  fs.rmSync(tmp, { recursive: true, force: true })
  try {
    const sk = path.join(tmp, '.dsh/skills/demo-skill/.nodekb')
    fs.cpSync(path.join(root, FIX, '.nodekb'), sk, { recursive: true })
    const pkgDir = path.join(tmp, 'packages/pkg-a/.nodekb')
    fs.cpSync(path.join(root, FIX, '.nodekb'), pkgDir, { recursive: true })

    const found = discoverLibraries(tmp)
    ok('发现技能自带库', found.some((r) => r.name === 'demo-skill'), found.map((r) => r.name).join(','))
    ok('发现单仓多包库', found.some((r) => r.name === 'packages/pkg-a'), found.map((r) => r.name).join(','))
    ok('发现结果带 nodekb 绝对路径', found.every((r) => path.isAbsolute(r.nodekb)))

    const rows = listLibraries({ workspace: tmp })
    ok('listLibraries 列出发现的库', rows.length >= 2, JSON.stringify(rows.map((r) => r.name)))

    let multiErr = null
    try {
      resolveLibrary({ workspace: tmp })
    } catch (e) {
      multiErr = e
    }
    ok('多个库且未指定时报错并给出候选', multiErr !== null && /demo-skill/.test(multiErr.message), multiErr && multiErr.message.slice(0, 60))

    const byName = resolveLibrary({ workspace: tmp, kb: 'demo-skill' })
    ok('按名字能选中发现的库', byName.nodekb === sk, byName.nodekb)

    // 工作区根有 .nodekb 时优先级最高
    fs.cpSync(path.join(root, FIX, '.nodekb'), path.join(tmp, '.nodekb'), { recursive: true })
    const rootLib = resolveLibrary({ workspace: tmp })
    ok('工作区根 .nodekb 优先于发现的库', rootLib.nodekb === path.join(tmp, '.nodekb'), rootLib.nodekb)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 9. 建库与写库（kb_init / kb_write）+ 提示词段落 ─────────────────────────
section('建库与写库')
{
  const { scaffold } = await import(url(path.join(root, 'lib/engine/scaffold.js')))
  const { writeInto, validateContent } = await import(url(path.join(root, 'lib/engine/write.js')))
  const { describePrompt = null } = {
    describePrompt: (() => {
      // 只取静态文本，避免依赖宿主服务
      const hostPrompt = fs.readFileSync(path.join(root, 'lib/host/prompt.js'), 'utf8')
      return hostPrompt
    })(),
  }
  ok('prompt.js 里有段落名常量', /PROMPT_SECTION_NAME = 'project-node-memory'/.test(describePrompt))
  ok('prompt.js 默认开启且可关', /enabled === false/.test(describePrompt))

  // 真注册一次：给桩 ctx 一个 systemPrompt.section，看它交上来的段落
  const mod = await import(url(path.join(root, 'lib/host/prompt.js')))
  let sec = null
  const d1 = mod.registerPrompt({ systemPrompt: { section: (s) => { sec = s; return () => {} } } }, {})
  ok('段落交给 systemPrompt.section', !!sec && sec.name === 'project-node-memory' && Number.isFinite(sec.order), sec && sec.name)
  ok('段落点名 kb_init 与 kb_write', !!sec && /kb_init/.test(sec.text) && /kb_write/.test(sec.text))
  ok('段落点名 kb_read mode=toc', !!sec && /mode=toc/.test(sec.text))
  ok('段落不超 1200 字（常驻 token 要克制）', !!sec && sec.text.length < 1200, sec && sec.text.length)
  ok('状态自证 registered', mod.promptState().registered === true && mod.promptState().reason === 'ok')
  d1()
  ok('dispose 后状态回落', mod.promptState().registered === false)
  mod.registerPrompt({}, {})
  ok('没有 systemPrompt 服务时不抛、记原因', mod.promptState().registered === false && /no-systemPrompt/.test(mod.promptState().reason), mod.promptState().reason)
  mod.registerPrompt({ systemPrompt: { section: () => { throw new Error('dup') } } }, {})
  ok('段落注册失败被吞下（不连累插件）', mod.promptState().registered === false && /error/.test(mod.promptState().reason))
  mod.registerPrompt({ systemPrompt: { section: () => () => {} } }, { prompt: { enabled: false } })
  ok('prompt.enabled=false 时不注册', mod.promptState().reason === 'disabled-by-config')

  // systemPrompt 是可选服务：必须走动态注入，服务晚到也能接上
  {
    let asked = null
    let sec2 = null
    const d = mod.registerPrompt(
      {
        inject: (deps, cb) => {
          asked = deps
          cb({ systemPrompt: { section: (s) => { sec2 = s; return () => {} } } })
          return { dispose() {} }
        },
      },
      {},
    )
    ok('用 ctx.inject(["systemPrompt"]) 动态注入', Array.isArray(asked) && asked[0] === 'systemPrompt', JSON.stringify(asked))
    ok('服务就绪后段落真的注册', mod.promptState().registered === true && !!sec2)
    d()
    ok('disposer 可回收', mod.promptState().registered === false)
  }
  {
    mod.registerPrompt({ inject: (_deps, cb) => { cb({}); return { dispose() {} } } }, {})
    ok('动态注入拿不到服务时记原因而不抛', mod.promptState().reason === 'no-systemPrompt-service')
  }

  // ---- 随包技能：注册在内存里，不往用户家目录写文件 ----
  {
    const skillMod = await import(url(path.join(root, 'lib/host/skill.js')))
    const shipped = skillMod.readBundledSkillText()
    ok('随包 SKILL.md 打进了包（skills/ 是 lib 的兄弟目录）', typeof shipped === 'string' && shipped.length > 500, shipped && shipped.length)
    const fm = skillMod.splitFrontMatter(shipped || '')
    ok('SKILL.md 有 front matter 且点名 name/description', fm.meta.name === 'project-node-memory-guide' && !!fm.meta.description)
    ok('front matter 被剥掉，正文里没有 --- 头', !/^---/.test(fm.body.trim()) && fm.body.trim().length > 400, fm.body.trim().slice(0, 20))
    ok('正文点名 TID 规则与 kb_write', /TID/.test(fm.body) && /kb_write/.test(fm.body))
    ok('splitFrontMatter 对无头文本原样返回', skillMod.splitFrontMatter('hello').body === 'hello')

    // 桩：skills.register 收下定义，返回 disposer
    let got = null
    let asked = null
    const d = skillMod.registerSkill(
      {
        inject: (deps, cb) => {
          asked = deps
          cb({ skills: { register: (s) => { got = s; return () => { got = null } } } })
          return { dispose() {} }
        },
      },
      {},
    )
    ok('用 ctx.inject(["skills"]) 动态注入（skills 是可选服务）', Array.isArray(asked) && asked[0] === 'skills', JSON.stringify(asked))
    ok('技能名是 kebab-case', !!got && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(got.name), got && got.name)
    ok('技能带非空 description 与正文', !!got && got.description.length > 10 && got.content.length > 400, got && got.content.length)
    ok('技能带 source（注册表加载时会校验）', !!got && got.source === 'project-node-memory')
    ok('技能可被模型与用户调用', !!got && got.invocation.modelInvocable === true && got.invocation.userInvocable === true)
    ok('状态自证 registered', skillMod.skillState().registered === true && skillMod.skillState().reason === 'ok')
    d()
    ok('disposer 撤掉注册', skillMod.skillState().registered === false && got === null)

    skillMod.registerSkill({}, {})
    ok('没有 skills 服务时不抛、记原因', /no-skills-service/.test(skillMod.skillState().reason), skillMod.skillState().reason)
    skillMod.registerSkill({ skills: { register: () => { throw new Error('dup') } } }, {})
    ok('技能注册失败被吞下（不连累插件）', /error/.test(skillMod.skillState().reason))
    skillMod.registerSkill({ skills: { register: () => () => {} } }, { skill: { enabled: false } })
    ok('skill.enabled=false 时不注册', skillMod.skillState().reason === 'disabled-by-config')
    ok('不往用户家目录写任何东西（本模块只读随包文件）', !/writeFile|mkdir/.test(fs.readFileSync(path.join(root, 'lib/host/skill.js'), 'utf8')))
  }

  const tmp = path.join(root, '.tmp-write')
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    // scaffold
    const first = scaffold(path.join(tmp, '.nodekb'))
    ok('kb_init 建出骨架', first.created.includes('README.md') && first.created.includes('index/entry.md'), first.created.join(','))
    ok('kb_init 建出四类目录', ['doc/00-overview.md', 'facts/README.md', 'lessons/README.md', 'todo/README.md'].every((f) => first.created.includes(f)))
    const second = scaffold(path.join(tmp, '.nodekb'))
    ok('kb_init 幂等（第二次不覆盖）', second.created.length === 0 && second.skipped.length > 0)

    // 用真实工具跑一遍（库定位走 lib 参数）
    const pkgDir = path.join(tmp, '.nodekb')
    const initTool = byName.kb_init
    const initRes = await initTool.execute({ dir: '.nodekb' }, { workspace: tmp })
    ok('kb_init 工具：在指定工作区建库', fs.existsSync(path.join(pkgDir, 'README.md')), initRes.text.slice(0, 60))

    // 写：append 新建文件
    const lib = { nodekb: pkgDir, nodes: new Map() }
    const w1 = writeInto(lib, { target: 'lessons/001-cp936.md', content: '# cp936 坑\n\nPowerShell 管道会把 UTF-8 读成 GBK。\n' })
    ok('kb_write 新建文件', fs.existsSync(path.join(pkgDir, 'lessons/001-cp936.md')) && w1.created === true, w1.rel)
    // 写：append 到已有
    const w2 = writeInto(lib, { target: 'lessons/001-cp936.md', content: '改源码只用 edit/write。\n' })
    const merged = fs.readFileSync(path.join(pkgDir, 'lessons/001-cp936.md'), 'utf8')
    ok('kb_write append 保留原文', merged.includes('cp936 坑') && merged.includes('edit/write'), merged.slice(0, 40))
    // create 冲突
    let dupErr = null
    try {
      writeInto(lib, { target: 'lessons/001-cp936.md', content: 'x', mode: 'create' })
    } catch (e) {
      dupErr = e
    }
    ok('create 遇到已存在会报错', dupErr !== null && /已存在/.test(dupErr.message), dupErr && dupErr.message)

    // 校验：<node> 必须独占一行
    let tagErr = null
    try {
      validateContent('正文 <node name="fact:x" type="fact"> 后面还有字', 'x.md')
    } catch (e) {
      tagErr = e
    }
    ok('非独占一行的 <node> 被拦下', tagErr !== null && /独占一行/.test(tagErr.message), tagErr && tagErr.message)
    // 校验：非法 TID
    let tidErr = null
    try {
      validateContent('<node name="fact:有 空格" type="fact">\n</node>', 'x.md')
    } catch (e) {
      tidErr = e
    }
    ok('非法 TID 被拦下', tidErr !== null, tidErr && tidErr.message)
    // 校验：围栏里的示例不算标签
    ok('围栏内的 <node> 示例不报错', validateContent('```\n<node name="x">\n```\n', 'x.md') === true)

    // 越界写
    let outErr = null
    try {
      writeInto({ nodekb: pkgDir, nodes: new Map() }, { target: '../../evil.md', content: 'x' })
    } catch (e) {
      outErr = e
    }
    ok('拒绝写库外路径', outErr !== null && /库外/.test(outErr.message), outErr && outErr.message)

    // 重新解析后，写进去的文件真的成了节点
    const { parse_library: parseLib2 } = await import(url(path.join(root, 'lib/engine/mdlib.js')))
    const nodes = parseLib2(pkgDir, [])
    ok('写入的文件进入库树', nodes.has('lessons:001-cp936'), [...nodes.keys()].join(',').slice(0, 120))

    // 写后自检：故意造一个悬空引用，kb_write 的回执里要看得见
    const wr = await byName.kb_write.execute(
      { target: 'lessons/002-dangling.md', content: '看到 [[doc:不存在的节点]] 时要报错。\n', lib: pkgDir },
      { workspace: tmp },
    )
    ok('kb_write 写后报出悬空引用', /error/.test(wr.text) && wr.errors > 0, wr.text.slice(0, 90))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
// 不用 process.exit()：Windows 上在 server.close() 的同时调它会触发 libuv 断言
process.exitCode = fail ? 1 : 0

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}
