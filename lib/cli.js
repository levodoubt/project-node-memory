/**
 * cli —— `nodekb` 命令行（1.5.12 起）。
 *
 * 为什么有这一层：`kb_*` 只在 DSH 宿主里可用，于是每个项目为了「脚本 / CI / 别的 agent 平台」
 * 各自造了一份 CLI 或直接 import 引擎源码（`kbq.py`、`nodekb-check.mjs`、`kb_diag_dir.mjs`、
 * 五个项目里硬编码的 `file:///D:/…/lib/engine/*.js`）。这里把读、写、查、改、验收收成一条命令。
 *
 * 与工具层的关系：CLI 只调引擎（`lib/engine/*`），不碰 host（config/exec/会话）。所以它没有
 * 「工作区白名单」——命令行里显式写出的路径本身就是授权；按名字找库时才用当目录的发现结果。
 *
 * 退出码：0 成功 / 1 无命中或无变更 / 2 参数或自检失败（与 kb_diag 的 exit_code 一致）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse_library } from './engine/mdlib.js'
import { collectDefs, refsToDef } from './engine/defs.js'
import { extractRefs } from './engine/parse.js'
import { cmdRead, cmdSearch, cmdDiag } from './engine/commands.js'
import { computeAdvice } from './engine/advice.js'
import { listLibraries } from './engine/registry.js'
import { resolve_path } from './engine/render.js'
import { renameFileNode } from './engine/rename.js'
import { writeInto } from './engine/write.js'
import { status as vcsStatus, history as vcsHistory, commit as vcsCommit, isRepo } from './engine/vcs.js'

const USAGE = `nodekb <命令> [参数]

读：
  nodekb list [--all] [--json]                      列出可用的库
  nodekb read <TID|定义id> [--node] [--toc] [--raw] [--offset N] [--limit N] [--find 词]
  nodekb search <查询> [--type doc] [--limit N] [--lines]
  nodekb backlinks <TID|定义id>
查：
  nodekb diag [--strict]                            结构自检（exit 2 = 有 error）
  nodekb vcs [status|log] [--count N]
改：
  nodekb write <TID|相对路径> [--mode node|append|replace|create] [--content 文本 | --file 文件 | --stdin]
  nodekb rename <目标> <新文件名> [--dry-run]
  nodekb rename --batch <计划.json> [--dry-run]      批量改名（按数组逐条执行，中途失败会停）
公共参数：
  --kb <库名|库目录|任意目录>   省略时用当前目录的 .nodekb，或按名字从当目录发现
  --json                        输出结构化 JSON（Agent / 脚本用）
  --cwd <目录>                  以哪个目录为「当前工作区」（默认进程 cwd）

示例：
  nodekb diag --kb F:/ComfyUI/.dsh/skills/about-comfyui --json
  nodekb search "回归闸门" --kb filmmeasure --lines
  nodekb read doc:03-semantics --kb about-node-memory --find 行号`

function fail(msg) {
  const e = new Error(msg)
  e.exitCode = 2
  throw e
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 极简参数解析：`--k v` / `--k=v` / 裸 `--flag`；其余按位置参数收 */
export function parseArgs(argv) {
  const flags = {}
  const pos = []
  const bools = new Set(['json', 'strict', 'all', 'dry-run', 'node', 'toc', 'raw', 'lines', 'stdin', 'help'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      pos.push(a)
      continue
    }
    const body = a.slice(2)
    const eq = body.indexOf('=')
    if (eq > 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (bools.has(body) || next === undefined || next.startsWith('--')) {
      flags[body] = true
      continue
    }
    flags[body] = next
    i++
  }
  return { flags, pos }
}

/** 定位并打开库：路径（含 .nodekb）或名字 */
export function openTarget(flags = {}, cwd = process.cwd()) {
  const kbArg = flags.kb || flags.lib
  const raw = kbArg && kbArg !== true ? String(kbArg) : ''
  let dir = ''
  let name = ''
  if (raw) {
    const abs = path.resolve(cwd, raw)
    const looksPath = /[\\/]/.test(raw) || /\.nodekb$/i.test(raw) || isDir(abs)
    if (looksPath) {
      dir = path.basename(abs) === '.nodekb' ? abs : path.join(abs, '.nodekb')
      name = path.basename(path.dirname(dir))
    }
  }
  const rows = listLibraries({ workspace: cwd, includeHidden: true })
  if (!dir) {
    const hit = raw ? rows.find((r) => r.name === raw || (r.aliases || []).includes(raw)) : null
    if (hit) {
      dir = path.join(hit.path, '.nodekb')
      name = hit.name
    } else if (raw) {
      const names = rows.map((r) => r.name + ((r.aliases || []).length ? `（别名：${r.aliases.join('、')}）` : '')).join('、')
      fail(`未注册的库: ${raw}（可用: ${names || '无'}）；也可以直接传库目录路径`)
    } else {
      const wsLib = path.join(path.resolve(cwd), '.nodekb')
      if (isDir(wsLib)) {
        dir = wsLib
        name = path.basename(path.resolve(cwd))
      } else {
        fail(`未指定库：用 --kb <库名|目录>（可用: ${rows.map((r) => r.name).join('、') || '无'}）`)
      }
    }
  }
  if (!isDir(dir)) fail(`库目录不存在: ${dir}（要传含 .nodekb 的目录，或直接传 .nodekb）`)
  const nodes = parse_library(dir, [])
  const { defs } = collectDefs(nodes)
  return { dir, name, nodes, defs }
}

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

function json(value) {
  out(JSON.stringify(value, null, 2))
}

function cmdList(flags, cwd) {
  if (flags.kb && flags.kb !== true) {
    const lib = openTarget(flags, cwd)
    const row = { name: lib.name, path: lib.dir, nodes: lib.nodes.size, defs: lib.defs.size }
    if (flags.json) return json({ workspace: cwd, libraries: [row] })
    out(`${row.name}  ${row.path}  （${row.nodes} 节点 / ${row.defs} 定义）`)
    return 0
  }
  const rows = listLibraries({ workspace: cwd, scope: flags.all ? undefined : 'workspace', includeHidden: Boolean(flags.all) })
  const alive = rows.filter((r) => r.exists)
  if (flags.json) return json({ workspace: cwd, libraries: rows })
  out(`工作区: ${cwd}`)
  if (!alive.length) out('  （无可用库）')
  for (const r of rows) {
    const alias = (r.aliases || []).length ? `（别名：${r.aliases.join('、')}）` : ''
    out(`  - ${r.name}${alias}  ${r.path}${r.exists ? '' : '  [路径不存在]'}`)
  }
  return 0
}

function cmdReadCmd(flags, pos) {
  const target = pos[0]
  if (!target) fail('read 需要 <TID|定义id>（如 doc:03-semantics 或 fact:abi）')
  const { dir, nodes, defs } = openTarget(flags)
  const res = cmdRead(nodes, target, {
    node: Boolean(flags.node),
    toc: Boolean(flags.toc),
    raw: Boolean(flags.raw),
    defs,
    libRoot: dir,
    offset: flags.offset ? Number(flags.offset) : 0,
    limit: flags.limit ? Number(flags.limit) : 0,
    find: flags.find === true ? '' : String(flags.find || ''),
  })
  if (flags.json) return json({ kb: dir, target, code: res.code, text: res.text })
  out(res.text)
  return res.code
}

function cmdSearchCmd(flags, pos) {
  const q = pos.join(' ').trim()
  if (!q) fail('search 需要查询词')
  const { dir, nodes, defs } = openTarget(flags)
  const res = cmdSearch(nodes, q, {
    defs,
    libRoot: dir,
    type: flags.type === true ? undefined : flags.type,
    limit: flags.limit ? Number(flags.limit) : undefined,
    lines: Boolean(flags.lines),
  })
  if (flags.json) return json({ kb: dir, query: q, code: res.code, result: res.result })
  out(res.text)
  return res.code
}

function cmdBacklinks(flags, pos) {
  const target = pos[0]
  if (!target) fail('backlinks 需要 <TID|定义id>')
  const { dir, nodes, defs } = openTarget(flags)
  const tid = resolve_path(nodes, target)
  if (tid === null) {
    const def = defs.get(target) || defs.get(String(target).replace(/^tscl:/, ''))
    if (!def) fail(`未找到节点或定义: ${target}`)
    const refs = refsToDef(nodes, def.id, def.ownerTid).filter((r) => !r.self)
    if (flags.json) return json({ kb: dir, target: def.id, kind: 'def', count: refs.length, backlinks: refs })
    out(`引用定义 <tscl id="${def.id}"> 的位置：${refs.length} 处（定义在 ${def.ownerTid}）`)
    for (const r of refs) out(`- ${r.tid} · ${r.title}  ${r.source}`)
    if (!refs.length) out('（没有任何节点展开它）')
    return 0
  }
  const rows = []
  for (const node of nodes.values()) {
    if (node.tid === tid) continue
    if (extractRefs(node.content).some((r) => r.kind !== 'tscl' && r.id === tid)) {
      rows.push({ tid: node.tid, title: node.title, type: node.type, source: node.source })
    }
  }
  if (flags.json) return json({ kb: dir, target: tid, count: rows.length, backlinks: rows })
  out(`引用 ${tid} 的节点：${rows.length} 个`)
  for (const r of rows) out(`- ${r.tid} [${r.type}] ${r.title}  ${r.source}`)
  if (!rows.length) out('（没有任何节点引用它）')
  return 0
}

function cmdDiagCmd(flags) {
  const { dir, nodes, defs } = openTarget(flags)
  const advice = computeAdvice(nodes, defs, dir)
  const { report, code } = cmdDiag(nodes, { problems: [], strict: Boolean(flags.strict), libRoot: dir, defs, advice })
  if (flags.json) return json({ kb: dir, ...report })
  const lines = [
    `库: ${dir}`,
    `节点 ${report.node_count} · 定义 ${report.def_count} · error ${report.errors.length} · warning ${report.warnings.length} · advice ${report.advice.length} · exit ${report.exit_code}`,
  ]
  for (const e of report.errors) lines.push(`  ✗ ${e}`)
  for (const w of report.warnings) lines.push(`  ! ${w}`)
  for (const a of report.advice) lines.push(`  · ${typeof a === 'string' ? a : a.message || JSON.stringify(a)}`)
  out(lines.join('\n'))
  return code
}

function cmdVcsCmd(flags, pos) {
  const { dir } = openTarget(flags)
  const sub = pos[0] || 'status'
  if (!isRepo(dir)) fail(`库没有内嵌 git: ${dir}`)
  if (sub === 'status') {
    const s = vcsStatus(dir)
    if (flags.json) return json({ kb: dir, ...s })
    out(s.text || JSON.stringify(s, null, 2))
    return 0
  }
  if (sub === 'log') {
    const n = flags.count ? Number(flags.count) : 10
    const rows = vcsHistory(dir, n)
    if (flags.json) return json({ kb: dir, history: rows })
    for (const c of rows) out(typeof c === 'string' ? c : JSON.stringify(c))
    return 0
  }
  if (sub === 'commit') {
    const msg = flags.message === true ? '' : String(flags.message || '')
    if (!msg) fail('vcs commit 需要 --message "…"')
    const r = vcsCommit(dir, msg)
    if (flags.json) return json({ kb: dir, ...r })
    out(`已提交: ${r.sha || r.hash || ''} ${msg}`.trim())
    return 0
  }
  fail(`未知 vcs 子命令: ${sub}（status / log / commit）`)
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** `doc/a` 与 `doc/a.md` 等价（target 判定顺序里的「像路径就补 .md」只在引擎内部做，rename 没有这层） */
function asRel(target) {
  const t = String(target || '')
  if (!t || t.includes(':')) return t
  if (/[\\/]/.test(t) && !/\.md$/i.test(t)) return t + '.md'
  return t
}

function cmdWriteCmd(flags, pos) {
  const target = pos[0]
  if (!target) fail('write 需要 <TID|库内相对路径>')
  let content = ''
  if (flags.file && flags.file !== true) content = fs.readFileSync(String(flags.file), 'utf8')
  else if (flags.content && flags.content !== true) content = String(flags.content)
  else if (flags.stdin) content = readStdin()
  if (!content) fail('write 需要内容：--content "…" / --file 路径 / --stdin')
  const { dir, nodes, defs } = openTarget(flags)
  const res = writeInto({ nodekb: dir, nodes, defs }, { target: asRel(target), content, mode: flags.mode === true ? '' : String(flags.mode || '') })
  if (flags.json) return json({ kb: dir, ...res })
  out(`已写入 ${res.rel}（${res.mode}${res.created ? '，新建' : ''}）`)
  return 0
}

function cmdRenameCmd(flags, pos) {
  if (flags.batch && flags.batch !== true) return cmdRenameBatch(flags, String(flags.batch))
  const [target, newName] = pos
  if (!target || !newName) fail('rename 需要 <目标TID|相对路径> <新文件名>（或 --batch 计划.json）')
  const { dir, nodes, defs } = openTarget(flags)
  const report = renameFileNode({ nodekb: dir, nodes, defs }, asRel(target), newName, { dryRun: Boolean(flags['dry-run']) })
  if (flags.json) return json({ kb: dir, ...report })
  const lines = []
  lines.push(report.dry_run ? `将重命名: ${report.from} → ${report.to}` : `已重命名: ${report.from} → ${report.to}`)
  if (report.case_only) lines.push('  只改大小写：TID 不变，引用无需改动')
  for (const w of report.warnings || []) lines.push(`  ! ${w}`)
  for (const r of report.rewritten || []) lines.push(`  改引用: ${r.file || r.rel}（${r.count} 处）`)
  out(lines.join('\n'))
  return 0
}

/** 批量改名的计划：`[{target,new_name}]` 或 `{"renames":[…]}`；也接受 `[["doc/a.md","b"]]` */
function readPlan(file) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(String(file)), 'utf8'))
  } catch (e) {
    fail(`读不了计划文件 ${file}：${e.message}`)
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.renames) ? raw.renames : null
  if (!list) fail('计划文件必须是数组，或 {"renames":[…]}')
  return list.map((it, i) => {
    const target = Array.isArray(it) ? it[0] : it && (it.target || it.from)
    const newName = Array.isArray(it) ? it[1] : it && (it.new_name || it.to)
    if (!target || !newName) fail(`计划第 ${i + 1} 项缺 target / new_name`)
    return { target: String(target), new_name: String(newName) }
  })
}

