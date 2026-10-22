/**
 * tools —— 注册 6 个 kb_* 工具（纯 JS，不 import 任何 @deepseek-ai/* 包）。
 *
 * 工具契约（与宿主 registry 结构兼容）：
 *   { name, description, parameters: raw JSON Schema, output: { schema, render(args,value) }, execute(args,exec) }
 *
 * 设计取向：description 本身就是 prompt，所以它要写清楚「什么时候用我、什么时候别用我」。
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { render_node, render_subtree, toc_lines, node_info, resolve_path } from '../engine/render.js'
import { search, formatSearch } from '../engine/search.js'
import { diag } from '../engine/diag.js'
import { extractRefs } from '../engine/parse.js'
import { renameFileNode, formatRename } from '../engine/rename.js'
import { scaffold } from '../engine/scaffold.js'
import { writeInto } from '../engine/write.js'
import { isInside } from '../engine/registry.js'
import { openLibrary, workspaceOf, libraryHint, knownLibraries } from './runtime.js'

const DEFAULT_MAXLEN = 50000

/** 最近一次批量注册的结果（给 /nodekb/api/tools 自证用） */
const TOOL_STATE = { registered: 0, failed: [] }

export function toolState() {
  return { registered: TOOL_STATE.registered, failed: [...TOOL_STATE.failed] }
}

const KB_PARAM = {
  type: 'string',
  description: '库名（注册表里的名字，或工作区自带的 workspace）。省略则用工作区 .nodekb；都不存在时用唯一已注册的库。',
}
const LIB_PARAM = {
  type: 'string',
  description: '库根路径的备用写法：技能目录或其下的 .nodekb 绝对路径（也可相对工作区）。仅当库没有注册名时使用。',
}

function text(t) {
  return [{ type: 'text', text: t }]
}

function warnPrefix(lib) {
  if (!lib.problems || !lib.problems.length) return ''
  return `⚠ 库有 ${lib.problems.length} 处 TID 冲突，已跳过冲突项：\n  - ${lib.problems.slice(0, 5).join('\n  - ')}\n\n`
}

/** 允许建库/写库的根：工作区 + 所有已注册库（技能目录也在其中） */
function allowedRoots(config, exec) {
  try {
    return knownLibraries(config, exec)
      .map((r) => r.path || r.nodekb)
      .filter((p) => typeof p === 'string' && p)
  } catch {
    return []
  }
}

/** 库定位失败时补一句「有哪些库可用」，别让模型瞎猜 */
function locate(config, exec, args) {
  try {
    return openLibrary(config, exec, { kb: args.kb, lib: args.lib })
  } catch (e) {
    const hint = libraryHint(config, exec)
    const err = new Error(`${e.message}${hint ? `\n${hint}` : ''}`)
    err.cause = e
    throw err
  }
}

