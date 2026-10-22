/**
 * parity —— 对拍：JS 移植 vs Python 原实现（同一夹具、同一参数、逐字段比 JSON）。
 *
 * 只在开发期跑（CI 不需要 Python）：`node test/parity.mjs`
 * 夹具库在 test/fixtures/sample/.nodekb（干净库）。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parse_library } from '../lib/engine/mdlib.js'
import { cmdRead, cmdSearch, cmdDiag } from '../lib/engine/commands.js'

const PY = process.env.NODEKB_PYTHON || 'python'
const PY_SRC = process.env.NODEKB_PY_SRC || path.join(import.meta.dirname, '..', '..', 'nodekb')
const FIX = path.join(import.meta.dirname, 'fixtures', 'sample')

// 对拍要本机的 python + nodekb 源码；缺任一就跳过（CI 上没有它们，不该报红）。
if (!fs.existsSync(path.join(PY_SRC, 'kb', '__main__.py'))) {
  console.log(`skip: 找不到 nodekb 源码（NODEKB_PY_SRC=${PY_SRC}）。设好环境变量再跑。`)
  process.exit(0)
}

// 注意：沙箱里不能开管道捕获子进程输出（spawn 的默认 stdio:'pipe' 会 EPERM），
// 所以把 python 的 stdout 直接写到文件描述符上，再读文件。
const TMP = path.join(import.meta.dirname, '.parity-out.txt')

function py(args) {
  const fd = fs.openSync(TMP, 'w')
  try {
    spawnSync(PY, ['-m', 'kb', ...args, '--lib', FIX], {
      env: { ...process.env, PYTHONPATH: PY_SRC, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', fd, 'inherit'],
    })
  } finally {
    fs.closeSync(fd)
  }
  return fs.readFileSync(TMP, 'utf8').replace(/\r\n/g, '\n') // python 文本模式把 \n 写成 \r\n
}

function pyJson(args) {
  return JSON.parse(py([...args, '--json']))
}

const problems = []
const nodes = parse_library(path.join(FIX, '.nodekb'), problems)

let pass = 0
const fails = []

function check(name, a, b) {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa === sb) {
    pass += 1
    return
  }
  fails.push({ name, a: sa, b: sb })
}

function readCase(name, target, opts = {}, pyArgs) {
  const got = cmdRead(nodes, target, opts)
  const expect = pyJson([...pyArgs])
  check(name, expect.text, got.text)
}

// 1.1 起渲染语义与 Python 版分叉：[[node="x"]] 只出链接、[[tscl="x"]] 才展开。
// 所以对拍只保留**结构层**（raw/toc/未命中/maxlen/检索索引/diag 的 error 列表）——
// 这些是「同一份 md 解析出同一棵树」的证据；渲染差异属于有意变更，由 scripts/check.mjs 覆盖。
// raw 模式 Python 不套 {"tid","text"} 外壳，直接比对象
{
  const got = cmdRead(nodes, 'doc:index', { raw: true }).text
  check('read doc:index raw obj', pyJson(['read', 'doc:index', '--raw']), JSON.parse(got))
}

// toc 不套 --json 外壳，直接比文本（去掉 CLI print 的尾部换行）
check(
  'read doc:index toc',
  py(['read', 'doc:index', '--toc']).replace(/\s+$/, ''),
  cmdRead(nodes, 'doc:index', { toc: true }).text,
)

// node 模式：Python 侧含「本节点含 N 个子节」提示且会展开引用 → 只比前言的纯文本前缀
{
  const got = cmdRead(nodes, 'doc:index', { node: true }).text.split('\n\n（本节点含')[0]
  check('node 模式可比前缀', true, got.startsWith('这是 doc 首页的前言'))
}

// 未命中 → 候选列表 + code 2
{
  const got = cmdRead(nodes, 'doc:inde', {})
  const expect = py(['read', 'doc:inde']).trim()
  check('read 未命中', expect, got.text)
  check('read 未命中 code', 2, got.code)
}

// 整支超上限
{
  const got = cmdRead(nodes, 'root', { maxlen: 10 })
  check('read maxlen 护栏 code', 2, got.code)
  check('read maxlen 护栏前缀', true, got.text.startsWith('渲染超上限: '))
}

// search：多词加权 / 中文 2-gram / 兜底
for (const [name, q] of [
  ['search 双语词', 'ABI 结构体'],
  ['search 中文句子', '编译契约怎么保证'],
  ['search 单字词', '坑'],
  ['search 无命中', '不存在zzz'],
  ['search TID 前缀', 'fact'],
]) {
  const expect = pyJson(['search', q, '--limit', '10'])
  const got = cmdSearch(nodes, q, { limit: 10 })
  // 只比索引结果（命中集合与计数）；snippet 是渲染文本，1.1 起必然不同
  check(
    name,
    { total: expect.total, count: expect.count, offset: expect.offset, tids: expect.hits.map((h) => h.tid) },
    { total: got.result.total, count: got.result.count, offset: got.result.offset, tids: got.result.hits.map((h) => h.tid) },
  )
}

// diag：只比 error 列表（warning 侧 1.1 新增了旧语法/未引用定义等检查）
// 位置型引用在 Python 里是 error、1.1 起降为 warning（链接不像展开那样复制正文），单独比。
{
  const expect = JSON.parse(py(['diag']))
  const got = cmdDiag(nodes, { problems }).report
  check('diag errors', expect.errors.filter((e) => !/位置型/.test(e)), got.errors)
  check(
    'diag 位置型降级为 warning',
    true,
    expect.errors.some((e) => /位置型/.test(e)) === got.warnings.some((w) => /位置型/.test(w)),
  )
}

if (fails.length === 0) {
  fs.writeFileSync(path.join(import.meta.dirname, '.parity-fails.txt'), 'ALL OK\n')
  console.log(`parity OK: ${pass}/${pass}`)
} else {
  const lines = [`parity FAIL: ${pass} ok, ${fails.length} bad`]
  for (const f of fails) lines.push(`\n--- ${f.name}\npy: ${f.a}\njs: ${f.b}`)
  fs.writeFileSync(path.join(import.meta.dirname, '.parity-fails.txt'), lines.join('\n'))
  console.log(`parity FAIL: ${pass} ok, ${fails.length} bad (see test/.parity-fails.txt)`)
  process.exitCode = 1
}
