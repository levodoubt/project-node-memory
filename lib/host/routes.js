/**
 * routes —— 给浏览器面板用的只读 HTTP API（前缀 /nodekb/api）。
 *
 * 宿主侧与客户端唯一允许的通信方式：插件自己注册的路由。
 * 全部只读；写操作走 write/edit 工具改 md，不需要这里开写接口。
 */

import fs from 'node:fs'
import path from 'node:path'
import { render_node, render_subtree, toc_tree, node_info, resolve_path } from '../engine/render.js'
import { search, formatSearch } from '../engine/search.js'
import { diag } from '../engine/diag.js'
import { extractRefs } from '../engine/parse.js'
import { computeAdvice } from '../engine/advice.js'
import { refsToDef, formatDefRead } from '../engine/defs.js'
import { renameFileNode, formatRename } from '../engine/rename.js'
import { openLibrary, knownLibraries, whereInfo, workspaceOf } from './runtime.js'
import { promptState } from './prompt.js'
import { skillState } from './skill.js'
import { toolState } from './tools.js'
import { discoverLibraries } from '../engine/registry.js'

const PREFIX = '/nodekb/api'

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 从 source（`path#L12` / `path#L1-L30`）里取出源文件与行范围 */
export function parseSource(source) {
  const s = String(source || '')
  const hash = s.lastIndexOf('#')
  if (hash < 0) return null
  const file = s.slice(0, hash)
  const m = /^L(\d+)(?:-L(\d+))?$/.exec(s.slice(hash + 1))
  if (!file || !m) return null
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : start
  return { file, start, end }
}

// 路由只能注册一次（同类前缀重名会被 webServer 拒掉），但代码会被反复重载。
// 中间这一跳让"第一个注册成功的路由"始终把请求转给"最新装载的处理器"，
// 这样升级插件不需要重启 DSH 也能换上新逻辑。
const LIVE_HANDLER = Symbol.for('project-node-memory.live-handler.v1')
// 改名前装过旧版（行 id dsh-nodekb）时，旧 route 的闭包还在用的旧符号。
// 两边同时写，旧 route 才能把请求转给新版处理器 —— 改名的升级不需要重启。
const LIVE_HANDLER_OLD = Symbol.for('dsh-nodekb.live-handler.v1')

// 最近一次浏览器半边的自证（GET /nodekb/api/client-report）
let CLIENT_REPORT = null

