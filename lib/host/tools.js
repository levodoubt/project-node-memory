import { markSeen, updateNotice } from '../engine/notice.js'

// 旧位置在这里直接定义了 markSeen / updateNotice（1.5.15 及以前）。1.5.16 起搬到
// lib/engine/notice.js，命令行与工具层共用同一份，避免「同一个库两层输出不同构」。
// 这里重新导出，保持 `lib/host/tools.js` 原有的对外接口不变。
export { markSeen, updateNotice }

/**
 * tools —— 注册 10 个 kb_* 工具（纯 JS，不 import 任何 @deepseek-ai/* 包）。
 *
 * 工具契约（与宿主 registry 结构兼容）：
 *   { name, description, parameters: raw JSON Schema, output: { schema, render(args,value) }, execute(args,exec) }
 *
 * 设计取向：description 本身就是 prompt，所以它要写清楚「什么时候用我、什么时候别用我」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { render_node, render_node_window, render_subtree, toc_lines, node_info, resolve_path } from '../engine/render.js'
import { search, formatSearch, findWithFallback, formatFind } from '../engine/search.js'
import { clipText } from '../engine/commands.js'
import { diag } from '../engine/diag.js'
import { extractRefs } from '../engine/parse.js'
import { refsToDef, formatDefRead } from '../engine/defs.js'
import { renameFileNode, formatRename } from '../engine/rename.js'
import { scaffold } from '../engine/scaffold.js'
import { computeAdvice } from '../engine/advice.js'
import { writeInto } from '../engine/write.js'
import { isInside, writeProjectRegistry } from '../engine/registry.js'
import { knownLibraryIndex } from '../engine/config.js'
import { maybeAutosnap, init as gitInit, status as gitStatus, history as gitHistory, gitAvailable } from '../engine/vcs.js'
import {
  openLibrary,
  workspaceOf,
  workspaceSource,
  libraryHint,
  knownLibraries,
  workspaceRoots,
  sessionIdOf,
  bindServices,
  forgetLibrary,
  rememberWorkspace,
} from './runtime.js'

const DEFAULT_MAXLEN = 50000

/** 最近一次批量注册的结果（给 /nodekb/api/tools 自证用） */
const TOOL_STATE = { registered: 0, failed: [] }

export function toolState() {
  return { registered: TOOL_STATE.registered, failed: [...TOOL_STATE.failed] }
}

const KB_PARAM = {
  type: 'string',
  description: '库：名字（注册表/工作区里的名字）或目录路径（技能目录或其 .nodekb）。省略则用工作区默认库。',
}

function text(t) {
  return [{ type: 'text', text: t }]
}

/**
 * `format: 'json'` 时把 execute 的结构化返回值原样给出来（只去掉用于人读的 `text` 字段）。
 * 为什么要有：这些工具本来就算出了 {tid, source, lines, hits…}，但 render 一律折成散文，
 * Agent 想按「errors 为空才继续」这种条件分支只能回去正则匹配文本——于是每个项目都自己
 * import 引擎再算一遍（本机五个库各自写过 lint 脚本）。
 */
function renderStructured(args, value) {
  if (!args || args.format !== 'json' || !value) return text(value && value.text)
  const { text: _omit, ...rest } = value
  return text(JSON.stringify(rest, null, 2))
}

const FORMAT_PARAM = {
  type: 'string',
  enum: ['text', 'json'],
  description: 'text（默认）给散文；json 给结构化字段（可用于条件判断，省去解析）。',
}

/** 目标目录里已经有一份 md 结构（但不是 `.nodekb` 本身）——多半是误把上级目录当库目录传了 */
function looksLikeExistingProject(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
    if (fs.existsSync(path.join(dir, '.nodekb'))) return false
    if (path.basename(dir) === '.nodekb') return false
    return fs
      .readdirSync(dir)
      .some((n) => ['doc', 'lessons', 'todo', 'index'].includes(n) || n.toLowerCase() === 'readme.md')
  } catch {
    return false
  }
}

function warnPrefix(lib) {
  if (!lib.problems || !lib.problems.length) return ''
  return `⚠ 库有 ${lib.problems.length} 处 TID 冲突，已跳过冲突项：\n  - ${lib.problems.slice(0, 5).join('\n  - ')}\n\n`
}

/** 允许建库/写库的根：本会话工作区 + 全部已登记工作区 + 所有已注册库（技能目录也在其中） */
function allowedRoots(config, exec) {
  const out = []
  try {
    for (const r of knownLibraries(config, exec)) {
      const p = r.path || r.nodekb
      if (typeof p === 'string' && p) out.push(p)
    }
  } catch {
    /* 库列表拿不到就只靠 workspaceRoots */
  }
  for (const r of workspaceRoots()) out.push(r)
  try {
    out.push(workspaceOf(config, exec))
  } catch {
    /* ignore */
  }
  return [...new Set(out.filter(Boolean))]
}