/**
 * 批量改名：一条一条执行，每条都重新读库（前一条改过的引用就是后一条的输入）。
 * 中途失败立刻停——已完成的会在回执里逐条列出，方便人工判断从哪继续。
 */
function cmdRenameBatch(flags, file) {
  const plan = readPlan(file)
  if (!plan.length) fail('计划是空的')
  const dry = Boolean(flags['dry-run'])
  const reports = []
  let dir = ''
  for (const item of plan) {
    let lib
    try {
      lib = openTarget(flags)
    } catch (e) {
      throw batchError(e, reports, dry, plan.length)
    }
    dir = lib.dir
    try {
      reports.push(
        renameFileNode({ nodekb: lib.dir, nodes: lib.nodes, defs: lib.defs }, asRel(item.target), item.new_name, {
          dryRun: dry,
        }),
      )
    } catch (e) {
      throw batchError(e, reports, dry, plan.length)
    }
  }
  if (flags.json) return json({ kb: dir, dry_run: dry, count: reports.length, reports })
  const lines = [`${dry ? '将批量重命名' : '已批量重命名'} ${reports.length} 个文件：`]
  for (const r of reports) {
    const extra = r.case_only ? '（只改大小写）' : ''
    const refs = (r.rewritten || []).reduce((s, x) => s + x.count, 0)
    lines.push(`  ${r.from} → ${r.to}${extra}${refs ? `  改引用 ${refs} 处` : ''}`)
  }
  out(lines.join('\n'))
  return 0
}

