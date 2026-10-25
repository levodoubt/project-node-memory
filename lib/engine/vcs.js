/**
 * vcs —— 库内嵌 git 的极薄封装（对应 Python 版 kb/vcs.py）。
 *
 * 设计照着 Python 来，只有一处刻意不同：
 * - Python 在**每次解析库后**尝试快照（read/search/diag 都算）；
 * - 这里只在**写入/改名成功后**快照 —— 每轮都跑 `git status` 对 55 节点的库是 30ms，
 *   对 584 节点的库是上百毫秒，而「读到一半自动提交」本来也没人期待。
 *
 * 所有失败一律静默：没有 git、不是仓库、沙箱不让起进程，都只是少一个快照，读写不受影响。
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const TIMEOUT = 30000
const IDENTITY = ['-c', 'user.name=nodekb', '-c', 'user.email=nodekb@local']

/** 最近一次失败的说明（给 /nodekb/api/vcs 与 kb_vcs_status 用，免得静默到无从查起） */
export const VCS_STATE = { lastError: '', lastCommit: '' }

function run(dir, args) {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: TIMEOUT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out: String(out || '') }
  } catch (e) {
    VCS_STATE.lastError = `git ${args[0]} 失败: ${e && e.message ? String(e.message).split('\n')[0] : e}`
    return { ok: false, out: '' }
  }
}

export function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

/**
 * 库目录**自己**是不是仓库根。
 *
 * 不能只用 `rev-parse --git-dir`：库常放在项目里，那条命令会一路往上找到项目仓库，
 * 于是「给知识库快照」变成「给用户的项目提交『autosnap: N 处变更』」——这条踩过，
 * 项目历史里多了 11 个 autosnap 提交才被发现。
 */
export function isRepo(dir) {
  const r = run(dir, ['rev-parse', '--show-toplevel'])
  if (!r.ok || !r.out.trim()) return false
  const top = path.resolve(r.out.trim())
  const self = path.resolve(dir)
  const same = process.platform === 'win32' ? top.toLowerCase() === self.toLowerCase() : top === self
  return same
}

function changed(dir) {
  const r = run(dir, ['status', '--porcelain'])
  if (!r.ok) return []
  return r.out.split('\n').filter((l) => l.trim())
}

/**
 * 只有「库目录本身叫 `.nodekb`」才允许在这上面跑 git 写入。
 *
 * 第二次踩坑：库路径被人误传成整个项目根时，`add -A` 会把项目源码一起提交进
 * `autosnap: 14 处变更`。知识库的根永远是 `.nodekb/`，不是它的父目录 —— 这一条把
 * 「误把项目仓库当库」挡在提交之前。
 */
function isLibraryDir(dir) {
  return path.basename(path.resolve(dir)) === '.nodekb'
}

/** 初始化内嵌仓库（已存在则跳过）。返回一句人话。 */
export function init(dir) {
  if (!gitAvailable()) return 'git 不可用（已跳过版本控制）'
  if (!isLibraryDir(dir)) return '不是 .nodekb 目录（已跳过版本控制）'
  if (isRepo(dir)) return '已存在 git 仓库'
  if (!run(dir, ['init', '-q']).ok) return 'git init 失败（已跳过）'
  run(dir, ['add', '-A'])
  if (!changed(dir).length) return '已初始化（空库，无初始提交）'
  const c = run(dir, [...IDENTITY, 'commit', '-q', '-m', 'nodekb init'])
  if (c.ok) {
    VCS_STATE.lastCommit = 'nodekb init'
    return '已初始化并提交初始快照'
  }
  return '已初始化（初始提交失败，不影响读写）'
}

export function status(dir) {
  if (!gitAvailable()) return { repo: false, error: '系统没有 git' }
  if (!isRepo(dir)) return { repo: false, error: '非 git 仓库（kb_init 会自动初始化；旧库可手动 git init）' }
  const head = run(dir, ['log', '-1', '--pretty=%h %ad %s', '--date=short'])
  const lines = changed(dir)
  const kinds = {}
  for (const l of lines) {
    const k = l.slice(0, 2).trim() || 'M'
    kinds[k] = (kinds[k] || 0) + 1
  }
  return {
    repo: true,
    last_commit: head.ok && head.out.trim() ? head.out.trim() : '（无提交）',
    changed: lines.length,
    dirty: lines.length > 0,
    kinds,
    pending: lines.slice(0, 10),
  }
}

/** 最近 n 条快照（新的在前）。非仓库/无 git 时返回 []。 */
export function history(dir, n = 5) {
  if (!gitAvailable() || !isRepo(dir)) return []
  const r = run(dir, ['log', `-${Math.max(1, Math.min(50, n))}`, '--pretty=%h %ad %s', '--date=short'])
  if (!r.ok) return []
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean)
}

export function commit(dir, msg) {
  if (!gitAvailable() || !isRepo(dir)) return '非 git 仓库，无法提交'
  run(dir, ['add', '-A'])
  const lines = changed(dir)
  if (!lines.length) return '无变更'
  if (run(dir, [...IDENTITY, 'commit', '-q', '-m', msg]).ok) {
    VCS_STATE.lastCommit = msg
    return `已提交: ${msg}`
  }
  return '提交失败（已忽略）'
}

/**
 * 写入/改名成功后的自动快照。返回 null 表示静默跳过，返回字符串表示做了什么
 * （调用方可以把它塞进工具回执，让 Agent 知道「有快照」）。
 */
export function maybeAutosnap(dir) {
  if (!gitAvailable() || !isLibraryDir(dir) || !isRepo(dir)) return null
  run(dir, ['add', '-A'])
  const lines = changed(dir)
  if (!lines.length) return null
  const msg = `autosnap: ${lines.length} 处变更`
  if (run(dir, [...IDENTITY, 'commit', '-q', '-m', msg]).ok) {
    VCS_STATE.lastCommit = msg
    return msg
  }
  return null
}