/** 库定位失败时补一句「有哪些库可用」，别让模型瞎猜 */
function locate(config, exec, args) {
  try {
    return openLibrary(config, exec, { kb: args.kb })
  } catch (e) {
    const hint = libraryHint(config, exec)
    const err = new Error(`${e.message}${hint ? `\n${hint}` : ''}`)
    err.cause = e
    throw err
  }
}

export function buildTools(ctx, config) {
  bindServices(ctx)
  const tools = []

  // ── kb_list ──────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_list',
    description:
      '列出当前可用的 nodekb 知识库，以及本次调用实际会命中的工作区与默认库。建库前/不确定该传什么 kb 时先用它。',
    parameters: { type: 'object', properties: { format: FORMAT_PARAM } },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(_args, exec) {
      const src = workspaceSource(config, exec)
      const rows = knownLibraries(config, exec)
      const byName = new Map()
      for (const r of rows) byName.set(r.name, (byName.get(r.name) || 0) + 1)
      const lines = [`工作区: ${src.path}（来源: ${src.from}）`]
      if (sessionIdOf(exec)) lines.push(`会话: ${sessionIdOf(exec)}`)
      lines.push('', '可用于 kb_* 工具的 nodekb 库：')
      if (!rows.length) {
        lines.push('  （无）在工作区建 .nodekb/ 并放 md 文件，或先调 kb_init。')
      }
      for (const r of rows) {
        if (!r.exists) continue // 失效登记不占版面：下面统一报一行
        const origin = r.origin === 'workspace' ? '  （工作区默认）' : `  （${r.origin}）`
        const dup = byName.get(r.name) > 1 ? '  ⚠ 同名库，按名字调用有歧义，请用路径' : ''
        // 一个库可以有多个名字（发现出来的名字 + 注册表里的别名），并到同一行：
        // 否则「kb= 能用的名字」在 list 里根本看不见。
        const alias = r.aliases && r.aliases.length ? `  （别名：${r.aliases.join('、')}）` : ''
        lines.push(`- ${r.name}  ${r.path}${alias}${origin}${dup}`)
      }
      const dead = rows.filter((r) => !r.exists)
      if (dead.length) {
        lines.push(
          `（另有 ${dead.length} 条登记指向不存在的路径，已隐藏：${dead.map((r) => r.name).join('、')}）` +
            `\n  要清掉就删 kb_registry.json 里对应的项，或 kb_register 同一名字重新登记。`,
        )
      }
      // 别处的库：本工作区发现不到，但以前打开过（机器级索引，1.5.17）。只提醒「有这么个库」，
      // 要真用它得传路径（或先在那边的工作区里 kb_register 一次）。
      try {
        const here = new Set(rows.filter((r) => r.exists).map((r) => path.resolve(r.path, '.nodekb')))
        const elsewhere = knownLibraryIndex().filter((x) => {
          const nb = path.resolve(x.nodekb)
          return !here.has(nb) && fs.existsSync(nb)
        })
        if (elsewhere.length) {
          const sample = elsewhere.slice(0, 5).map((x) => `${x.name}（${path.dirname(x.nodekb)}）`).join('、')
          lines.push(
            `（另有 ${elsewhere.length} 个库不在本工作区：${sample}${elsewhere.length > 5 ? ' 等' : ''}` +
              `\n  它们不会被本工作区的 kb=名字 解析到；用路径传 kb=/--kb，或到那个项目里再调一次即可。）`,
          )
        }
      } catch {
        /* 索引读不到不影响列表 */
      }
      return { text: lines.join('\n'), workspace: src.path, workspaceFrom: src.from, libs: rows }
    },
  })

  // ── kb_read ──────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_read',
    description:
      '读知识库的一个节点。长节点用 offset/limit 分窗读（先 look）；format="json" 可提供结构化字段（tid/source/lines/chars）。',
    parameters: {
      type: 'object',
      properties: {
        format: FORMAT_PARAM,
        target: {
          type: 'string',
          description: '节点 TID 或其唯一前缀；也可以是 <tscl id> 定义的名字（回定义体、定义处、被谁引用）。空字符串或 "." 表示库根。',
        },
        kb: KB_PARAM,
        mode: {
          type: 'string',
          enum: ['subtree', 'node', 'toc', 'raw'],
          description: 'subtree（默认，整支投影）| node（仅本节点）| toc（目录视图）| raw（元信息+原文）',
        },
        maxlen: { type: 'integer', description: '整支渲染的字符上限，默认 50000；传 0 表示不限。超限不再报错，而是截断并在结尾给出续读用的 offset。' },
        offset: {
          type: 'integer',
          description:
            '从第几行开始（1 起）。mode=node 时按「本节点正文行」；mode=subtree 时按「渲染结果的第几行」。返回头会写明两种坐标。',
        },
        limit: { type: 'integer', description: '最多返回多少行（1 起算窗口长度）。不传 = 到末尾（仍受 maxlen 约束）。' },
        find: {
          type: 'string',
          description:
            '只找这个词，返回命中行（文件行号 + 行文本，最多 20 处），不返回正文。拿到行号后再用 offset 读那一段。整串没中时按词退让（每个词都要出现、不限顺序）：`Fresnel coefficient` 能找到 `Fresnel reflection coefficient`，退让命中会在回执里写明用了哪几个词。',
        },
        depth: {
          type: 'integer',
          description: 'mode=toc 时往下展开几层，默认 2；传 0 只列目标节点本身（大库的目录以前整支递归，一次上千 token）。有子节的节点在 toc 头部会报「整支 N 字符」，用来判断要不要点进去。',
        },
      },
      required: ['target'],
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const target = String(args.target ?? '').trim() || 'root'
      const mode = args.mode || 'subtree'
      const maxlen = args.maxlen === undefined ? DEFAULT_MAXLEN : Number(args.maxlen) || 0

      const tid = resolve_path(lib.nodes, target)
      if (tid === null) {
        // target 也可能是 tscl 定义 id（值的老家可能只是一句话，没有节点）
        const def = lib.defs.get(target)
        if (def) {
          return {
            tid: target,
            kind: 'def',
            title: def.ownerTitle || '',
            type: '',
            source: def.source || '',
            kb: lib.name,
            mode,
            chars: String(def.body || '').length,
            text: warnPrefix(lib) + formatDefRead(def, refsToDef(lib.nodes, target, def.ownerTid)),
          }
        }
        const cands = [...lib.nodes.keys()].filter((t) => t.startsWith(target) || t.startsWith(target + ':')).sort().slice(0, 10)
        const defCands = [...lib.defs.keys()].filter((d) => d.includes(target)).sort().slice(0, 5)
        throw new Error(
          `未找到节点: ${target}${cands.length ? `；候选: ${cands.join('、')}` : ''}${defCands.length ? `；tscl 定义候选: ${defCands.join('、')}` : ''}`,
        )
      }

      let out
      const ctx = { defs: lib.defs, libRoot: lib.nodekb }
      const off = Number(args.offset) || 0
      const lim = Number(args.limit) || 0
      const term = String(args.find ?? '').trim()
      const nodeObj = lib.nodes.get(tid)

      // find：只给命中行（文件行号），不返回正文。
      // 1.5.17：走 search.js 的 findWithFallback（与引擎 cmdRead 同一份实现）——
      // 以前这里直接调 findLines，只有整串匹配，工具描述里写的「按词退让」在宿主层不生效。
      if (term && mode !== 'toc' && mode !== 'raw') {
        const found = findWithFallback(lib.nodes, tid, term, { deep: mode !== 'node', max: 20, libRoot: lib.nodekb })
        const hits = found.hits
        if (!hits.length) {
          return {
            tid,
            title: nodeObj ? nodeObj.title : '',
            type: nodeObj ? nodeObj.type : '',
            source: nodeObj ? nodeObj.source : '',
            kb: lib.name,
            mode,
            find: term,
            hits: 0,
            chars: 0,
            text: warnPrefix(lib) + `未命中: ${term}（${mode === 'node' ? '本节点' : '本支'}）`,
          }
        }
        const how = found.loose ? `（整串没中，改成「每个词都要出现」的退让匹配：${found.used}）` : ''
        const head =
          `找到 ${hits.length} 处（${mode === 'node' ? '本节点' : '本支'}，最多列 20 处）${how}。` +
          `行号是文件行号；mode=node 时把「节点正文第几行」当 offset，subtree 时按渲染行数。\n`
        return {
          tid,
          title: nodeObj ? nodeObj.title : '',
          type: nodeObj ? nodeObj.type : '',
          source: nodeObj ? nodeObj.source : '',
          kb: lib.name,
          mode,
          find: term,
          hits: hits.length,
          loose: found.loose,
          used: found.used,
          chars: head.length,
          text: warnPrefix(lib) + head + formatFind(found.used, hits),
        }
      }

      if (mode === 'toc') {
        // depth：往下展开几层（默认 2，0＝只列本节点）。目录是定位用的，整支递归在大库上很贵
        out = toc_lines(lib.nodes, tid, 0, args.depth === undefined || args.depth === null ? {} : { depth: Number(args.depth) }).join('\n')
      } else if (mode === 'raw') {
        out = JSON.stringify(node_info(lib.nodes, tid), null, 2)
      } else if (mode === 'node') {
        const win = render_node_window(lib.nodes, tid, ctx, { offset: off, limit: lim })
        let body = win.text
        let clipped = null
        if (maxlen && body.length > maxlen) {
          clipped = clipText(body, { maxChars: maxlen })
          body = clipped.text
        }
        const windowed = off > 1 || lim > 0 || !!clipped || win.end < win.total || win.start > 1
        out = body
        if (windowed) {
          const file = String(nodeObj.source || '').replace(/#L.*$/, '')
          out = `[${file}#L${win.first}-L${win.last} · 本节点第 ${win.start}–${win.end} 行 / 共 ${win.total} 行]\n\n${body}`
          if (clipped) {
            out +=
              `\n\n（已按 maxlen=${maxlen} 截断：本窗口 ${body.length} 字符 / 共 ${win.text.length} 字符；` +
              `继续用 offset=${win.start + clipped.take}）`
          } else if (win.end < win.total) {
            out += `\n\n（本节点后面还有 ${win.total - win.end} 行，继续用 offset=${win.end + 1}）`
          }
        }
        const kids = [...lib.nodes.values()].filter((c) => c.parent_tid === tid).length
        if (kids) out += `\n\n（本节点含 ${kids} 个子节：正文在子节里；看结构用 mode=toc，看整支不传 mode）`
      } else {
        const full = render_subtree(lib.nodes, tid, 1, ctx)
        const all = String(full).split('\n')
        const total = all.length
        const start = Math.max(1, off || 1)
        const want = lim > 0 ? lim : total - start + 1
        const takeLines = Math.max(0, Math.min(want, total - start + 1))
        let body = all.slice(start - 1, start - 1 + takeLines).join('\n')
        let clipped = null
        if (maxlen && body.length > maxlen) {
          clipped = clipText(body, { maxChars: maxlen })
          body = clipped.text
        }
        const shown = clipped ? clipped.take : takeLines
        const last = start + shown - 1
        const windowed = start > 1 || lim > 0 || !!clipped
        out = body
        if (windowed) {
          out = `[整支第 ${start}–${Math.max(start, last)} 行 / 共 ${total} 行]\n\n${body}`
          const next = last + 1
          if (next <= total) {
            out += `\n\n（后面还有 ${total - last} 行，继续用 offset=${next}${maxlen ? `（maxlen=${maxlen}）` : ''}）`
          }
        }
      }
      const node = lib.nodes.get(tid)
      return {
        tid,
        title: node ? node.title : '',
        type: node ? node.type : '',
        source: node ? node.source : '',
        kb: lib.name,
        mode,
        chars: out.length,
        text: warnPrefix(lib) + out,
      }
    },
  })

  // ── kb_search ────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_search',
    description:
      '检索知识库（中文 2-gram + 多词加权 + 子串兜底）。建议先 kb_search 拿 tid 再 kb_read。命中行里 tid 是稳定句柄、ref 才是真正命中的节点（可能更具体）。片段经过渲染：[[tscl="x"]] 已嵌成它的值，搜到值不用再读定义。',
    parameters: {
      type: 'object',
      properties: {
        format: FORMAT_PARAM,
        query: { type: 'string', description: '检索词或自然语言问句。' },
        kb: KB_PARAM,
        type: { type: 'string', description: '只保留该类型的节点（如 doc / todo / handover）。' },
        limit: { type: 'integer', description: '返回条数上限，默认 10。' },
        offset: { type: 'integer', description: '跳过前 N 条，用于翻页。' },
        snippet: { type: 'integer', description: '命中片段窗口字符数，默认 240。' },
        lines: {
          type: 'boolean',
          description: '每个命中节点再给最多 3 条行级命中（文件行号 + 该行文本），便于直接定位。默认关闭。',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const res = search(lib.nodes, String(args.query ?? ''), {
        type: args.type,
        limit: args.limit === undefined ? 10 : Number(args.limit),
        offset: args.offset === undefined ? 0 : Number(args.offset),
        snippet: args.snippet === undefined ? 240 : Number(args.snippet),
        lines: !!args.lines,
        defs: lib.defs,
        libRoot: lib.nodekb,
      })
      const body = formatSearch(args.query, res)
      const footer =
        res.total > res.count
          ? `\n\n（共 ${res.total} 条，已返回 ${res.count} 条；还有 ${res.total - res.count} 条，用 offset=${res.offset + res.count} 继续翻）`
          : ''
      return { ...res, kb: lib.name, text: warnPrefix(lib) + body + footer }
    },
  })

  // ── kb_diag ──────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_diag',
    description:
      '结构自检，errors = 真损坏（必修，exit_code 2）；warnings = 疑似漂移，默认不算失败；advice = 改进建议，不影响退出码（插件配置 advice.display=false 可关、advice.limit 控条数、diag_ignore.json 的 advice 规则逐条豁免）。建议写完 md 就跑一次。format="json" 时不抛异常，成败看 exit_code。',
    parameters: {
      type: 'object',
      properties: {
        format: FORMAT_PARAM,
        kb: KB_PARAM,
        strict: { type: 'boolean', description: '严格模式：把 warnings 也算失败。' },
      },
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const opts = config.advice || {}
      const notice = updateNotice(lib.nodekb)
      // 条数/开关由 computeAdvice 统一管（limit: 0 = 不限、display: false = 关掉）；
      // 这里只负责把「一次性提醒」插到最前，并按同一个上限把它算进去，别让它顶成上限 + 1。
      const advice = computeAdvice(lib.nodes, lib.defs, lib.nodekb, opts)
      if (notice) {
        advice.unshift(notice)
        const cap = Number.isFinite(Number(opts.limit)) && Object.prototype.hasOwnProperty.call(opts, 'limit') ? Number(opts.limit) : opts.maxItems || 5
        if (cap > 0 && advice.length > cap) advice.length = cap
      }
      const { report, code } = diag(lib.nodes, { problems: lib.problems, strict: !!args.strict, libRoot: lib.nodekb, defs: lib.defs, advice })
      const text_ = JSON.stringify(report, null, 2)
      // format=json 不抛：Agent 要自己按 exit_code 分支（抛了就只剩错误文本，还得再解析）
      if (code !== 0 && args.format !== 'json') {
        const e = new Error(text_)
        e.code = 'KB_DIAG_FAILED'
        throw e
      }
      return { ...report, kb: lib.name, text: text_ }
    },
  })

  // ── kb_backlinks ─────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_backlinks',
    description:
      '反查：谁引用了这个 id（节点 TID 或 <tscl> 定义 id）。建议改 TID 或删节点前先跑。',
    parameters: {
      type: 'object',
      properties: {
        format: FORMAT_PARAM,
        target: { type: 'string', description: '节点 TID 或其唯一前缀；也可以是 <tscl id> 定义的名字。' },
        kb: KB_PARAM,
      },
      required: ['target'],
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const raw = String(args.target ?? '').trim()
      const tid = resolve_path(lib.nodes, raw)
      if (tid === null) {
        // 与 kb_read 同一口径：节点找不到时再看是不是 <tscl> 定义
        const def = lib.defs && (lib.defs.get(raw) || lib.defs.get(raw.replace(/^tscl:/, '')))
        if (def) {
          const refs = refsToDef(lib.nodes, def.id, def.ownerTid)
          const outside = refs.filter((r) => !r.self)
          const lines = [`引用定义 <tscl id="${def.id}"> 的位置：${outside.length} 处（定义在 ${def.ownerTid}）`]
          for (const r of outside) {
            lines.push(`- ${r.tid} · ${r.title}${r.legacy ? '（旧语法）' : ''}  ${r.source}`)
          }
          if (!outside.length) lines.push('（没有任何节点展开它）')
          if (refs.length > outside.length) lines.push(`另有 ${refs.length - outside.length} 处在定义所在节点内部（不计入）`)
          return { target: def.id, kind: 'def', count: outside.length, backlinks: outside, kb: lib.name, text: warnPrefix(lib) + lines.join('\n') }
        }
        throw new Error(`未找到节点或定义: ${args.target}`)
      }
      const rows = []
      for (const node of lib.nodes.values()) {
        if (node.tid === tid) continue
        const hit = extractRefs(node.content).some((r) => r.kind !== 'tscl' && r.id === tid)
        if (hit) rows.push({ tid: node.tid, title: node.title, type: node.type, source: node.source })
      }
      const lines = [`引用 ${tid} 的节点：${rows.length} 个`]
      for (const r of rows) lines.push(`- ${r.tid} [${r.type}] ${r.title}  ${r.source}`)
      if (!rows.length) lines.push('（没有任何节点引用它）')
      return { target: tid, count: rows.length, backlinks: rows, kb: lib.name, text: warnPrefix(lib) + lines.join('\n') }
    },
  })

  // ── kb_rename ────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_rename',
    description:
      '重命名 md 文件并改写全库指向它的引用（`[[…]]` 与 `<node` 的 `tid=` / `name=` / `parent=` 属性）。写前重读校验，别人刚改过的文件跳过不覆盖。改名后也会跑一次自检并把 error 带回执。要一次改很多个文件用 `nodekb rename --batch`。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '文件节点的 TID（如 kb_read --toc 里的 doc:03-x），或相对路径 doc/03-x.md。' },
        new_name: { type: 'string', description: '新文件名（.md 可省略）。只能是库内同目录的文件名，不能带目录分隔符或 `..`。' },
        dry_run: { type: 'boolean', description: 'true = 只报「会改哪些引用」，不动文件。' },
        kb: KB_PARAM,
      },
      required: ['target', 'new_name'],
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const report = renameFileNode(lib, String(args.target ?? ''), String(args.new_name ?? ''), {
        dryRun: Boolean(args.dry_run),
      })
      // 改名只动文件名：缓存签名里的 mtime/size 都不变，不主动失效就会继续用旧索引
      if (!report.dry_run && report.renamed) forgetLibrary(lib.nodekb)
      const head = warnPrefix(lib) + formatRename(report)
      const rest = []
      let errs = 0
      let warns = 0
      let snap = ''
      // 改名也会把库写坏（撞 TID、丢文件）：收尾同样跑一次自检，别让回执只剩一句「已重命名」
      if (!report.dry_run && report.renamed) {
        try {
          const fresh = openLibrary(config, exec, { kb: args.kb, lib: args.lib })
          const rep = diag(fresh.nodes, { problems: fresh.problems, libRoot: fresh.nodekb, defs: fresh.defs })
          const r = rep.report || rep
          errs = (r.errors || []).length
          warns = (r.warnings || []).length
          rest.push(`库状态: ${r.node_count ?? '?'} 节点，${errs} error / ${warns} warning`)
          if (errs) rest.push('需要修:\n' + r.errors.slice(0, 6).map((e) => '  ✗ ' + e).join('\n'))
          if (warns) rest.push('提示:\n' + r.warnings.slice(0, 4).map((w) => '  ! ' + w).join('\n'))
          // 先自检、再快照：和 kb_write 一样，结构写坏的那一版不该进历史
          if (errs === 0 && config.git !== false) snap = maybeAutosnap(lib.nodekb) || ''
          else if (errs && config.git !== false) rest.push('未快照：自检有 error，修好后的下一次写入会一并快照')
        } catch (e) {
          rest.push(`写后解析失败: ${e.message}`)
          errs = 1
        }
      }
      if (snap) report.snapshot = snap
      const lines = [snap ? `快照: ${snap}` : '', head, ...rest].filter(Boolean)
      return { ...report, kb: lib.name, errors: errs, warnings: warns, text: lines.join('\n') }
    },
  })

  // ── kb_vcs_status ────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_vcs_status',
    description:
      '库内嵌 git 的最近几条快照与未提交改动（写入/改名成功后自动快照）。' +
      '要看更早历史用 `git -C <库目录> log`；git 不可用时只说明不报错。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '要看几条快照，默认 5，最多 50。' },
        kb: KB_PARAM,
      },
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const st = gitStatus(lib.nodekb)
      const n = Number(args.count) > 0 ? Number(args.count) : 5
      const out = { kb: lib.name, nodekb: lib.nodekb, ...st, history: [] }
      if (!st.repo) {
        out.text = `库 ${lib.name} 未初始化 git（或系统没有 git）：${st.error}。读取与检索不受影响；要历史快照请 kb_init 重建骨架，或手动 git init ${lib.nodekb}。`
        return out
      }
      out.history = gitHistory(lib.nodekb, n)
      const lines = [`库 ${lib.name}（${lib.nodekb}）`]
      if (out.history.length) {
        lines.push(`最近 ${out.history.length} 条快照:`, ...out.history.map((l) => '  ' + l))
      } else {
        lines.push(`HEAD: ${st.last_commit}`)
      }
      if (st.dirty) lines.push(`未提交改动: ${st.changed} 个文件`, ...(st.pending || []).map((l) => '  ' + l))
      else lines.push('未提交改动: 无')
      if (!gitAvailable()) lines.push('（系统没有 git：快照已停用）')
      out.text = lines.join('\n')
      return out
    },
  })

  // ── kb_init ──────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_init',
    description:
      '建 .nodekb 骨架（幂等，已有的不覆盖）：默认铺 doc/ lessons/ todo/ index/entry.md + 落位约定' +
      '（parts 可选，如 ["doc","index"]）；' +
      'dir 是**库目录本身**（通常 .nodekb）；传上级目录会被拒（目录里已有 README.md/doc/ 时），不会把骨架散进项目根。' +
      '准备手写 docs/*.md 之前先调这个；已有 .nodekb/ 就别调（先 kb_list 看）。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '库目录本身（相对工作区，默认 .nodekb）。要建在技能目录下就传 .dsh/skills/<技能>/.nodekb；别传上级目录。',
        },
        parts: {
          type: 'array',
          items: { type: 'string' },
          description: '要铺的目录组，缺省则全铺：doc（doc/00-overview.md）、index（index/entry.md）、lessons、todo。README.md 与 diag_ignore.json 总是铺。',
        },
      },
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const src = workspaceSource(config, exec)
      const ws = src.path
      const rel = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : '.nodekb'
      const target = path.resolve(ws, rel)
      const otherWorkspace = workspaceRoots().find((r) => r !== ws && isInside(target, r))
      if (otherWorkspace) {
        throw new Error(
          `拒绝把库建在另一个已登记的工作区里: ${target}\n` +
            `本会话判定的工作区 = ${ws}（来源: ${src.from}）\n` +
            `目标却落在 = ${otherWorkspace}\n` +
            `如果确实要建在那个项目里，请在那个项目下开会话再执行；如果只是想在本会话工作区里建，传相对路径（如 .nodekb 或 .dsh/skills/<技能>/.nodekb）。`,
        )
      }
      const okRoot = allowedRoots(config, exec).some((r) => isInside(target, r))
      if (!okRoot) {
        throw new Error(
          `拒绝在工作区外建库: ${target}\n` +
            `本会话工作区 = ${ws}（来源: ${src.from}）\n` +
            `允许范围 = 该工作区 + 已登记工作区 + 已注册库：\n  - ` +
            allowedRoots(config, exec).join('\n  - '),
        )
      }
      // 最容易踩的坑：把「上级目录」当库目录传进来，骨架就散进项目根（README.md / doc / index），
      // 之后还得手工清。目录里已经有一份像样的 md 结构、又不是 `.nodekb` 本身 → 直接拒并给正确写法。
      if (looksLikeExistingProject(target)) {
        throw new Error(
          `kb_init 的 dir 是**库目录本身**（通常就是 \`.nodekb\`），不是它的上级目录。\n` +
            `你传的 ${target} 里已经有 README.md 或 doc/ 之类的目录了——在这里铺骨架会把文件散在项目根。\n` +
            `正确写法：dir=${path.join(rel, '.nodekb')}（或直接用默认的 .nodekb）；\n` +
            `要建在技能目录下：dir=.dsh/skills/<技能>/.nodekb。`,
        )
      }
      const res = scaffold(target, { parts: Array.isArray(args.parts) ? args.parts : undefined })
      const gitMsg = config.git === false ? '跳过（config.git=false）' : gitInit(res.nodekb)
      markSeen(res.nodekb)
      const lines = [`库目录: ${res.nodekb}`, `工作区: ${ws}（来源: ${src.from}）`, `版本控制: ${gitMsg}`]
      lines.push(res.created.length ? `新建 ${res.created.length} 个文件:\n` + res.created.map((f) => '  + ' + f).join('\n') : '没有新建文件（骨架已存在）')
      if (res.skipped.length) lines.push(`跳过 ${res.skipped.length} 个已存在文件: ${res.skipped.join('、')}`)
      lines.push('')
      lines.push('下一步：把这次要记的东西用 kb_write 写进对应目录（先读 .nodekb/README.md 的落位表），写完 kb_diag 一遍。')
      lines.push('提示：文件名建议用 ASCII（中文标题写进 # 一级标题里），Windows 控制台显示中文路径会乱码。')
      return { text: lines.join('\n'), nodekb: res.nodekb, workspace: ws, workspaceFrom: src.from, created: res.created, skipped: res.skipped }
    },
  })

  // ── kb_register ──────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_register',
    description:
      '把一个已存在的 .nodekb 库登记进当前项目的 kb_registry.json，之后就能用库名访问它。' +
      '只写项目内文件，不改全局注册表、不改插件配置。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '库所在目录（含 .nodekb 的那一层）；绝对路径或相对本会话工作区。也可以直接传 .nodekb 目录。',
        },
        name: { type: 'string', description: '库名，缺省取目录名。' },
        hidden: { type: 'boolean', description: '登记但不出现在库列表里（给老文档里的别名用）。' },
      },
      required: ['dir'],
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const src = workspaceSource(config, exec)
      const ws = src.path
      const raw = typeof args.dir === 'string' ? args.dir.trim() : ''
      // 只有「明确指向某个绝对路径」才让面板跟上；相对路径是猜的，不要污染工作区记忆。
      if (path.isAbsolute(raw)) rememberWorkspace(ws)
      if (!raw) throw new Error('dir 不能为空：传库所在目录（含 .nodekb 的那一层）')
      const p = path.resolve(ws, raw)
      const dir = path.basename(p) === '.nodekb' ? path.dirname(p) : p
      const nodekb = path.join(dir, '.nodekb')
      let isDirNow = false
      try {
        isDirNow = fs.statSync(nodekb).isDirectory()
      } catch {
        isDirNow = false
      }
      if (!isDirNow) throw new Error(`这里没有 .nodekb: ${nodekb}（先 kb_init 建库，或确认目录）`)
      const name = (typeof args.name === 'string' && args.name.trim()) || path.basename(dir)
      const res = writeProjectRegistry({ workspace: ws, name, dir, hidden: args.hidden === true })
      const lines = [
        `已登记: ${res.name} → ${res.path}${res.replaced ? '（覆盖了同名登记）' : ''}`,
        `写入: ${res.file}`,
        `之后可直接用 kb="${res.name}"；这个文件建议随仓库一起提交，换台机器就能用。`,
      ]
      return { text: lines.join('\n'), name: res.name, dir: res.path, file: res.file }
    },
  })

  // ── kb_write ─────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_write',
    description:
      '写库并立刻自检。写前会校验 TID 与 <node> 规范。' +
      'mode=append（追加，不存在则建）| replace（整篇）| create（只新建）| node（就地改一个 <node> 块；target 也可以是 `##` 段节点的 TID）。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            '库内相对路径（如 lessons/xxx.md；不带扩展名时按 .md 补）或节点 TID。' +
            'mode=node 时收：`<node>` 的 TID、`##` 段节点 TID。' +
            '文件节点的 TID 会拒绝——整篇正文改用相对路径 + mode=replace。' +
            '段内已有 <node>/<tscl> 或更深标题（`###`…）时会拒绝——改用路径 + mode=replace。',
        },
        content: {
          type: 'string',
          description:
            '要写入的 Markdown。node 模式下是节点正文：首行若给同级或更浅的标题，就连标题一起换；' +
            '给与本段同名的标题会被剥掉（kb_read 渲染回来就带标题）；给更深的标题会被拒绝。' +
            'CRLF 会归一成 LF、落盘按原文件的换行写回；' +
            '`<node>` / `<tscl>` 开标签要求成对（单行 `<node name="x">正文</node>`；只有 mode=replace 整篇重写不受成对检查限制）。',
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace', 'create', 'node'],
          description: '默认：路径→append，TID→node。create 遇到已存在会报错，避免覆盖。',
        },
        kb: KB_PARAM,
      },
      required: ['target', 'content'],
    },
    output: {
      schema: {},
      render: renderStructured,
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const res = writeInto(lib, args)
      // 写后重开（签名变了会重新解析），把结构问题当场报回来
      let report = null
      try {
        const fresh = openLibrary(config, exec, { kb: args.kb, lib: args.lib })
        report = diag(fresh.nodes, { problems: fresh.problems, libRoot: fresh.nodekb, defs: fresh.defs })
      } catch (e) {
        report = { report: { errors: [`写后解析失败: ${e.message}`], warnings: [], node_count: 0 }, code: 2 }
      }
      const r = report.report || report
      const errs = r.errors || []
      const warns = r.warnings || []
      // 先自检、再快照：结构写坏的那一版不该进历史（回滚目标始终是上一个好状态）。
      const snap = config.git === false || errs.length ? '' : maybeAutosnap(lib.nodekb)
      const lines = [`已写入 ${res.rel}（${res.bytes} 字节，mode=${res.mode}${res.created ? '，新建文件' : ''}）`]
      if (res.tid) lines.push(`节点: ${res.tid}`)
      if (snap) lines.push(`快照: ${snap}`)
      else if (config.git !== false && errs.length) lines.push('未快照：写后自检有 error，修好后的下一次写入会一并快照')
      lines.push(`库状态: ${r.node_count ?? '?'} 节点，${errs.length} error / ${warns.length} warning`)
      if (errs.length) lines.push('需要修:\n' + errs.slice(0, 6).map((e) => '  ✗ ' + e).join('\n'))
      if (warns.length) lines.push('提示:\n' + warns.slice(0, 4).map((w) => '  ! ' + w).join('\n'))
      return { text: lines.join('\n'), path: res.rel, mode: res.mode, snapshot: snap || '', errors: errs.length, warnings: warns.length }
    },
  })

  // 逐个注册、逐个兜底：宿主若因为某一条定义（schema/字段改名）拒收，
  // 只有那一个工具消失，其余照旧可用（整批 map 会让一处失败带走全部 10 个）。
  const disposers = []
  const failed = []
  for (const t of tools) {
    try {
      const d = ctx.tools.register(t)
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      failed.push(t.name)
      console.warn(`[project-node-memory] 工具 ${t.name} 注册失败，其余工具继续：`, e && e.message)
    }
  }
  if (failed.length) {
    Object.assign(TOOL_STATE, { registered: tools.length - failed.length, failed })
  } else {
    Object.assign(TOOL_STATE, { registered: tools.length, failed: [] })
  }
  return disposers
}