export function buildTools(ctx, config) {
  const tools = []

  // ── kb_list ──────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_list',
    description:
      '列出当前可用的 nodekb 知识库（名字 + 路径 + 是否存在），以及本次调用实际会命中的默认库。' +
      '不确定该传什么 kb 参数时先调它。只读、极轻量。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute() {
      const rows = knownLibraries(config, null)
      const lines = ['可用于 kb_* 工具的 nodekb 库：']
      if (!rows.length) {
        lines.push('  （无）在工作区建 .nodekb/ 并放入 md 文件，或在插件配置 config.libraries / config.registries 里登记。')
      }
      for (const r of rows) {
        lines.push(`- ${r.name}  ${r.path}${r.exists ? '' : '  [路径不存在]'}${r.origin === 'workspace' ? '  （工作区默认）' : ''}`)
      }
      return { text: lines.join('\n'), libs: rows }
    },
  })

  // ── kb_read ──────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_read',
    description:
      '读取 nodekb 知识库的一个节点。target 是 TID（如 doc:03-工程经验与坑:3.1）或唯一前缀（如 3.1 不行、doc:03 可以）。' +
      'mode 默认 subtree = 整支渲染（本节点的 [[TID]] 引用就地展开成内容，再递归子节点）；' +
      'toc = 只看结构不看正文（每个节点一行：tid · 标题 · 字符数，适合先定位再读）；' +
      'node = 只读本节点自身（不含子节点，也不展开子节）；raw = 元信息 + 原始内容（含未展开的 [[TID]]）。' +
      '比 read 工具好在：一次拿到装配好的上下文，且 TID 不受文件行号漂移影响。超过 maxlen 会报错并提示改用 toc/node。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '节点 TID 或其唯一前缀。空字符串或 "." 表示库根。' },
        kb: KB_PARAM,
        lib: LIB_PARAM,
        mode: {
          type: 'string',
          enum: ['subtree', 'node', 'toc', 'raw'],
          description: 'subtree（默认，整支投影）| node（仅本节点）| toc（目录视图）| raw（元信息+原文）',
        },
        maxlen: { type: 'integer', description: '整支渲染的字符上限，默认 50000；传 0 表示不限。只对 mode=subtree 生效。' },
      },
      required: ['target'],
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const target = String(args.target ?? '').trim() || 'root'
      const mode = args.mode || 'subtree'
      const maxlen = args.maxlen === undefined ? DEFAULT_MAXLEN : Number(args.maxlen) || 0

      const tid = resolve_path(lib.nodes, target)
      if (tid === null) {
        const cands = [...lib.nodes.keys()].filter((t) => t.startsWith(target) || t.startsWith(target + ':')).sort().slice(0, 10)
        throw new Error(`未找到节点: ${target}${cands.length ? `；候选: ${cands.join('、')}` : ''}`)
      }

      let out
      const ctx = { defs: lib.defs, libRoot: lib.nodekb }
      if (mode === 'toc') {
        out = toc_lines(lib.nodes, tid).join('\n')
      } else if (mode === 'raw') {
        out = JSON.stringify(node_info(lib.nodes, tid), null, 2)
      } else if (mode === 'node') {
        out = render_node(lib.nodes, tid, ctx)
        const kids = [...lib.nodes.values()].filter((c) => c.parent_tid === tid).length
        if (kids) out += `\n\n（本节点含 ${kids} 个子节：正文在子节里；看结构用 mode=toc，看整支不传 mode）`
      } else {
        out = render_subtree(lib.nodes, tid, 1, ctx)
        if (maxlen && out.length > maxlen) {
          throw new Error(
            `渲染超上限: ${out.length} 字符 > ${maxlen}。建议 mode=node 单节点、先 mode=toc 看结构、或指定小节 tid；` +
              `确实要整支就传 maxlen=0。`,
          )
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
      '在 nodekb 知识库里检索（中文自然语言可用：连续中文按 2-gram 拆分并过滤虚词，多词命中加权，无命中时退化为整句子串匹配）。' +
      '返回每条命中的稳定 TID（positional=true 表示命中的是位置型段落，tid 已上溯到文件/显式节点，ref 是实际命中点）、类型、标题、源文件行号与命中片段。' +
      '用 kb_search 找到 tid，再用 kb_read 读，比 grep 后逐个 read 省往返。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词或自然语言问句。' },
        kb: KB_PARAM,
        lib: LIB_PARAM,
        type: { type: 'string', description: '只保留该类型的节点（如 doc / todo / handover）。' },
        limit: { type: 'integer', description: '返回条数上限，默认 10。' },
        offset: { type: 'integer', description: '跳过前 N 条，用于翻页。' },
        snippet: { type: 'integer', description: '命中片段窗口字符数，默认 240。' },
      },
      required: ['query'],
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const res = search(lib.nodes, String(args.query ?? ''), {
        type: args.type,
        limit: args.limit === undefined ? 10 : Number(args.limit),
        offset: args.offset === undefined ? 0 : Number(args.offset),
        snippet: args.snippet === undefined ? 240 : Number(args.snippet),
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
      '知识库结构自检。errors = 真损坏（悬空引用 [[TID]]、引用位置型段落 TID、循环引用、孤儿节点、树环、重复 TID）；' +
      'warnings = 疑似内容漂移（同一段文字出现在多个节点 / 节点内重复行），默认不影响结论。' +
      '改完 md 之后跑一次，比人工核对可靠。库根可放 diag_ignore.json 豁免样板块。',
    parameters: {
      type: 'object',
      properties: {
        kb: KB_PARAM,
        lib: LIB_PARAM,
        strict: { type: 'boolean', description: '严格模式：把 warnings 也算失败。' },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const { report, code } = diag(lib.nodes, { problems: lib.problems, strict: !!args.strict, libRoot: lib.nodekb, defs: lib.defs })
      const text_ = JSON.stringify(report, null, 2)
      if (code !== 0) {
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
      '反查：谁引用了这个节点（[[TID]] 指向它）。改 TID / 删节点之前先跑，能一次列出所有会断的地方——' +
      '比全库 grep 更准（只认真实引用语法，不受正文里偶然出现的同名文字干扰）。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '节点 TID 或其唯一前缀。' },
        kb: KB_PARAM,
        lib: LIB_PARAM,
      },
      required: ['target'],
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const tid = resolve_path(lib.nodes, String(args.target ?? ''))
      if (tid === null) throw new Error(`未找到节点: ${args.target}`)
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
      '重命名库里的一个 md 文件，并把全库指向它的 [[TID]] 引用一起改写（含 [[tid:1.2]] 这种子节点引用）。' +
      'nodekb 的 TID 由文件名派生，所以「用 mv / 编辑器改名」必然留下一堆悬空引用；要么用这个工具，' +
      '要么改名后自己跑 kb_diag 逐个修。写前会重读校验，别人刚改过的文件不覆盖、只报出来。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '文件节点的 TID（kb_read --toc 里的 doc:03-x），或相对路径 doc/03-x.md。' },
        new_name: { type: 'string', description: '新文件名（.md 可省略，不能带目录）。' },
        dry_run: { type: 'boolean', description: 'true = 只报「会改哪些引用」，不动文件。' },
        kb: KB_PARAM,
        lib: LIB_PARAM,
      },
      required: ['target', 'new_name'],
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const report = renameFileNode(lib, String(args.target ?? ''), String(args.new_name ?? ''), {
        dryRun: Boolean(args.dry_run),
      })
      return { ...report, kb: lib.name, text: warnPrefix(lib) + formatRename(report) }
    },
  })

  // ── kb_vcs_status ────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_vcs_status',
    description:
      '查看知识库内嵌 git 仓库的状态（最近提交 + 未提交改动）。nodekb 每次解析后会自动快照，' +
      '所以这里能看到「库的改动历史」；文件系统上有改动但没进快照时也会列出来。git 不可用时返回说明而不报错。',
    parameters: {
      type: 'object',
      properties: {
        kb: KB_PARAM,
        lib: LIB_PARAM,
      },
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute(args, exec) {
      const lib = locate(config, exec, args)
      const git = (argv) =>
        execFileSync('git', ['-C', lib.nodekb, ...argv], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim()
      const out = { kb: lib.name, nodekb: lib.nodekb, initialized: false, head: null, log: [], dirty: false, files: 0 }
      try {
        out.initialized = git(['rev-parse', '--is-inside-work-tree']) === 'true'
      } catch {
        out.text = `库 ${lib.name} 未初始化 git（或系统没有 git）。读取与检索不受影响；要历史快照请手动 git init ${lib.nodekb}。`
        return out
      }
      try {
        out.head = git(['rev-parse', '--short', 'HEAD'])
        out.log = git(['log', '--pretty=%h %ad %s', '--date=short', '-n', '8']).split('\n').filter(Boolean)
      } catch {
        /* 空仓库：还没有提交 */
      }
      try {
        const porcelain = git(['status', '--porcelain'])
        const lines = porcelain ? porcelain.split('\n').filter(Boolean) : []
        out.dirty = lines.length > 0
        out.files = lines.length
        out.pending = lines.slice(0, 10)
      } catch {
        /* ignore */
      }
      const lines = [`库 ${lib.name}（${lib.nodekb}）`, `HEAD: ${out.head || '(无提交)'}`]
      if (out.log.length) lines.push('最近提交:', ...out.log.map((l) => '  ' + l))
      if (out.dirty) lines.push(`未提交改动: ${out.files} 个文件`, ...(out.pending || []).map((l) => '  ' + l))
      else lines.push('未提交改动: 无')
      out.text = lines.join('\n')
      return out
    },
  })

  // ── kb_init ──────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_init',
    description:
      '为一个项目建 .nodekb 知识库骨架（幂等：已存在的文件不覆盖）。' +
      '当用户要在项目里沉淀长期知识、而你准备开始写第一份文档之前，先调这个——' +
      '它一次铺出 doc/ facts/ lessons/ todo/ index/entry.md 与 .nodekb/README.md 里的落位约定，' +
      '比你自己拿 write 从零设计目录结构更省事，也让后续 Agent 知道该往哪写。' +
      '已经有 .nodekb/ 就不要调（先用 kb_list 看）。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '库目录（相对工作区，默认 .nodekb）。要建在技能目录下就传 .dsh/skills/<技能>/.nodekb。',
        },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
    },
    async execute(args, exec) {
      const ws = workspaceOf(config, exec)
      const rel = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : '.nodekb'
      const target = path.resolve(ws, rel)
      const okRoot = isInside(target, ws) || allowedRoots(config, exec).some((r) => isInside(target, r))
      if (!okRoot) throw new Error(`拒绝在工作区外建库: ${target}`)
      const res = scaffold(target)
      const lines = [`库目录: ${res.nodekb}`]
      lines.push(res.created.length ? `新建 ${res.created.length} 个文件:\n` + res.created.map((f) => '  + ' + f).join('\n') : '没有新建文件（骨架已存在）')
      if (res.skipped.length) lines.push(`跳过 ${res.skipped.length} 个已存在文件: ${res.skipped.join('、')}`)
      lines.push('')
      lines.push('下一步：把这次要记的东西用 kb_write 写进对应目录（先读 .nodekb/README.md 的落位表），写完 kb_diag 一遍。')
      return { text: lines.join('\n'), nodekb: res.nodekb, created: res.created, skipped: res.skipped }
    },
  })

  // ── kb_write ─────────────────────────────────────────────────────────────
  tools.push({
    name: 'kb_write',
    description:
      '往 nodekb 库里写内容，并在写后立刻自检（悬空引用/位置型引用/重复块）。' +
      '这是「用知识库管知识」的正路：同样写 md，但写前校验 TID 与 <node> 独占一行，写后把结构错误当场报回来；' +
      '直接用 write/edit 没有这一层。' +
      'mode=append 追加到文件（不存在则创建）、replace 整篇覆盖、create 只新建、node 就地改写一个 <node> 块。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '库内相对路径（如 lessons/003-cp936.md，建议带 .md）或显式节点 TID（如 fact:abi，配 mode=node）。',
        },
        content: { type: 'string', description: '要写入的 Markdown。node 模式下是 <node> 与 </node> 之间的正文。' },
        mode: {
          type: 'string',
          enum: ['append', 'replace', 'create', 'node'],
          description: '默认：路径→append，TID→node。create 遇到已存在会报错，避免覆盖。',
        },
        kb: KB_PARAM,
        lib: LIB_PARAM,
      },
      required: ['target', 'content'],
    },
    output: {
      schema: {},
      render: (_args, value) => text(value.text),
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
      const lines = [`已写入 ${res.rel}（${res.bytes} 字节，mode=${res.mode}${res.created ? '，新建文件' : ''}）`]
      if (res.tid) lines.push(`节点: ${res.tid}`)
      lines.push(`库状态: ${r.node_count ?? '?'} 节点，${errs.length} error / ${warns.length} warning`)
      if (errs.length) lines.push('需要修:\n' + errs.slice(0, 6).map((e) => '  ✗ ' + e).join('\n'))
      if (warns.length) lines.push('提示:\n' + warns.slice(0, 4).map((w) => '  ! ' + w).join('\n'))
      return { text: lines.join('\n'), path: res.rel, mode: res.mode, errors: errs.length, warnings: warns.length }
    },
  })

  // 逐个注册、逐个兜底：宿主若因为某一条定义（schema/字段改名）拒收，
  // 只有那一个工具消失，其余照旧可用（整批 map 会让一处失败带走全部 9 个）。
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


