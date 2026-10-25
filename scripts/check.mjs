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
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const url = (p) => pathToFileURL(p).href

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let pass = 0
let fail = 0
let gitSkipped = 0
/**
 * 跑一条 git 命令；受限沙箱里子进程会被拒（spawn EPERM），
 * 这时该组断言跳过并计数，不让整套自检因为环境而崩掉。
 */
function gitOut(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    gitSkipped += 1
    return null
  }
}
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

// BOM 会让宿主读 JSON 时直接报 Unexpected token —— 所有清单/JSON 必须是「无 BOM 的 UTF-8」
const jsonFiles = ['package.json', 'cordis.patch.yml']
for (const f of jsonFiles) {
  const buf = fs.readFileSync(path.join(root, f))
  ok(`${f} 没有 UTF-8 BOM`, buf[0] !== 0xef, `${f} 以 ${buf.slice(0, 3).toString('hex')} 开头`)
}

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
ok('注册 10 个工具', registered.length === 10, names.join(','))
for (const want of ['kb_list', 'kb_read', 'kb_search', 'kb_diag', 'kb_backlinks', 'kb_init', 'kb_register', 'kb_write', 'kb_rename', 'kb_vcs_status']) {
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
  ok('单个工具注册失败不带走其余的', solo.length === 9 && !solo.includes('kb_read'), solo.join(','))
  ok('失败清单可自证', JSON.stringify(toolsMod.toolState().failed) === '["kb_read"]' && toolsMod.toolState().registered === 9, JSON.stringify(toolsMod.toolState()))
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

const readToc = await byName.kb_read.execute({ kb: FIX, target: 'doc:index', mode: 'toc' }, {})
ok('kb_read toc 列出子节', readToc.text.includes('doc:index:'), readToc.text.slice(0, 120))
const readOne = await byName.kb_read.execute({ kb: FIX, target: 'fact:abi-trap', mode: 'node' }, {})
ok('kb_read node 读到正文', readOne.text.includes('拷贝'), readOne.text.slice(0, 80))
ok('kb_read node 回填了 tid/type', readOne.tid === 'fact:abi-trap' && readOne.type === 'fact', `${readOne.tid}/${readOne.type}`)
const readSub = await byName.kb_read.execute({ kb: FIX, target: 'doc', mode: 'subtree', maxlen: 0 }, {})
ok('kb_read subtree 展开引用', readSub.text.includes('## ') && readSub.chars > 40, String(readSub.chars))

const searched = await byName.kb_search.execute({ kb: FIX, query: '拷贝' }, {})
ok('kb_search 有命中', searched.total > 0 && searched.hits.length > 0, JSON.stringify(searched.total))
ok('kb_search 命中带稳定 tid', searched.hits.every((h) => typeof h.tid === 'string' && h.tid.length > 0))

const backl = await byName.kb_backlinks.execute({ kb: FIX, target: 'fact:abi' }, {})
ok('kb_backlinks 找到引用者', backl.count > 0, String(backl.count))
ok('kb_backlinks 认出 doc:index', backl.backlinks.some((b) => b.tid === 'doc:index'), JSON.stringify(backl.backlinks.map((b) => b.tid)))

// kb 单参数同时吃名字与路径（去冗：不再有 lib 参数）
{
  const byAbs = await byName.kb_read.execute({ kb: path.join(root, FIX), target: 'doc:index', mode: 'toc' }, {})
  ok('kb 接受绝对路径', byAbs.text.includes('doc:index:'), String(byAbs.chars))
  const byNodekb = await byName.kb_read.execute({ kb: path.join(root, FIX, '.nodekb'), target: 'doc:index', mode: 'node' }, {})
  ok('kb 接受 .nodekb 结尾的路径', byNodekb.tid === 'doc:index', byNodekb.tid)
  const byNameArg = (await import(url(path.join(root, 'lib/engine/registry.js')))).resolveLibrary({
    kb: 'workspace',
    workspace: path.join(root, FIX),
  })
  ok('kb 仍接受库名', byNameArg.name === 'workspace' && /\.nodekb$/.test(byNameArg.nodekb), byNameArg.nodekb)
  const schemas = JSON.stringify(registered.map((t) => t.parameters))
  ok('工具 schema 里没有 lib 参数', !/"lib"/.test(schemas))
  const allProps = registered.flatMap((t) => Object.keys(t.parameters.properties || {}))
  ok('定位参数只剩一个 kb', allProps.filter((p) => p === 'kb').length === 7 && !allProps.includes('lib'), JSON.stringify(allProps))
}

let diagThrew = null
try {
  await byName.kb_diag.execute({ kb: FIX }, {})
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
ok('diag 抓到位置型链接（1.1 起降为 warning）', report.warnings.some((w) => w.includes('位置型')), JSON.stringify(report.warnings))
ok('diag 报告定义数', typeof report.def_count === 'number', String(report.def_count))
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
ok('面板改名走同源 POST（不再用 GET 改盘）', /post\('\/rename'/.test(clientSrc) && !/get\('\/rename'/.test(clientSrc))
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
  // 原文/源码视图里的 [[tscl="x"]] 必须可点（曾经只有渲染视图能点，原文里是死文本）
  ok('原文/源码视图把宏点击接到 openDef', /onMacro:\s*openDef/.test(clientSrc) && /function openDef\(/.test(clientSrc))
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

      // /defs：面板在“原文/源码”里点 [[tscl="x"]] 时，要知道定义在哪个节点
      {
        const defLib = path.join(root, '.tmp-defs')
        const defKb = path.join(defLib, '.nodekb')
        fs.rmSync(defLib, { recursive: true, force: true })
        fs.mkdirSync(path.join(defKb, 'doc'), { recursive: true })
        fs.writeFileSync(path.join(defKb, 'README.md'), '# 库\n')
        fs.writeFileSync(path.join(defKb, 'doc/a.md'), '# A\n\n版本：<tscl id="fact:ver">v1.23.45</tscl>\n')
        // 引用者必须是另一个节点：定义所在节点自己不算「引用者」
        fs.writeFileSync(path.join(defKb, 'doc/b.md'), '# B\n\n别处 [[tscl="fact:ver"]]。\n')
        const dlib = encodeURIComponent(path.join('.tmp-defs', '.nodekb'))
        const d1 = await j(`/defs?lib=${dlib}&id=${encodeURIComponent('fact:ver')}`)
        ok('GET /defs 200 且给出定义所在节点', d1.status === 200 && d1.body.owner_tid === 'doc:a' && d1.body.body === 'v1.23.45', JSON.stringify(d1.body).slice(0, 140))
        ok('/defs 列出引用处并带自证文本', d1.body.refs.length === 1 && d1.body.refs[0].tid === 'doc:b' && /定义体/.test(d1.body.text), JSON.stringify(d1.body.refs))
        const d0 = await j(`/defs?lib=${dlib}`)
        ok('/defs 无 id 时列出全部定义', d0.status === 200 && d0.body.count === 1 && d0.body.defs[0].owner_tid === 'doc:a', JSON.stringify(d0.body).slice(0, 120))
        const dMiss = await j(`/defs?lib=${dlib}&id=${encodeURIComponent('fact:none')}`)
        ok('/defs 找不到定义回 404', dMiss.status === 404)
        fs.rmSync(defLib, { recursive: true, force: true })
      }

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

      const jpost = async (p, body, headers = {}) => {
        const r = await fetch(base + p, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })
        return { status: r.status, body: await r.json() }
      }

      const dry = await jpost(`/rename?lib=${lib}`, { target: 'doc:index', new_name: 'guide', dry_run: true })
      ok('POST /rename (dry_run) 报出新旧 TID', dry.status === 200 && dry.body.dry_run === true && dry.body.new_tid === 'doc:guide', JSON.stringify(dry.body).slice(0, 120))
      ok('dry_run 不动文件', fs.existsSync(path.join(root, FIX, '.nodekb/doc/index.md')))

      const viaGet = await j(`/rename?lib=${lib}&target=${encodeURIComponent('doc:index')}&new_name=guide2`)
      ok('GET /rename 被拒（写操作只收 POST）', viaGet.status === 405, String(viaGet.status))
      ok('GET /rename 没有真的改名', fs.existsSync(path.join(root, FIX, '.nodekb/doc/index.md')))

      const cross = await jpost(`/rename?lib=${lib}`, { target: 'doc:index', new_name: 'guide9' }, { origin: 'http://evil.example' })
      ok('跨源 POST /rename 被拒（403）', cross.status === 403, `${cross.status} ${JSON.stringify(cross.body).slice(0, 80)}`)

      // 面板显式给 ws 时必须被采纳（曾因 env/缓存优先级 bug 被忽略，导致库下拉永远是别的项目）
      const wsDir = path.join(root, '.tmp-ws')
      fs.rmSync(wsDir, { recursive: true, force: true })
      fs.mkdirSync(path.join(wsDir, '.dsh/skills/scoped-skill'), { recursive: true })
      fs.cpSync(path.join(root, FIX, '.nodekb'), path.join(wsDir, '.dsh/skills/scoped-skill/.nodekb'), { recursive: true })
      const where1 = await j('/where?ws=' + encodeURIComponent(wsDir))
      ok('where 报告 ws 生效', path.normalize(where1.body.resolved) === path.normalize(wsDir), JSON.stringify(where1.body))
      const scoped1 = await j('/libs?scope=workspace&ws=' + encodeURIComponent(wsDir))
      ok('scope=workspace 只回该工作区的库', scoped1.body.libs.length === 1 && scoped1.body.libs[0].name === 'scoped-skill', JSON.stringify(scoped1.body.libs))
      ok('libs 回显解析到的工作区', path.normalize(scoped1.body.workspace) === path.normalize(wsDir), scoped1.body.workspace)
      fs.rmSync(wsDir, { recursive: true, force: true })

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
  const { openLibrary } = await import(url(path.join(root, 'lib/host/runtime.js')))
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

    // ── P12/P13/P15 回归 ──────────────────────────────────────────────────
    const quoted = '见 [[node="doc:index"]] 与 [[tscl="doc:index"]] 与 [[node="doc:indexx"]]'
    const q = rewriteRefsInText(quoted, 'doc:index', 'doc:guide')
    ok('带引号的 [[node="…"]] 也重写', q.text.includes('[[node="doc:guide"]]'), q.text)
    ok('带引号的 [[tscl="…"]] 也重写', q.text.includes('[[tscl="doc:guide"]]'), q.text)
    ok('带引号且前缀相同的不动', q.text.includes('[[node="doc:indexx"]]'))

    // parent= 也是 TID 引用：漏改 = 改名就把库改坏（子节点变孤儿，diag exit 2）
    const parenting = '<node name="nested" parent="doc:index">\n正文\n</node>'
    const pq = rewriteRefsInText(parenting, 'doc:index', 'doc:guide')
    ok('parent= 属性跟着改名', pq.text.includes('parent="doc:guide"') && !pq.text.includes('parent="doc:index"'), pq.text)

    // 端到端：带 parent= 的嵌套节点，改名后 diag 不该报孤儿
    fs.cpSync(path.join(root, FIX), path.join(tmp, 'par'), { recursive: true })
    const parKb = path.join(tmp, 'par/.nodekb')
    fs.appendFileSync(path.join(parKb, 'doc/index.md'), '\n<node name="nested" parent="doc:index">\n正文\n</node>\n', 'utf8')
    const parNodes = parse_library(parKb, [])
    ok('嵌套节点改名前父指向 doc:index', parNodes.get('nested') && parNodes.get('nested').parent_tid === 'doc:index', String(parNodes.get('nested') && parNodes.get('nested').parent_tid))
    const { diag: diagFn } = await import(url(path.join(root, 'lib/engine/diag.js')))
    renameFileNode({ nodekb: parKb, nodes: parNodes }, 'doc:index', 'guide5')
    const parAfter = parse_library(parKb, [])
    ok('改名后嵌套节点的 parent 跟着搬', parAfter.get('nested') && parAfter.get('nested').parent_tid === 'doc:guide5', String(parAfter.get('nested') && parAfter.get('nested').parent_tid))
    const parDiag = diagFn(parAfter, { libRoot: parKb })
    ok('改名后 diag 不报孤儿节点', !parDiag.report.errors.some((e) => /孤儿节点/.test(e)), JSON.stringify(parDiag.report.errors.slice(0, 3)))

    fs.cpSync(path.join(root, FIX), path.join(tmp, 'rel'), { recursive: true })
    const relNodes = parse_library(path.join(tmp, 'rel/.nodekb'), [])
    const rel = renameFileNode({ nodekb: path.join(tmp, 'rel/.nodekb'), nodes: relNodes }, 'doc/index.md', 'guide4')
    ok('rename 认相对路径', rel.new_tid === 'doc:guide4', String(rel.new_tid))

    // 缓存签名必须含文件名：改名不改 mtime/size，不重扫就会一直用旧索引
    fs.cpSync(path.join(root, FIX), path.join(tmp, 'live'), { recursive: true })
    const liveKb = path.join(tmp, 'live/.nodekb')
    const firstLib = openLibrary({}, { workspace: tmp }, { lib: liveKb })
    ok('openLibrary 首次读到 doc:index', firstLib.nodes.has('doc:index'))
    renameFileNode({ nodekb: liveKb, nodes: firstLib.nodes }, 'doc:index', 'guide3')
    const secondLib = openLibrary({}, { workspace: tmp }, { lib: liveKb })
    ok('改名后下一次调用看到新 TID', secondLib.nodes.has('doc:guide3') && !secondLib.nodes.has('doc:index'), [...secondLib.nodes.keys()].slice(0, 4).join(','))

    const { resolve_path } = await import(url(path.join(root, 'lib/engine/render.js')))
    const { ROOT_TID } = await import(url(path.join(root, 'lib/engine/mdlib.js')))
    ok('target="." 等于库根', resolve_path(secondLib.nodes, '.') === ROOT_TID)

    const { collectDefs, refsToDef, formatDefRead } = await import(url(path.join(root, 'lib/engine/defs.js')))
    const fakeNodes = new Map([
      ['doc:x', { tid: 'doc:x', title: 'x', content: '句子 <tscl id="v">1.2</tscl> 与 [[tscl="v"]]', source: 'doc/x.md#L1-L9' }],
    ])
    const fdefs = collectDefs(fakeNodes).defs
    const selfOnly = refsToDef(fakeNodes, 'v', fdefs.get('v').ownerTid)
    ok('定义所在节点自己引用：记下来但标 self', selfOnly.length === 1 && selfOnly[0].self === true)
    const selfText = formatDefRead(fdefs.get('v'), selfOnly)
    ok('self 引用不计入引用数', /尚未被任何/.test(selfText) && /自己也引用了 1 次/.test(selfText), selfText.split('\n').slice(-1)[0])
    const withRef = formatDefRead(fdefs.get('v'), [{ tid: 'doc:y', title: 'y', source: 'doc/y.md#L4-L9', line: 2 }])
    ok('引用行号只拼一次', /doc\/y\.md#L2/.test(withRef) && !/#L9#L/.test(withRef), withRef.split('\n').slice(-1)[0])
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

    // scope=workspace：注册表里「路径不在本工作区内」的库不得混进来
    const insideDir = path.join(tmp, 'a', 'b', 'c')
    fs.mkdirSync(insideDir, { recursive: true })
    fs.cpSync(path.join(root, FIX, '.nodekb'), path.join(insideDir, '.nodekb'), { recursive: true })
    const regFile = path.join(tmp, 'kb_registry.json')
    fs.writeFileSync(regFile, JSON.stringify({
      libraries: {
        outside: { path: path.join(root, FIX) },
        inside: { path: insideDir },
        ghost: { path: path.join(tmp, 'no-such-dir') },
      },
    }), 'utf8')
    const all = listLibraries({ workspace: tmp })
    const scoped = listLibraries({ workspace: tmp, scope: 'workspace' })
    ok('默认结果含工作区外注册项', all.some((r) => r.name === 'outside'), all.map((r) => r.name).join(','))
    ok('scope=workspace 剔除工作区外注册项', !scoped.some((r) => r.name === 'outside'), scoped.map((r) => r.name).join(','))
    ok('scope=workspace 保留工作区内注册项', scoped.some((r) => r.name === 'inside'), scoped.map((r) => r.name).join(','))
    ok('失效注册项 exists=false（面板据此隐藏）', all.some((r) => r.name === 'ghost' && r.exists === false), JSON.stringify(all.find((r) => r.name === 'ghost')))

    // 忽略名单：临时/探针目录里的 .nodekb 默认不算库，可用 exclude 反向放行
    const { isExcluded, DEFAULT_EXCLUDE } = await import(url(path.join(root, 'lib/engine/registry.js')))
    fs.mkdirSync(path.join(tmp, 'tmp_tex/probe-a'), { recursive: true })
    fs.cpSync(path.join(root, FIX, '.nodekb'), path.join(tmp, 'tmp_tex/probe-a/.nodekb'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'src/kb_probe'), { recursive: true })
    fs.cpSync(path.join(root, FIX, '.nodekb'), path.join(tmp, 'src/kb_probe/.nodekb'), { recursive: true })
    const withJunk = discoverLibraries(tmp)
    ok('默认忽略 tmp_* 目录', !withJunk.some((r) => r.nodekb.includes('tmp_tex')), withJunk.map((r) => r.name).join(','))
    ok('默认忽略 *_probe 目录', !withJunk.some((r) => r.nodekb.includes('kb_probe')), withJunk.map((r) => r.name).join(','))
    const forced = discoverLibraries(tmp, { exclude: ['!tmp_tex', '!kb_probe'] })
    ok('!pattern 可重新放行', forced.some((r) => r.nodekb.includes('tmp_tex')) && forced.some((r) => r.nodekb.includes('kb_probe')), forced.map((r) => r.name).join(','))
    ok('isExcluded 认默认名单', isExcluded('tmp_tex') && isExcluded('kb_probe') && isExcluded('nodekb_lab'))
    ok('isExcluded 不误伤普通名', !isExcluded('src') && !isExcluded('about-film-measure-project'))
    ok('exclude 配置可加目录', isExcluded('scratch', { exclude: ['scratch'] }))
    ok('DEFAULT_EXCLUDE 是数组', Array.isArray(DEFAULT_EXCLUDE) && DEFAULT_EXCLUDE.length > 3)

    // hidden:true —— 只保留「按名字解析」的别名，不进任何列表
    fs.writeFileSync(regFile, JSON.stringify({
      libraries: {
        outside: { path: path.join(root, FIX) },
        inside: { path: insideDir },
        alias: { path: insideDir, hidden: true },
      },
    }), 'utf8')
    const listed = listLibraries({ workspace: tmp })
    ok('hidden 注册项不进列表', !listed.some((r) => r.name === 'alias'), listed.map((r) => r.name).join(','))
    const withHidden = listLibraries({ workspace: tmp, includeHidden: true })
    ok('includeHidden 才列出 hidden 项', withHidden.some((r) => r.name === 'alias'), withHidden.map((r) => r.name).join(','))
    const aliasHit = resolveLibrary({ workspace: tmp, kb: 'alias' })
    ok('hidden 项仍可按名字解析', aliasHit && aliasHit.name === 'alias' && aliasHit.nodekb.endsWith('.nodekb'), JSON.stringify(aliasHit && aliasHit.name))

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
    ok('kb_init 建出四类目录', ['doc/00-overview.md', 'lessons/README.md', 'todo/README.md', 'index/entry.md'].every((f) => first.created.includes(f)))
    ok('kb_init 不再预建 facts/', !first.created.some((f) => f.startsWith('facts/')) && !fs.existsSync(path.join(tmp, '.nodekb', 'facts')))
    ok('骨架里写明了「目录与类型可自行增删」', fs.readFileSync(path.join(tmp, '.nodekb', 'README.md'), 'utf8').includes('自行增删') || fs.readFileSync(path.join(tmp, '.nodekb', 'README.md'), 'utf8').includes('自己加'))
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
      { target: 'lessons/002-dangling.md', content: '看到 [[doc:不存在的节点]] 时要报错。\n', kb: pkgDir },
      { workspace: tmp },
    )
    ok('kb_write 写后报出悬空引用', /error/.test(wr.text) && wr.errors > 0, wr.text.slice(0, 90))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 10. tscl 定义与双语法（1.1） ───────────────────────────────────────────
section('tscl 定义与双语法')
{
  const { parse_library } = await import(url(path.join(root, 'lib/engine/mdlib.js')))
  const { collectDefs } = await import(url(path.join(root, 'lib/engine/defs.js')))
  const { render_node, render_subtree } = await import(url(path.join(root, 'lib/engine/render.js')))
  const { diag } = await import(url(path.join(root, 'lib/engine/diag.js')))

  const tmp = path.join(root, '.tmp-tscl')
  const kb = path.join(tmp, '.nodekb')
  fs.rmSync(tmp, { recursive: true, force: true })
  const w = (rel, s) => {
    const p = path.join(kb, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, s, 'utf8')
  }
  w('README.md', '# 库\n')
  w(
    'doc/abi.md',
    [
      '# ABI 说明',
      '',
      '<tscl id="fact:abi">',
      '三条硬规则：1) 只用 C ABI；2) 名字加前缀 `fm_`；3) 导出结构体必须定长。',
      '## 这一行在 tscl 里，不该成为节点',
      '</tscl>',
      '',
      '结构：[[node="doc:other:1"]]；值：[[tscl="fact:abi"]]；旧语法：[[doc:other]]。',
      '',
      '<tscl id="fact:one-line">单行定义</tscl>',
      '',
      '单行用 [[tscl="fact:one-line"]] 引用。',
      '',
      '当前版本号为：<tscl id="fact:ver">v1.23.45</tscl>，向下兼容 v1.22。',
      '',
      '另一处引用版本：[[tscl="fact:ver"]]。',
      '',
      '<tscl id="fact:orphan">没人引用我</tscl>',
      '',
      '## 1 引用处',
      '',
      '正文。',
      '',
    ].join('\n'),
  )
  w('doc/other.md', '# 其它\n\n## 1 小节\n\n另一篇的正文，不该被复制过来。\n\n单行宏的别处引用：[[tscl="fact:one-line"]]。\n')

  const problems = []
  const nodes = parse_library(kb, problems)
  const { defs } = collectDefs(nodes)
  ok('收集到多行/单行/未引用定义', defs.has('fact:abi') && defs.has('fact:one-line') && defs.has('fact:orphan'))
  ok('单行定义正文正确', defs.get('fact:one-line').body === '单行定义', JSON.stringify(defs.get('fact:one-line').body))
  ok('tscl 内的 ## 不切节点', ![...nodes.keys()].some((t) => /tscl/.test(nodes.get(t).title)), [...nodes.keys()].join(','))

  const ctx = { defs, libRoot: kb }
  const rn = render_node(nodes, 'doc:abi', ctx)
  ok('tscl 标签不出现在渲染结果里', !rn.includes('<tscl'), rn.slice(0, 60))
  ok('值嵌入替换成定义体', rn.includes('三条硬规则') && !rn.includes('[[tscl='))
  ok('单行宏也能嵌入', rn.includes('单行定义') && !rn.includes('[[tscl="fact:one-line"]]'))
  ok('句内定义被收集', defs.get('fact:ver') && defs.get('fact:ver').body === 'v1.23.45', JSON.stringify(defs.get('fact:ver') && defs.get('fact:ver').body))
  ok('句内定义渲染时标签被剥掉、值就地留下', rn.includes('当前版本号为：v1.23.45，向下兼容 v1.22。'), rn.split('\n').find((l) => l.includes('当前版本号')) || '')
  ok('句内定义的别处引用被展开', rn.includes('另一处引用版本：v1.23.45。'), rn.split('\n').find((l) => l.includes('另一处引用')) || '')
  ok('node 引用渲染为链接（带行号）', /\[1 小节\]\(doc\/other\.md#L\d+\)/.test(rn), rn.split('\n').find((l) => l.includes('结构')) || '')
  ok('旧语法对节点也渲染成链接', /\[其它\]\(doc\/other\.md/.test(rn), rn.split('\n').find((l) => l.includes('结构')) || '')
  const sub = render_subtree(nodes, 'doc:abi', 1, ctx)
  ok('整支视图不再复制被引用节点的正文', !sub.includes('不该被复制过来'), sub.slice(0, 80))

  // 按定义 id 读（P1）：kb_read target=<tscl id>
  {
    const { cmdRead } = await import(url(path.join(root, 'lib/engine/commands.js')))
    const byDef = cmdRead(nodes, 'fact:one-line', { defs })
    ok('kb_read 可按定义 id 读', byDef.code === 0 && /定义体/.test(byDef.text) && byDef.text.includes('单行定义'), byDef.text.slice(0, 100))
    ok('按定义 id 读时列出被引用处', /被引用 1 处/.test(byDef.text), byDef.text.slice(-120))
    const notFound = cmdRead(nodes, 'fact:nope', { defs })
    ok('不存在的 id 仍报未找到', notFound.code === 2 && /未找到节点/.test(notFound.text), notFound.text.slice(0, 80))
  }

  // 正常库：定义被引用、无悬空 → 没有 error
  {
    const r = diag(nodes, { problems }).report
    ok('diag 报出「未被引用的定义」', r.warnings.some((w) => /未被引用的定义/.test(w) && /fact:orphan/.test(w)), r.warnings.join(' | ').slice(0, 160))
    ok('diag 报出旧语法 warning', r.warnings.some((w) => /旧语法/.test(w)))
    ok('diag 把位置型链接降级为 warning', r.warnings.some((w) => /位置型 TID 链接/.test(w)))
    ok('正常库没有 error', r.errors.length === 0, r.errors.join(' | ').slice(0, 120))
  }

  // 逐条构造错误：重复定义 / 与节点 TID 撞名 / 悬空 / 嵌套 / 表格内跨行宏
  {
    const tmp2 = path.join(root, '.tmp-tscl-bad')
    const kb2 = path.join(tmp2, '.nodekb')
    fs.rmSync(tmp2, { recursive: true, force: true })
    const w2 = (rel, s) => {
      const p = path.join(kb2, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, s, 'utf8')
    }
    w2('README.md', '# 库\n')
    w2('doc/a.md', '# A\n\n<tscl id="fact:dup">甲</tscl>\n\n<tscl id="doc:a">撞名</tscl>\n\n靠 [[tscl="fact:none"]] 引用。\n')
    w2('doc/b.md', '# B\n\n<tscl id="fact:dup">乙</tscl>\n\n<tscl id="fact:multi">\n第一行\n第二行\n</tscl>\n\n| 列 | 说明 |\n|---|---|\n| x | [[tscl="fact:multi"]] |\n')
    w2('doc/c.md', '# C\n\n<tscl id="fact:nested"><tscl id="fact:inner">内</tscl></tscl>\n')
    w2('doc/d.md', '# D\n\n| 列 | 说明 |\n|---|---|\n| x | <tscl id="fact:intable">甲</tscl> |\n')
    const p2 = []
    const n2 = parse_library(kb2, p2)
    const r2 = diag(n2, { problems: p2 }).report
    const all = r2.errors.join(' | ')
    ok('diag: 重复定义是 error', /重复定义/.test(all) && /fact:dup/.test(all), all.slice(0, 120))
    ok('diag: 定义与节点 TID 撞名是 error', /命名空间冲突/.test(all))
    ok('diag: 悬空 tscl 引用是 error', /悬空 tscl 引用/.test(all))
    ok('diag: 嵌套 <tscl> 是 error', /嵌套/.test(all))
    ok('diag: 表格里内联跨行宏是 warning', r2.warnings.some((w) => /表格单元格/.test(w)), r2.warnings.slice(0, 2).join(' | '))
    ok('diag: 定义写在表格行里是 warning', r2.warnings.some((w) => /定义写在表格行里/.test(w)), r2.warnings.slice(0, 3).join(' | '))
    fs.rmSync(tmp2, { recursive: true, force: true })
  }

  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── 11. 工作区解析与登记（1.4.0） ─────────────────────────────────────────
{
  section('工作区解析（1.4.0）')
  const wsRoot = path.join(root, '.tmp-ws')
  const otherWs = path.join(root, '.tmp-ws-other')
  fs.rmSync(wsRoot, { recursive: true, force: true })
  fs.rmSync(otherWs, { recursive: true, force: true })
  fs.mkdirSync(wsRoot, { recursive: true })
  fs.mkdirSync(path.join(otherWs, '.nodekb'), { recursive: true })
  fs.writeFileSync(path.join(otherWs, '.nodekb', 'README.md'), '# 别人的库\n', 'utf8')

  const reg = []
  const ctx2 = {
    tools: { register: (t) => { reg.push(t); return () => {} } },
    webServer: { register: () => () => {} },
    get: (name) => {
      if (name === 'sessions') return { get: (id) => (id === 's-1' ? { header: { cwd: wsRoot } } : null) }
      if (name === 'workspaceRegistry') return { list: () => [{ path: wsRoot }, { path: otherWs }] }
      return null
    },
  }
  host.apply(ctx2, {})
  const t2 = Object.fromEntries(reg.map((t) => [t.name, t]))
  ok('第二套 ctx 也注册 10 个工具', reg.length === 10, reg.map((t) => t.name).join(','))

  const listed = await t2.kb_list.execute({}, { agent: { id: 's-1' } })
  ok('工作区取自会话头 cwd', path.resolve(listed.workspace) === path.resolve(wsRoot), String(listed.workspace))
  ok('kb_list 报出工作区来源', listed.workspaceFrom === 'session.header.cwd', String(listed.workspaceFrom))
  ok('kb_list 列绝对路径', listed.libs.every((r) => path.isAbsolute(r.path)), JSON.stringify(listed.libs.slice(0, 2)))
  ok('kb_list 不含 lib 参数（单参数定位）', !t2.kb_list.parameters.properties || !t2.kb_list.parameters.properties.lib)

  // 跨工作区守卫：目标落在另一个已登记工作区里要拒绝，并报出双方路径
  let guardErr = ''
  try {
    await t2.kb_init.execute({ dir: path.join(otherWs, 'newkb') }, { agent: { id: 's-1' } })
  } catch (e) {
    guardErr = e.message
  }
  ok('kb_init 拒绝写进另一个已登记工作区', /另一个已登记的工作区/.test(guardErr), guardErr.slice(0, 100))
  ok('kb_init 报出双方路径与来源', guardErr.includes(otherWs) && guardErr.includes(wsRoot) && /来源:/.test(guardErr))

  // kb_register：写项目自己的 kb_registry.json
  const regRes = await t2.kb_register.execute({ dir: otherWs, name: 'other' }, { agent: { id: 's-1' } })
  const regFile = path.join(wsRoot, 'kb_registry.json')
  ok('kb_register 写项目注册表', fs.existsSync(regFile), regRes.file)
  const regJson = JSON.parse(fs.readFileSync(regFile, 'utf8'))
  ok('kb_register 登记项指向库目录', regJson.libraries.other.path === path.resolve(otherWs), JSON.stringify(regJson.libraries))
  ok('kb_register 回执给出文件名', /kb_registry\.json/.test(regRes.text), regRes.text.slice(0, 80))
  let noKbErr = ''
  try {
    await t2.kb_register.execute({ dir: path.join(wsRoot, 'nowhere') }, { agent: { id: 's-1' } })
  } catch (e) {
    noKbErr = e.message
  }
  ok('kb_register 拒绝没有 .nodekb 的目录', /没有 \.nodekb/.test(noKbErr), noKbErr.slice(0, 80))

  // 登记后必须立刻生效（不能只在启动时读一次注册表）
  const afterReg = await t2.kb_list.execute({}, { agent: { id: 's-1' } })
  ok('kb_register 后立刻出现在 kb_list', afterReg.libs.some((r) => r.name === 'other'), JSON.stringify(afterReg.libs.map((r) => r.name)))
  const readOther = await t2.kb_read.execute({ kb: 'other' }, { agent: { id: 's-1' } })
  ok('kb_register 后立刻能按名字读', /别人的库/.test(readOther.text), readOther.text.slice(0, 60))

  fs.rmSync(wsRoot, { recursive: true, force: true })
  fs.rmSync(otherWs, { recursive: true, force: true })
}

// ── 手写 <node> 的容错 + 代码区不解析引用 + 前缀匹配（1.4.2）──────────────
{
  section('手写 <node> 与代码区（1.4.2）')
  const { openLibrary } = await import(url(path.join(root, 'lib/host/runtime.js')))
  const tmp2 = path.join(root, '.tmp-node-syntax')
  fs.rmSync(tmp2, { recursive: true, force: true })
  const kb2 = path.join(tmp2, '.nodekb')
  fs.mkdirSync(path.join(kb2, 'doc'), { recursive: true })
  fs.writeFileSync(path.join(kb2, 'README.md'), '# 库\n', 'utf8')
  // tid= 是 name= 的别名（用户反馈里就是这么写的）
  fs.writeFileSync(path.join(kb2, 'doc/tid-attr.md'), '<node tid="doc:tid-attr:x1" type="fact" title="别名">\n正文\n</node>\n', 'utf8')
  // 缺 name 的 <node>：整段按正文处理，闭标签不许漏
  fs.writeFileSync(path.join(kb2, 'doc/nameless.md'), '# Nameless\n\n<node type="fact">\n没有名字\n</node>\n\n## 1 小节\n\n正文\n', 'utf8')
  // 代码区里的引用与定义都是示例
  fs.writeFileSync(
    path.join(kb2, 'doc/code.md'),
    '# Code\n\n```md\n[[node="doc:missing-fenced"]]\n<tscl id="dup:in-fence">示例</tscl>\n```\n\n行内 `[[node="doc:missing-inline"]]` 也只是示例。\n',
    'utf8',
  )
  // 前缀匹配：文件名带后缀 + 文件内有子节
  fs.writeFileSync(path.join(kb2, 'doc/02-运行环境.md'), '# 运行环境\n\n## 2.1 版本\n\n正文\n', 'utf8')

  const lib2 = openLibrary({}, { workspace: tmp2 }, { lib: kb2 })
  ok('tid= 属性也能建显式节点', lib2.nodes.has('doc:tid-attr:x1'))
  ok('title= 属性生效', lib2.nodes.get('doc:tid-attr:x1').title === '别名', lib2.nodes.get('doc:tid-attr:x1').title)
  const nameless = lib2.nodes.get('doc:nameless')
  ok('缺 name 的 <node> 行按正文保留', String(nameless.content).includes('<node type="fact">'), nameless.content.slice(0, 40))
  ok('闭标签不漏进正文', !String(nameless.content).includes('</node>'), nameless.content.slice(0, 60))
  ok('缺 name 记成解析期 warning', lib2.problems.some((p) => /显式节点缺/.test(p)), JSON.stringify(lib2.problems))

  const { diag: diag2 } = await import(url(path.join(root, 'lib/engine/diag.js')))
  const d2 = diag2(lib2.nodes, { problems: lib2.problems, defs: lib2.defs })
  ok('代码区里的悬空引用不报错', d2.report.errors.length === 0, JSON.stringify(d2.report.errors))
  ok('代码区里的定义不算定义', !lib2.defs.has('dup:in-fence'), [...lib2.defs.keys()].join(','))
  ok('缺 name 是 warning 不是 error', d2.report.warnings.some((w) => /显式节点缺/.test(w)), JSON.stringify(d2.report.warnings))

  const { resolve_path: rp2 } = await import(url(path.join(root, 'lib/engine/render.js')))
  ok('前缀匹配到文件节点（有子节也认）', rp2(lib2.nodes, 'doc:02') === 'doc:02-运行环境', String(rp2(lib2.nodes, 'doc:02')))
  ok('前缀匹配到节', rp2(lib2.nodes, 'doc:02-运行环境:2') === 'doc:02-运行环境:2.1', String(rp2(lib2.nodes, 'doc:02-运行环境:2')))
  fs.rmSync(tmp2, { recursive: true, force: true })
}

// ── 定义行号与自引用（1.4.2）────────────────────────────────────────────
{
  section('tscl 引用归因（1.4.2）')
  const { openLibrary } = await import(url(path.join(root, 'lib/host/runtime.js')))
  const tmp3 = path.join(root, '.tmp-def-line')
  fs.rmSync(tmp3, { recursive: true, force: true })
  const kb3 = path.join(tmp3, '.nodekb')
  fs.mkdirSync(path.join(kb3, 'doc'), { recursive: true })
  fs.writeFileSync(path.join(kb3, 'README.md'), '# 库\n', 'utf8')
  fs.writeFileSync(
    path.join(kb3, 'doc/02-env.md'),
    '# 环境\n\n## 2.1 版本\n\n当前 <tscl id="fact:ver">1.2.3</tscl> 与 [[tscl="fact:ver"]]\n',
    'utf8',
  )
  fs.writeFileSync(path.join(kb3, 'doc/03-use.md'), '# 使用\n\n引用：[[tscl="fact:ver"]]\n', 'utf8')
  const lib3 = openLibrary({}, { workspace: tmp3 }, { lib: kb3 })
  const { refsToDef: r2 } = await import(url(path.join(root, 'lib/engine/defs.js')))
  const def3 = lib3.defs.get('fact:ver')
  const refs3 = r2(lib3.nodes, 'fact:ver', def3.ownerTid)
  const useRef = refs3.find((r) => r.tid === 'doc:03-use')
  ok('真实引用被找到', Boolean(useRef), JSON.stringify(refs3.map((r) => r.tid)))
  ok('行号是文件内绝对行号', useRef && useRef.line === 3, useRef && String(useRef.line))
  const owner = refs3.filter((r) => r.self)
  ok('定义所在节点标 self', owner.length === 1, JSON.stringify(refs3.map((r) => [r.tid, r.self])))
  fs.rmSync(tmp3, { recursive: true, force: true })
}

// ── mode=node 死锁 + kb_backlinks 认定义 id + 整支不重复打印值（1.4.4）──────
{
  section('mode=node 与 backlinks（1.4.4）')
  const { openLibrary } = await import(url(path.join(root, 'lib/host/runtime.js')))
  const { buildTools } = await import(url(path.join(root, 'lib/host/tools.js')))
  const tmp4 = path.join(root, '.tmp-node-write')
  fs.rmSync(tmp4, { recursive: true, force: true })
  const kb4 = path.join(tmp4, '.nodekb')
  fs.mkdirSync(path.join(kb4, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(kb4, 'README.md'), '# 库\n', 'utf8')
  const file4 = path.join(kb4, 'lessons/tmp-node-test.md')
  fs.writeFileSync(file4, '前言\n', 'utf8')

  const ctx4 = {
    tools: { register: (t) => { tools4[t.name] = t; return () => {} } },
    webServer: { register: () => () => {} },
    get: (n) => (n === 'sessions' ? { get: (id) => (id === 's-4' ? { header: { cwd: tmp4 } } : null) } : null),
  }
  const tools4 = {}
  buildTools(ctx4, {})
  const ex = { agent: { id: 's-4' } }

  // 多行 <node>：开标签/正文/闭标签各占一行 —— 旧实现死锁的形状
  await tools4.kb_write.execute(
    { target: 'lessons/tmp-node-test.md', mode: 'append', content: '<node name="tmp:x1" type="tmp">\n第一版\n</node>\n' },
    ex,
  )
  const before = openLibrary(ctx4, ex, {})
  ok('多行 <node> 被注册', before.nodes.has('tmp:x1'), [...before.nodes.keys()].join(','))

  const w = await tools4.kb_write.execute({ target: 'tmp:x1', mode: 'node', content: '第二版内容' }, ex)
  const after = fs.readFileSync(file4, 'utf8')
  ok('mode=node 能改写多行 <node>', /第二版内容/.test(after) && !/第一版/.test(after), after.replace(/\n/g, '\\n').slice(0, 80))
  ok('<node> 标签未被破坏', after.includes('<node name="tmp:x1"') && after.includes('</node>'))
  ok('改写回执不报错', !/无法定位|\u9519/.test(String(w.text || '')), String(w.text).slice(0, 60))

  // 单行 <node …>正文</node> 也能就地改
  fs.writeFileSync(path.join(kb4, 'lessons/one-line.md'), '<node name="tmp:one" type="tmp">旧值</node>\n', 'utf8')
  await tools4.kb_write.execute({ target: 'tmp:one', mode: 'node', content: '新值' }, ex)
  const oneLine = fs.readFileSync(path.join(kb4, 'lessons/one-line.md'), 'utf8')
  ok('mode=node 也能改单行 <node>', /新值/.test(oneLine) && !/旧值/.test(oneLine), oneLine.trim())

  // kb_backlinks 认 <tscl> 定义 id（与 kb_read 同口径）
  fs.writeFileSync(path.join(kb4, 'lessons/defs.md'), '# Defs\n\n句内 <tscl id="fact:pv">1.2.3</tscl> 与 [[tscl="fact:pv"]]\n', 'utf8')
  fs.writeFileSync(path.join(kb4, 'lessons/use.md'), '# Use\n\n见 [[tscl="fact:pv"]]\n', 'utf8')
  const bl = await tools4.kb_backlinks.execute({ target: 'fact:pv' }, ex)
  ok('kb_backlinks 认定义 id', /引用定义/.test(String(bl.text)) && bl.count === 1, String(bl.text).slice(0, 120))
  ok('kb_backlinks 认出真正的引用节点', String(bl.text).includes('lessons:use'), String(bl.text))

  // 整支渲染：定义与引用都在同一支时值只出现一次
  const { render_subtree } = await import(url(path.join(root, 'lib/engine/render.js')))
  const lib5 = openLibrary(ctx4, ex, {})
  const full = render_subtree(lib5.nodes, 'lessons:defs', 1, { defs: lib5.defs, libRoot: lib5.nodekb })
  const hits = (full.match(/1\.2\.3/g) || []).length
  ok('整支里同一个值只出现一次', hits === 1, `出现 ${hits} 次: ${full.replace(/\n/g, ' ').slice(0, 120)}`)
  ok('单看定义所在节点仍能看到值', /1\.2\.3/.test(full))

  // ── 1.4.5：段节点可写 + 写入后自动快照 ──────────────────────────────────
  fs.writeFileSync(path.join(kb4, 'lessons/sec.md'), '# Sec\n\n## 1 版本\n\n旧正文\n\n## 2 其它\n\n无关内容\n', 'utf8')
  const secFile = (n, name) => n.kind === 'section' && String(n.source).split('#')[0].split(/[\\/]/).pop() === name
  const lib6 = openLibrary(ctx4, ex, {})
  const sec = [...lib6.nodes.values()].find((n) => secFile(n, 'sec.md'))
  ok('段节点在册', Boolean(sec), sec && sec.tid)
  const sw = await tools4.kb_write.execute({ target: sec.tid, mode: 'node', content: '新正文二' }, ex)
  const secText = fs.readFileSync(path.join(kb4, 'lessons/sec.md'), 'utf8')
  ok('mode=node 能改 ## 段正文', /新正文二/.test(secText) && !/旧正文/.test(secText), secText.replace(/\n/g, '\\n'))
  ok('段的标题与相邻段没被碰', secText.includes('## 1 版本') && secText.includes('## 2 其它') && /无关内容/.test(secText), secText.replace(/\n/g, '\\n'))
  ok('段写入回执正常', /已写入/.test(String(sw.text)), String(sw.text).slice(0, 80))
  ok('段写入回执用相对路径', sw.path === 'lessons/sec.md', String(sw.path))

  // 1.5.3：围栏感知 —— 代码块里的 `# 注释` 不能当成段边界（否则会把围栏切坏）
  fs.writeFileSync(
    path.join(kb4, 'lessons/fence.md'),
    '# F\n\n## 1 带围栏\n\n正文 A\n\n```bash\n# 注释行\necho hi\n```\n\n尾注\n\n## 2 其它\n\n无关\n',
    'utf8',
  )
  const libF = openLibrary(ctx4, ex, {})
  const secF = [...libF.nodes.values()].find((n) => secFile(n, 'fence.md'))
  await tools4.kb_write.execute({ target: secF.tid, mode: 'node', content: '换过的正文' }, ex)
  const fenceText = fs.readFileSync(path.join(kb4, 'lessons/fence.md'), 'utf8')
  ok(
    '围栏里的 # 不被当成段边界',
    fenceText.includes('## 2 其它') && fenceText.includes('无关') && !fenceText.includes('echo hi') && !fenceText.includes('注释行'),
    fenceText.replace(/\n/g, '\\n'),
  )
  ok('没被切出孤立围栏', (fenceText.match(/```/g) || []).length % 2 === 0, fenceText.replace(/\n/g, '\\n'))

  // 段里围栏内的 <node> 是示例，不该触发「拒绝整段替换」
  fs.writeFileSync(
    path.join(kb4, 'lessons/fence2.md'),
    '# F2\n\n## 1 用法\n\n示例：\n\n```md\n<node name="demo" type="demo">\n示例正文\n</node>\n```\n\n真内容\n\n## 2 其它\n\n无关\n',
    'utf8',
  )
  const libF2 = openLibrary(ctx4, ex, {})
  const secF2 = [...libF2.nodes.values()].find((n) => secFile(n, 'fence2.md'))
  let fenceErr = null
  let fenceW = null
  try {
    fenceW = await tools4.kb_write.execute({ target: secF2.tid, mode: 'node', content: '改过的正文' }, ex)
  } catch (e) {
    fenceErr = e
  }
  ok(
    '围栏里的 <node> 示例不拦截段写入',
    fenceErr === null && fenceW && /已写入/.test(String(fenceW.text)),
    fenceErr ? fenceErr.message.slice(0, 90) : String(fenceW && fenceW.text).slice(0, 60),
  )
  const f2 = fs.readFileSync(path.join(kb4, 'lessons/fence2.md'), 'utf8')
  ok('段写入后相邻段还在、旧正文已换', f2.includes('## 2 其它') && f2.includes('改过的正文') && !f2.includes('真内容'), f2.replace(/\n/g, '\\n'))

  // CRLF 文件：写入后不得混进 LF
  fs.writeFileSync(path.join(kb4, 'lessons/crlf.md'), '# C\r\n\r\n## 1 段\r\n\r\n旧\r\n\r\n## 2 段\r\n\r\n无关\r\n', 'utf8')
  const libC = openLibrary(ctx4, ex, {})
  const secC = [...libC.nodes.values()].find((n) => secFile(n, 'crlf.md'))
  await tools4.kb_write.execute({ target: secC.tid, mode: 'node', content: '新的正文\n第二行' }, ex)
  const cText = fs.readFileSync(path.join(kb4, 'lessons/crlf.md'), 'utf8')
  ok('CRLF 文件写入后仍是纯 CRLF', !/(^|[^\r])\n/.test(cText), JSON.stringify(cText))

  // <node> 块的闭合扫描也要跳过围栏：正文里的示例 </node> 不是真闭合
  fs.writeFileSync(
    path.join(kb4, 'lessons/nodefence.md'),
    '# NF\n\n<node name="tmp:nf" type="tmp">\n正文\n\n```md\n</node>\n```\n\n尾\n</node>\n',
    'utf8',
  )
  const libN = openLibrary(ctx4, ex, {})
  ok('解析器跳过围栏里的 <node> 示例', libN.nodes.has('tmp:nf'), [...libN.nodes.keys()].join(','))
  await tools4.kb_write.execute({ target: 'tmp:nf', mode: 'node', content: '新正文' }, ex)
  const nf = fs.readFileSync(path.join(kb4, 'lessons/nodefence.md'), 'utf8')
  ok(
    '围栏里的 </node> 不再被当成闭合',
    (nf.match(/<\/node>/g) || []).length === 1 && !/尾/.test(nf) && /新正文/.test(nf),
    nf.replace(/\n/g, '\\n'),
  )

  // 段里有 <node>：拒绝整段替换，而不是静默删掉
  fs.writeFileSync(path.join(kb4, 'lessons/sec2.md'), '# Sec2\n\n## 1 含节点\n\n<node name="tmp:in" type="tmp">\n内\n</node>\n', 'utf8')
  const lib7 = openLibrary(ctx4, ex, {})
  const sec2 = [...lib7.nodes.values()].find((n) => secFile(n, 'sec2.md'))
  let guardErr = null
  try {
    await tools4.kb_write.execute({ target: sec2.tid, mode: 'node', content: '想覆盖' }, ex)
  } catch (e) {
    guardErr = e
  }
  ok('段内有 <node> 时拒绝整段替换', guardErr !== null && /拒绝/.test(guardErr.message), guardErr && guardErr.message.slice(0, 90))
  ok('拒绝文案里的逃生口是相对路径', guardErr !== null && /lessons\/sec2\.md/.test(guardErr.message) && !/[A-Za-z]:[\\/]/.test(guardErr.message), guardErr && guardErr.message.split('\n').slice(-1)[0])
  ok('拒绝后原文还在', /内/.test(fs.readFileSync(path.join(kb4, 'lessons/sec2.md'), 'utf8')) && lib7.nodes.has('tmp:in'))

  // 自动快照：git 初始化后写入 → autosnap 提交
  const { init: vcsInit, status: vcsStatus } = await import(url(path.join(root, 'lib/engine/vcs.js')))
  const gitMsg = vcsInit(kb4)
  ok('vcs.init 建出仓库', vcsStatus(kb4).repo === true, gitMsg)
  const w2 = await tools4.kb_write.execute({ target: 'lessons/snap.md', mode: 'create', content: '# Snap\n\n快照测试\n' }, ex)
  ok('写入后回了快照', /快照:/.test(String(w2.text)), String(w2.text).split('\n').slice(0, 3).join(' | '))
  const snapLog = gitOut(['-C', kb4, 'log', '--pretty=%s', '-n', '3'])
  if (snapLog !== null) ok('git log 里有 autosnap', /autosnap: \d+ 处变更/.test(snapLog), snapLog.replace(/\n/g, ' | '))
  ok('工作树干净（已全部提交）', vcsStatus(kb4).dirty === false, JSON.stringify(vcsStatus(kb4)))

  fs.rmSync(tmp4, { recursive: true, force: true })
}

// ── 11. advice 三档与更新提醒 ──────────────────────────────────────────────
{
  const { computeAdvice } = await import(url(path.join(root, 'lib/engine/advice.js')))
  const { markSeen, updateNotice } = await import(url(path.join(root, 'lib/host/tools.js')))
  const { diag } = await import(url(path.join(root, 'lib/engine/diag.js')))
  const { openLibrary, bindServices } = await import(url(path.join(root, 'lib/host/runtime.js')))

  const tmpA = path.join(root, '.tmp-advice')
  fs.rmSync(tmpA, { recursive: true, force: true })
  const kbA = path.join(tmpA, '.nodekb')
  fs.mkdirSync(path.join(kbA, 'doc'), { recursive: true })
  // 10 个碎片文件 + 同一句重复
  for (let i = 1; i <= 11; i++) {
    fs.writeFileSync(path.join(kbA, `doc/frag-${i}.md`), `# 碎片 ${i}\n\n这条阈值统一取 0.85，不要改。\n`, 'utf8')
  }
  const ctxA = { tools: { register: () => () => {} }, webServer: { register: () => () => {} }, get: (n) => (n === 'sessions' ? { get: (id) => (id === 's-a' ? { header: { cwd: tmpA } } : null) } : null) }
  bindServices(ctxA)
  // 先建仓库再让状态文件出现：真实顺序就是「建库 → 诊断时才写状态文件」
  const { init: advInit, status: advStatus } = await import(url(path.join(root, 'lib/engine/vcs.js')))
  advInit(kbA)
  const libA = openLibrary(ctxA, { agent: { id: 's-a' } }, {})
  const adv = computeAdvice(libA.nodes, libA.defs, libA.nodekb)
  ok('advice：碎片文件被建议合并', adv.some((a) => a.code === 'merge-fragments'))
  ok('advice：重复字面值被建议提取 tscl', adv.some((a) => a.code === 'extract-tscl'))
  ok('advice：缺入口被建议补', adv.some((a) => a.code === 'missing-entry'))
  ok('advice 每条都带 fix', adv.every((a) => typeof a.fix === 'string' && a.fix.length > 10))
  const dr = diag(libA.nodes, { libRoot: libA.nodekb, defs: libA.defs, advice: adv })
  ok('diag 报出 advice 数组', Array.isArray(dr.report.advice) && dr.report.advice.length === adv.length)
  ok('advice 不影响退出码', dr.code === 0, `code=${dr.code}`)

  // 更新提醒：状态文件不存在（1.5.0 之前建的库）→ 提醒一次；写了旧版本 → 提醒一次
  const n0 = updateNotice(kbA)
  ok('无状态文件（旧库）也提醒一次', n0 && n0.code === 'plugin-updated' && /1\.5\.0 之前/.test(n0.message), JSON.stringify(n0))
  markSeen(kbA)
  ok('markSeen 写出状态文件', fs.existsSync(path.join(kbA, '.plugin-state.json')))
  // 1.5.3：状态文件改走 .git/info/exclude —— 诊断不该改动工作树里的 .gitignore
  ok(
    'markSeen 不再往 .gitignore 里追加',
    !fs.existsSync(path.join(kbA, '.gitignore')) || !fs.readFileSync(path.join(kbA, '.gitignore'), 'utf8').includes('.plugin-state.json'),
  )
  ok('提醒后即视为已看', updateNotice(kbA) === null)

  // 有 git 时：状态文件被 exclude 掉，诊断前后工作树都干净
  ok('库初始化后是干净的', advStatus(kbA).dirty === false, JSON.stringify(advStatus(kbA)))
  fs.writeFileSync(path.join(kbA, '.plugin-state.json'), JSON.stringify({ seen_version: '0.0.0' }), 'utf8')
  updateNotice(kbA) // 触发 markSeen
  ok('markSeen 后工作树仍干净', advStatus(kbA).dirty === false, JSON.stringify(advStatus(kbA)))
  // 有 git 时才有 .git/info/exclude 这个文件；没有 git 时这组断言本身没有意义（不是失败）
  {
    const hasGit = gitOut(['-C', kbA, 'rev-parse', '--git-dir']) !== null
    const exPath = path.join(kbA, '.git/info/exclude')
    const exText = hasGit && fs.existsSync(exPath) ? fs.readFileSync(exPath, 'utf8') : ''
    ok('状态文件进了 .git/info/exclude', !hasGit || exText.includes('.plugin-state.json'), hasGit ? `exclude=${JSON.stringify(exText.slice(0, 80))}` : '无 git，跳过')
  }

  // 一次性提醒不能把 advice 顶成 maxItems + 1 条
  const { buildTools } = await import(url(path.join(root, 'lib/host/tools.js')))
  const tA = {}
  const ctxB = {
    tools: { register: (t) => { tA[t.name] = t; return () => {} } },
    webServer: { register: () => () => {} },
    get: (n) => (n === 'sessions' ? { get: (id) => (id === 's-a' ? { header: { cwd: tmpA } } : null) } : null),
  }
  buildTools(ctxB, { advice: { maxItems: 2 } })
  fs.writeFileSync(path.join(kbA, '.plugin-state.json'), JSON.stringify({ seen_version: '0.0.0' }), 'utf8')
  const diagCap = await tA.kb_diag.execute({}, { agent: { id: 's-a' } })
  ok(
    'advice 条数不被一次性提醒顶破',
    Array.isArray(diagCap.advice) && diagCap.advice.length === 2,
    JSON.stringify((diagCap.advice || []).map((a) => a.code)),
  )
  ok('提醒排在 advice 最前', diagCap.advice[0] && diagCap.advice[0].code === 'plugin-updated', JSON.stringify((diagCap.advice || []).map((a) => a.code)))
  fs.writeFileSync(path.join(kbA, '.plugin-state.json'), JSON.stringify({ seen_version: '0.0.1' }), 'utf8')
  const n1 = updateNotice(kbA)
  ok('版本变化时提醒一次', n1 && n1.code === 'plugin-updated' && /0\.0\.1/.test(n1.message), JSON.stringify(n1))
  ok('提醒后即视为已看（第二次）', updateNotice(kbA) === null)

  // 缺 H1：文件节点的 source 是绝对路径，检测必须直接读它（不能 join 库根）
  fs.writeFileSync(path.join(kbA, 'doc/nohead.md'), '这页没有一级标题。\n', 'utf8')
  const libA2 = openLibrary(ctxA, { agent: { id: 's-a' } }, {})
  const adv2 = computeAdvice(libA2.nodes, libA2.defs, libA2.nodekb)
  ok('advice：缺 H1 能被检出（绝对路径）', adv2.some((a) => a.code === 'missing-h1'), JSON.stringify(adv2.map((a) => a.code)))
  fs.rmSync(tmpA, { recursive: true, force: true })
}

// ── 12. 1.5.1 回归：git:false 真的关、tid 属性跟着改名、快照历史、陈旧 TID 前缀 ──
{
  const { buildTools } = await import(url(path.join(root, 'lib/host/tools.js')))
  const { init: gitInit } = await import(url(path.join(root, 'lib/engine/vcs.js')))
  const { diag } = await import(url(path.join(root, 'lib/engine/diag.js')))
  const { openLibrary } = await import(url(path.join(root, 'lib/host/runtime.js')))

  const tmpG = path.join(root, '.tmp-151')
  fs.rmSync(tmpG, { recursive: true, force: true })
  const kbG = path.join(tmpG, '.nodekb')
  fs.mkdirSync(path.join(kbG, 'doc'), { recursive: true })
  const page = (v) => `# A\n\n## 1 版本\n\n${v}\n\n<node tid="doc:a:bad" name="doc:a:bad">\n坏前缀\n</node>\n`
  fs.writeFileSync(path.join(kbG, 'doc/a.md'), page('v1'), 'utf8')
  gitInit(kbG)

  const reg = new Map()
  const plain = { register: (t) => { reg.set(t.name, t); return () => {} } }
  const ctxG = {
    tools: plain,
    webServer: { register: () => () => {} },
    get: (n) => (n === 'sessions' ? { get: (id) => (id === 's-g' ? { header: { cwd: tmpG } } : null) } : null),
  }
  buildTools(ctxG, { git: false })
  const execG = { agent: { id: 's-g' } }
  ok('git:false 时 10 个工具照常注册', reg.size === 10, `size=${reg.size}`)

  const before = gitOut(['-C', kbG, 'rev-list', '--count', 'HEAD'])
  const wr = await reg.get('kb_write').execute({ target: 'doc/a.md', content: page('v2'), mode: 'replace' }, execG)
  const after = gitOut(['-C', kbG, 'rev-list', '--count', 'HEAD'])
  if (before !== null && after !== null) {
    ok('config.git=false 关掉 autosnap', !wr.snapshot && after === before, `before=${before} after=${after}`)
  }

  // 改名：文件里的 <node tid="doc:a:…"> 必须跟着改，否则文件 TID 变了、嵌套节点还叫旧名
  const rn = await reg.get('kb_rename').execute({ target: 'doc/a.md', new_name: 'c.md' }, execG)
  const renamed = fs.readFileSync(path.join(kbG, 'doc/c.md'), 'utf8')
  ok('改名会重写 tid= 属性', renamed.includes('doc:c:bad') && !renamed.includes('doc:a:bad'), renamed.split('\n').slice(4, 7).join('|'))
  ok('改名回执不再谎报“没有需要改写的引用”', !/没有需要改写的引用/.test(rn.text), rn.text.split('\n')[0])

  // 换成默认配置（开快照）再写一次：快照历史要有内容
  const reg2 = new Map()
  buildTools({ ...ctxG, tools: { register: (t) => { reg2.set(t.name, t); return () => {} } } }, {})
  await reg2.get('kb_write').execute({ target: 'doc/c.md', content: page('v3'), mode: 'replace' }, execG)
  const vcs = await reg2.get('kb_vcs_status').execute({}, execG)
  ok('kb_vcs_status 返回快照历史', Array.isArray(vcs.history) && vcs.history.length >= 1, JSON.stringify(vcs.history))
  ok('快照历史里是 autosnap 提交', vcs.history.some((l) => /autosnap: \d+ 处变更/.test(l)), JSON.stringify(vcs.history))
  const vcs1 = await reg2.get('kb_vcs_status').execute({ count: 1 }, execG)
  ok('kb_vcs_status 支持 count', vcs1.history.length === 1, JSON.stringify(vcs1.history))

  // 陈旧 TID 前缀：前缀指向不存在的节点、但上一级是目录 → warning
  fs.writeFileSync(path.join(kbG, 'doc/s.md'), '# S\n\n<node tid="doc:zzz:bad" name="doc:zzz:bad">\n旧名残留\n</node>\n', 'utf8')
  const libG = openLibrary(ctxG, execG, {})
  const dg = diag(libG.nodes, { libRoot: libG.nodekb, defs: libG.defs })
  ok('diag 报出陈旧 TID 前缀', dg.report.warnings.some((w) => /TID 前缀指向不存在的节点/.test(w)), JSON.stringify(dg.report.warnings.slice(0, 3)))
  // 误把项目根当库时不能提交（踩过：项目历史里多了 autosnap 提交）
  const vcsMod = await import(url(path.join(root, 'lib/engine/vcs.js')))
  ok('非 .nodekb 目录不初始化 git', /不是 \.nodekb/.test(vcsMod.init(tmpG)), vcsMod.init(tmpG))
  ok('非 .nodekb 目录不自动快照', vcsMod.maybeAutosnap(tmpG) === null)

  fs.rmSync(tmpG, { recursive: true, force: true })
}

// ── 13. 口径统一：TID 判定 / 段边界 / 属性引号 / 围栏 / 改名越界（反馈4 回归） ──────────
{
  const { parse_library } = await import(url(path.join(root, 'lib/engine/mdlib.js')))
  const { writeInto } = await import(url(path.join(root, 'lib/engine/write.js')))
  const { renameFileNode } = await import(url(path.join(root, 'lib/engine/rename.js')))
  const { diag } = await import(url(path.join(root, 'lib/engine/diag.js')))

  const tmpF = path.join(root, '.tmp-f4')
  fs.rmSync(tmpF, { recursive: true, force: true })
  const kbF = path.join(tmpF, '.nodekb')
  fs.mkdirSync(path.join(kbF, 'doc'), { recursive: true })
  fs.writeFileSync(path.join(kbF, 'readme.md'), '# 库根\n\n库根正文。\n', 'utf8')
  fs.writeFileSync(
    path.join(kbF, 'doc/guide.md'),
    [
      '# 指南',
      '',
      "<node name='abi' parent='doc:guide'>",
      '调用约定是 cdecl。',
      '</node>',
      '',
      '## 1. 概述',
      '',
      '概述正文。',
      '',
      '### 1.1 细节',
      '',
      '细节正文。',
      '',
      '## 2. 附录',
      '',
      '~~~md',
      '<node name="example-tid">',
      '这是示例',
      '</node>',
      '示例引用：[[doc:tmp]]',
      '~~~',
      '',
      '真引用：[[doc:tmp]]。',
      '',
    ].join('\n'),
    'utf8',
  )
  fs.writeFileSync(path.join(kbF, 'doc/tmp.md'), '# Tmp\n\n临时。\n', 'utf8')

  const libF = { nodekb: kbF, nodes: parse_library(kbF, []) }

  ok('单引号属性也能解析出节点', libF.nodes.has('abi'), [...libF.nodes.keys()].join(','))
  ok('`## 1.` 编号段 TID 用编号', libF.nodes.has('doc:guide:1'), [...libF.nodes.keys()].filter((t) => t.startsWith('doc:guide')).join(','))

  // ① 无冒号 TID：能就地写入，且不再在库根造出解析器看不见的垃圾文件
  writeInto(libF, { target: 'abi', content: '调用约定改成了 cdecl2。' })
  ok('无冒号的显式节点 TID 能就地改写', fs.readFileSync(path.join(kbF, 'doc/guide.md'), 'utf8').includes('cdecl2'))
  ok('写 TID 不会在库根造同名文件', !fs.existsSync(path.join(kbF, 'abi')))

  const readmeErr = (() => {
    try {
      writeInto(libF, { target: 'readme', content: '新正文' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('库根文件 TID 不再造垃圾文件', !fs.existsSync(path.join(kbF, 'readme')) && readmeErr !== null, readmeErr && readmeErr.message.slice(0, 80))

  const junkErr = (() => {
    try {
      writeInto(libF, { target: 'nonsense', content: 'x' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('既不是 TID 也不像路径的 target 被拒', junkErr !== null && /没有名为/.test(junkErr.message) && !fs.existsSync(path.join(kbF, 'nonsense')), junkErr && junkErr.message.slice(0, 60))

  // ② 段里含 `###` 子节：拒绝，而不是静默把子节删掉
  const secErr = (() => {
    try {
      writeInto(libF, { target: 'doc:guide:1', content: '新概述。' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('段内更深的标题会被拒绝（不静默删子节）', secErr !== null && /结构|子节/.test(secErr.message), secErr && secErr.message.split('\n')[0].slice(0, 90))
  ok('拒绝后子节与正文都还在', fs.readFileSync(path.join(kbF, 'doc/guide.md'), 'utf8').includes('### 1.1 细节'))

  // ③ 改名不能把文件搬出库
  const escErr = (() => {
    try {
      renameFileNode(libF, 'doc:tmp', '..\\..\\escaped')
      return null
    } catch (e) {
      return e
    }
  })()
  ok('new_name 带 .. 被拒', escErr !== null && /不能带目录|库外/.test(escErr.message), escErr && escErr.message.slice(0, 80))
  ok('拒绝后文件仍在原位', fs.existsSync(path.join(kbF, 'doc/tmp.md')) && !fs.existsSync(path.join(tmpF, 'escaped.md')))

  const slashErr = (() => {
    try {
      renameFileNode(libF, 'doc:tmp', 'sub/x.md')
      return null
    } catch (e) {
      return e
    }
  })()
  ok('new_name 带目录分隔符被拒', slashErr !== null && /不能带目录/.test(slashErr.message), slashErr && slashErr.message.slice(0, 60))

  // ④ `~~~` 围栏里的 <node> 只是示例：不建节点、内容不抽走；围栏里的引用也不改名
  ok('`~~~` 里的 <node> 不建节点', !libF.nodes.has('example-tid'))
  ok('`~~~` 围栏原文完整', fs.readFileSync(path.join(kbF, 'doc/guide.md'), 'utf8').includes('这是示例'))
  const rpTmp = renameFileNode(libF, 'doc:tmp', 'tmp2')
  const afterRename = fs.readFileSync(path.join(kbF, 'doc/guide.md'), 'utf8')
  ok('围栏里的引用不跟着改名（只改围栏外那 1 处）', rpTmp.rewritten.length === 1 && rpTmp.rewritten[0].count === 1, JSON.stringify(rpTmp.rewritten))
  ok('围栏内的 `[[doc:tmp]]` 原样保留', afterRename.includes('示例引用：[[doc:tmp]]'), afterRename.split('\n').slice(-6).join('|'))
  ok('围栏外的引用被改写', afterRename.includes('[[doc:tmp2]]'), afterRename.split('\n').slice(-3).join('|'))

  // ⑤ 单引号属性在改名时也要跟着搬
  renameFileNode(libF, 'doc:guide', 'guide9')
  const guide2 = fs.readFileSync(path.join(kbF, 'doc/guide9.md'), 'utf8')
  ok("改名也重写 parent='…'（单引号）", guide2.includes("parent='doc:guide9'") && !guide2.includes("parent='doc:guide'"), guide2.split('\n').slice(2, 5).join('|'))

  const dgF = diag(parse_library(kbF, []), { libRoot: kbF, defs: new Map() })
  ok('这一轮折腾后库里没有 error', dgF.report.errors.length === 0, JSON.stringify(dgF.report.errors))

  // ⑥ 段写入时正文里带标题：劈段或拒绝，绝不能静默产出两个同名段
  fs.writeFileSync(path.join(kbF, 'doc/sec.md'), ['# Sec', '', '## 1. 甲', '', '甲正文。', '', '## 2. 乙', '', '乙正文。', ''].join('\n'), 'utf8')
  const libS = { nodekb: kbF, nodes: parse_library(kbF, []) }
  ok('普通 ## 段解析出两条', libS.nodes.has('doc:sec:1') && libS.nodes.has('doc:sec:2'))
  const secStripped = (() => {
    try {
      return writeInto(libS, { target: 'doc:sec:1', content: '## 1. 甲\n\n新甲正文。' })
    } catch (e) {
      return e
    }
  })()
  const secFile = fs.readFileSync(path.join(kbF, 'doc/sec.md'), 'utf8')
  ok('段写入：首行是本节标题时剥掉（不劈成两段）', !(secStripped instanceof Error) && (secFile.match(/## 1\. 甲/g) || []).length === 1, secStripped instanceof Error ? secStripped.message.slice(0, 90) : secFile.replace(/\n/g, '|'))
  ok('段写入：正文换了、兄弟段还在', secFile.includes('新甲正文') && secFile.includes('乙正文'))

  const secHeadErr = (() => {
    try {
      writeInto(libS, { target: 'doc:sec:1', content: '## 1. 甲\n\n甲正文2。\n\n### 挤进来的小节\n\n子内容。' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('段写入：正文里另带标题会被拒绝', secHeadErr !== null && /标题行/.test(secHeadErr.message), secHeadErr && secHeadErr.message.split('\n')[0].slice(0, 90))
  ok('拒绝后文件没被改', !fs.readFileSync(path.join(kbF, 'doc/sec.md'), 'utf8').includes('子内容'))

  fs.rmSync(tmpF, { recursive: true, force: true })
}

// ── 14. 写坏库却报成功：CRLF 内容 / 标签不配对 / 改名撞 TID / 隐形路径（反馈5 回归） ────
{
  const { parse_library } = await import(url(path.join(root, 'lib/engine/mdlib.js')))
  const { writeInto } = await import(url(path.join(root, 'lib/engine/write.js')))
  const { renameFileNode } = await import(url(path.join(root, 'lib/engine/rename.js')))
  const { diag } = await import(url(path.join(root, 'lib/engine/diag.js')))

  const tmpE = path.join(root, '.tmp-f5')
  fs.rmSync(tmpE, { recursive: true, force: true })
  const kbE = path.join(tmpE, '.nodekb')
  fs.mkdirSync(path.join(kbE, 'doc'), { recursive: true })
  const crlfAbs = path.join(kbE, 'doc/crlf.md')
  fs.writeFileSync(
    crlfAbs,
    '# CRLF\r\n\r\n<node name="abi">\r\n旧正文。\r\n</node>\r\n\r\n## 1. 甲\r\n\r\n旧甲。\r\n',
    'utf8',
  )
  fs.writeFileSync(path.join(kbE, 'doc/03-a.md'), '# 三号\r\n\r\n已有内容。\r\n', 'utf8')
  fs.writeFileSync(path.join(kbE, 'doc/zz.md'), '# ZZ\r\n\r\n待改名。\r\n', 'utf8')
  const libE = { nodekb: kbE, nodes: parse_library(kbE, []) }
  ok('CRLF 夹具解析出 abi 与段节点', libE.nodes.has('abi') && libE.nodes.has('doc:crlf:1'), [...libE.nodes.keys()].join(','))

  // ① content 自带 CRLF：以前 split('\n') 留下 \r，再 join('\r\n') 写成 \r\r\n（字节坏了但回执说成功）
  writeInto(libE, { target: 'abi', content: '第一行\r\n第二行\r\n' })
  const crlfRaw = fs.readFileSync(crlfAbs, 'utf8')
  ok('node 写入不产生 \\r\\r\\n', !crlfRaw.includes('\r\r\n'), JSON.stringify(crlfRaw.slice(0, 80)))
  ok('node 写入跟随原文件的 CRLF 风格', crlfRaw.includes('<node name="abi">\r\n第一行\r\n第二行\r\n</node>'), JSON.stringify(crlfRaw.slice(0, 90)))

  libE.nodes = parse_library(kbE, [])
  writeInto(libE, { target: 'doc:crlf:1', content: '新一\r\n新二\r\n' })
  const secRaw = fs.readFileSync(crlfAbs, 'utf8')
  ok('段写入不产生 \\r\\r\\n', !secRaw.includes('\r\r\n'), JSON.stringify(secRaw.slice(-60)))
  ok('段写入后标题与正文之间有空格行', secRaw.includes('## 1. 甲\r\n\r\n新一\r\n新二\r\n'), JSON.stringify(secRaw.slice(-50)))

  // append：内容自带的结尾 \n 不该在 CRLF 文件里留下裸 LF
  writeInto(libE, { target: 'doc/crlf.md', content: '追加一行\n', mode: 'append' })
  const appRaw = fs.readFileSync(crlfAbs, 'utf8')
  ok('append 不混入裸 LF', (appRaw.match(/\n/g) || []).length === (appRaw.match(/\r\n/g) || []).length, JSON.stringify(appRaw.slice(-40)))

  // ② `</node>` / 未闭合的 `<node>` 会截断节点（以前回执成功、diag 只有一条 warning）
  const closeErr = (() => {
    try {
      writeInto(libE, { target: 'abi', content: '第一段。\n</node>\n漏出来的。' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('content 里的 </node> 被拒', closeErr !== null && /截断|<\/node>/.test(closeErr.message), closeErr && closeErr.message.split('\n')[0].slice(0, 80))
  ok('拒绝后节点正文没变', fs.readFileSync(crlfAbs, 'utf8').includes('第一行'))

  const openErr = (() => {
    try {
      writeInto(libE, { target: 'abi', content: '<node name="x">\n新正文。' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('content 里未闭合的 <node> 被拒', openErr !== null && /未闭合|吞掉/.test(openErr.message), openErr && openErr.message.split('\n')[0].slice(0, 80))

  // ③ 改名撞 TID：Windows 上「03 a」与「03-a」slug 后同名，以前改完另一个文件从库里消失
  libE.nodes = parse_library(kbE, [])
  const clashErr = (() => {
    try {
      renameFileNode(libE, 'doc:zz', '03 a')
      return null
    } catch (e) {
      return e
    }
  })()
  ok('改名撞 TID 被拒', clashErr !== null && /撞名|已被/.test(clashErr.message), clashErr && clashErr.message.slice(0, 90))
  ok('拒绝后两个文件都还在', fs.existsSync(path.join(kbE, 'doc/03-a.md')) && fs.existsSync(path.join(kbE, 'doc/zz.md')))

  const toolsSrc = fs.readFileSync(path.join(root, 'lib/host/tools.js'), 'utf8')
  ok('kb_rename 收尾也跑一次自检（不再只回「已重命名」）', /if \(!report\.dry_run && report\.renamed\)[\s\S]{0,600}?diag\(fresh\.nodes/.test(toolsSrc))

  // ④ 解析器永远跳过的路径（点开头目录、大写扩展名）：写进去等于写了个看不见的文件
  const dotErr = (() => {
    try {
      writeInto(libE, { target: '.draft/x.md', content: '草稿。\n' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('点开头的目录被拒', dotErr !== null && /点开头/.test(dotErr.message), dotErr && dotErr.message.slice(0, 70))
  ok('拒绝后没建出 .draft/', !fs.existsSync(path.join(kbE, '.draft')))

  const upperErr = (() => {
    try {
      writeInto(libE, { target: 'notes/x.MD', content: '大写扩展名。\n' })
      return null
    } catch (e) {
      return e
    }
  })()
  ok('大写扩展名被拒（解析器只认小写 .md）', upperErr !== null && /小写/.test(upperErr.message), upperErr && upperErr.message.slice(0, 80))

  // ⑤ 回执路径统一用 / 分隔（以前路径模式给 doc\01-a.md、TID 模式给 doc/01-a.md）
  const relOk = writeInto(libE, { target: 'notes/x.md', content: '笔记。\n' })
  ok('回执路径用 / 分隔', relOk.rel === 'notes/x.md', relOk.rel)

  const dgE = diag(parse_library(kbE, []), { libRoot: kbE, defs: new Map() })
  ok('这一轮折腾后库里没有 error', dgE.report.errors.length === 0, JSON.stringify(dgE.report.errors).slice(0, 200))

  fs.rmSync(tmpE, { recursive: true, force: true })
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed${gitSkipped ? `, ${gitSkipped} git 断言跳过（环境不允许子进程）` : ''}`)
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