export function registerRoutes(ctx, config) {
  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      send(res, 400, { error: 'bad url' })
      return
    }
    const q = url.searchParams
    const kb = q.get('kb') || undefined
    const libPath = q.get('lib') || undefined
    // 面板没有会话上下文：允许前端显式给一个工作区（人指定一次，存在 localStorage）
    const wsParam = q.get('ws') || undefined
    const exec = wsParam ? { cwd: wsParam } : null
    // 面板给 ws 是显式选择，别拿它覆盖 Agent 侧记住的默认工作区
    const open = () => openLibrary(config, exec, { kb, lib: libPath, remember: !wsParam })

    try {
      if (url.pathname === `${PREFIX}/version`) {
        // 探针用：确认活着的处理器是哪一版（插件热载后老路由可能还在）
        let pkg = {}
        try {
          pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
        } catch {
          /* 读不到就只报进程信息 */
        }
        send(res, 200, { name: pkg.name, version: pkg.version, node: process.version, pid: process.pid })
        return
      }

      if (url.pathname === `${PREFIX}/libs`) {
        // scope=workspace：只要当前工作区里的库（面板的「知识库」下拉用它）
        const scope = q.get('scope') === 'workspace' ? 'workspace' : undefined
        send(res, 200, { workspace: workspaceOf(config, exec), libs: knownLibraries(config, exec, { scope }) })
        return
      }

      if (url.pathname === `${PREFIX}/where`) {
        // 诊断：工作区到底是怎么定下来的（面板 / 工具对不上时先看这个）
        send(res, 200, whereInfo(config, exec))
        return
      }

      if (url.pathname === `${PREFIX}/prompt`) {
        // 自证：提示词段落到底有没有被宿主接上（不接上，Agent 就永远优先用 write）
        send(res, 200, promptState())
        return
      }

      if (url.pathname === `${PREFIX}/skill`) {
        // 自证：随包技能（写法规范）有没有进宿主 skill 注册表
        send(res, 200, skillState())
        return
      }

      if (url.pathname === `${PREFIX}/tools`) {
        // 自证：宿主收下了几个 kb_* 工具（被拒收的那条会出现在 failed 里）
        send(res, 200, toolState())
        return
      }

      if (url.pathname === `${PREFIX}/workspaces`) {
        // 面板没有会话上下文，但宿主有 DSH 自己的 workspace 注册表：
        // 把「这个 DSH 用过哪些项目目录」直接给面板，省掉让人手打路径。
        const out = []
        try {
          const reg = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry
          const list = reg && typeof reg.list === 'function' ? reg.list() : []
          for (const w of list || []) {
            const dir = String(w.path || '')
            if (!dir) continue
            let found = 0
            try {
              found = discoverLibraries(dir).length
            } catch {
              found = 0
            }
            out.push({
              id: String(w.id || ''),
              title: String(w.title || ''),
              path: dir,
              nodekb: found > 0,
              libs: found,
            })
          }
        } catch (e) {
          send(res, 500, { error: String((e && e.message) || e), workspaces: [] })
          return
        }
        send(res, 200, { workspaces: out })
        return
      }

      if (url.pathname === `${PREFIX}/tree`) {
        const lib = open()
        send(res, 200, {
          kb: lib.name,
          base: lib.base,
          nodekb: lib.nodekb,
          problems: lib.problems,
          nodeCount: lib.nodes.size,
          tree: toc_tree(lib.nodes, 'root'),
        })
        return
      }

      if (url.pathname === `${PREFIX}/node`) {
        const lib = open()
        const target = q.get('tid') || 'root'
        const mode = q.get('mode') || 'subtree'
        const tid = resolve_path(lib.nodes, target)
        if (tid === null) {
          send(res, 404, { error: `未找到节点: ${target}`, kb: lib.name })
          return
        }
        const node = lib.nodes.get(tid)
        const ctx = { defs: lib.defs, libRoot: lib.nodekb }
        let text
        if (mode === 'node') text = render_node(lib.nodes, tid, ctx)
        else if (mode === 'raw') text = node.content
        else text = render_subtree(lib.nodes, tid, 1, ctx)
        send(res, 200, {
          kb: lib.name,
          ...node_info(lib.nodes, tid),
          kind: node.kind,
          mode,
          text,
          children: [...lib.nodes.values()].filter((c) => c.parent_tid === tid).map((c) => c.tid),
        })
        return
      }

      if (url.pathname === `${PREFIX}/defs`) {
        const lib = open()
        const id = q.get('id')
        if (id) {
          const def = lib.defs.get(id)
          if (!def) {
            send(res, 404, { error: `未找到定义: ${id}`, kb: lib.name })
            return
          }
          const refs = refsToDef(lib.nodes, id, def.ownerTid)
          send(res, 200, {
            kb: lib.name,
            id,
            owner_tid: def.ownerTid,
            owner_title: def.ownerTitle || '',
            source: def.source,
            body: def.body,
            count: def.count,
            refs,
            text: formatDefRead(def, refs),
          })
          return
        }
        const defs = [...lib.defs.values()].map((d) => ({
          id: d.id,
          owner_tid: d.ownerTid,
          source: d.source,
          chars: String(d.body || '').length,
          count: d.count,
        }))
        send(res, 200, { kb: lib.name, count: defs.length, defs })
        return
      }

      if (url.pathname === `${PREFIX}/source`) {
        const lib = open()
        const target = q.get('tid') || 'root'
        const tid = resolve_path(lib.nodes, target)
        if (tid === null) {
          send(res, 404, { error: `未找到节点: ${target}` })
          return
        }
        const src = parseSource(lib.nodes.get(tid).source)
        if (!src) {
          send(res, 404, { error: '该节点没有源文件（文件夹节点）' })
          return
        }
        const all = fs.readFileSync(src.file, 'utf8').replace(/^﻿+/, '').split(/\r\n|\n|\r/)
        // 文件节点给整篇（源里 L1-Ln），段落节点给该行起的一段窗口
        const from = src.start - 1
        const to = Math.min(all.length, src.end > src.start ? src.end : src.start + 60)
        send(res, 200, {
          kb: lib.name,
          path: src.file,
          offset: src.start,
          totalLines: all.length,
          lines: all.slice(from, to).map((textLine, i) => ({ number: from + i + 1, text: textLine })),
        })
        return
      }

      if (url.pathname === `${PREFIX}/search`) {
        const lib = open()
        const query = q.get('q') || ''
        const res0 = search(lib.nodes, query, {
          type: q.get('type') || undefined,
          limit: Number(q.get('limit') || 20),
          offset: Number(q.get('offset') || 0),
        })
        send(res, 200, { kb: lib.name, ...res0, text: formatSearch(query, res0) })
        return
      }

      if (url.pathname === `${PREFIX}/diag`) {
        const lib = open()
        // advice 与 kb_diag 同一套算法，面板才会显示三档（不含 plugin-updated 提醒：
        // 那是一次性状态，读面板不该顺带消费掉它）。
        const advice = computeAdvice(lib.nodes, lib.defs, lib.nodekb, config.advice || {})
        const { report } = diag(lib.nodes, { problems: lib.problems, libRoot: lib.nodekb, defs: lib.defs, advice })
        send(res, 200, { kb: lib.name, ...report })
        return
      }

      if (url.pathname === `${PREFIX}/backlinks`) {
        const lib = open()
        const target = q.get('tid') || ''
        const tid = resolve_path(lib.nodes, target)
        if (tid === null) {
          send(res, 404, { error: `未找到节点: ${target}` })
          return
        }
        const rows = []
        for (const node of lib.nodes.values()) {
          const hit = extractRefs(node.content).some((r) => r.kind !== 'tscl' && r.id === tid)
          if (node.tid !== tid && hit) {
            rows.push({ tid: node.tid, title: node.title, type: node.type, source: node.source })
          }
        }
        send(res, 200, { kb: lib.name, target: tid, backlinks: rows })
        return
      }

      // 客户端自证通道：浏览器半边 POST 自己的加载状态，人/Agent 用 GET 读。
      if (url.pathname === `${PREFIX}/client-report`) {
        if (req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += chunk
          try {
            CLIENT_REPORT = JSON.parse(body || '{}')
          } catch {
            CLIENT_REPORT = { unparsable: String(body).slice(0, 2000) }
          }
          CLIENT_REPORT = { ...CLIENT_REPORT, at: new Date().toISOString() }
          send(res, 200, { ok: true })
          return
        }
        send(res, 200, { report: CLIENT_REPORT })
        return
      }

      if (url.pathname === `${PREFIX}/rename`) {
        const lib = open()
        const report = renameFileNode(lib, q.get('target') || '', q.get('new_name') || '', {
          dryRun: q.get('dry_run') === '1' || q.get('dry_run') === 'true',
        })
        send(res, 200, { kb: lib.name, ...report, text: formatRename(report) })
        return
      }

      send(res, 404, { error: `未知端点: ${url.pathname}` })
    } catch (e) {
      send(res, 400, { error: e && e.message ? e.message : String(e) })
    }
  }

  // 让已注册的那条 route 转发到本次装载的处理器
  globalThis[LIVE_HANDLER] = handler
  globalThis[LIVE_HANDLER_OLD] = handler
  const spec = {
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      const live = globalThis[LIVE_HANDLER] || globalThis[LIVE_HANDLER_OLD]
      return live ? live(req, res) : send(res, 503, { error: 'project-node-memory 未就绪' })
    },
  }
  try {
    return ctx.webServer.register(spec)
  } catch (e) {
    // 升级插件时旧进程里的 route 还没释放，会撞 "duplicate prefix route"。
    // 这不该让整行激活失败（工具仍然可用）；上面的 LIVE_HANDLER 已保证旧 route 也会走到新逻辑。
    if (/duplicate|already registered|conflict/i.test(String((e && e.message) || e))) {
      console.warn(`[project-node-memory] 路由 ${PREFIX} 已由更早的实例注册，本次沿用（请求已转发到最新处理器）。`)
      return () => {
        if (globalThis[LIVE_HANDLER] === handler) delete globalThis[LIVE_HANDLER]
      }
    }
    throw e
  }
}

export { PREFIX }