function batchError(e, reports, dry, total) {
  const done = reports.length
  const head = `${dry ? '演练' : '执行'}到第 ${done + 1} / ${total} 条失败：${e.message}`
  const note = done ? `（前 ${done} 条${dry ? '演练' : '已落盘'}：${reports.map((r) => `${r.from}→${r.to}`).join('、')}）` : ''
  return new Error(head + note)
}

/**
 * @param {string[]} argv 不含 node 与脚本名
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<number>} 退出码
 */
export async function runCli(argv, { cwd = process.cwd() } = {}) {
  const { flags, pos } = parseArgs(argv)
  if (flags.cwd && flags.cwd !== true) cwd = path.resolve(String(flags.cwd))
  const cmd = pos.shift() || (flags.help ? 'help' : '')
  try {
    switch (cmd) {
      case 'list':
      case 'libs':
        return cmdList(flags, cwd)
      case 'read':
        return cmdReadCmd(flags, pos)
      case 'search':
        return cmdSearchCmd(flags, pos)
      case 'backlinks':
        return cmdBacklinks(flags, pos)
      case 'diag':
      case 'check':
        return cmdDiagCmd(flags)
      case 'vcs':
        return cmdVcsCmd(flags, pos)
      case 'write':
        return cmdWriteCmd(flags, pos)
      case 'rename':
        return cmdRenameCmd(flags, pos)
      case 'help':
      case '':
        out(USAGE)
        return cmd ? 0 : 1
      default:
        out(USAGE)
        fail(`未知命令: ${cmd}`)
    }
  } catch (e) {
    if (flags.json) json({ ok: false, error: e.message })
    else process.stderr.write(`nodekb: ${e.message}\n`)
    return e.exitCode || 1
  }
}
