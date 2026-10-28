/**
 * notice —— 「插件版本变了、这个库还没按新版本体检过」这条一次性提醒。
 *
 * 1.5.15 及以前这段逻辑长在 `lib/host/tools.js` 里，于是**只有工具层**会出这条提醒：
 * 同一个库，`kb_diag` 有、`nodekb diag --kb …` 没有。两层输出不同构，Agent 换个入口
 * 就少一条信号。搬到引擎里，由工具层与命令行共同调用。
 */

import fs from 'node:fs'
import path from 'node:path'

export const STATE_FILE = '.plugin-state.json'

/** 插件自己的版本号（拿不到就 0.0.0，不影响任何功能）。 */
export function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 记下「这个库已经被当前版本体检过」，并保证状态文件不进 git。 */
export function markSeen(nodekb) {
  try {
    const state = path.join(nodekb, STATE_FILE)
    fs.writeFileSync(state, JSON.stringify({ seen_version: pkgVersion(), at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
    excludeFromGit(nodekb)
  } catch {
    /* 状态文件写不了不影响任何功能 */
  }
}

/**
 * 用 `.git/info/exclude` 忽略状态文件，而不是往 `.gitignore` 里追加。
 * 后者改的是**被跟踪的文件**，于是升级后第一次 kb_diag 就把库弄成「有未提交改动」，
 * 直到下次 kb_write 才被 autosnap 顺手提交 —— 诊断工具不该改动工作树。
 */
function excludeFromGit(nodekb) {
  try {
    const gitDir = path.join(nodekb, '.git')
    let dir = gitDir
    // 工作树的 .git 是个文件（内容 `gitdir: …`）
    try {
      if (!fs.statSync(gitDir).isDirectory()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))
        if (!m) return
        dir = path.resolve(nodekb, m[1].trim())
      }
    } catch {
      return
    }
    const ex = path.join(dir, 'info', 'exclude')
    fs.mkdirSync(path.dirname(ex), { recursive: true })
    let cur = ''
    try {
      cur = fs.readFileSync(ex, 'utf8')
    } catch {
      cur = ''
    }
    if (cur.split(/\r?\n/).some((l) => l.trim() === STATE_FILE)) return
    const tail = cur && !cur.endsWith('\n') ? cur + '\n' : cur
    fs.writeFileSync(ex, tail + STATE_FILE + '\n', 'utf8')
  } catch {
    /* 没有 git / 无权限：状态文件最多显示成未跟踪，不影响功能 */
  }
}

/** 插件版本变了、这个库还没被新版本看过 → 返回一条一次性提醒。 */
export function updateNotice(nodekb) {
  let seen = null
  let hasState = false
  try {
    const raw = fs.readFileSync(path.join(nodekb, STATE_FILE), 'utf8')
    hasState = true
    seen = JSON.parse(raw).seen_version || ''
  } catch {
    // 没有状态文件 = 1.5.0 之前建的库（那时还不写状态）：同样要提醒一次，否则它永远静默。
    hasState = false
  }
  const now = pkgVersion()
  if (hasState && seen === now) return null
  markSeen(nodekb)
  const from = hasState && seen ? seen : '1.5.0 之前'
  return {
    code: 'plugin-updated',
    message: `插件 ${from} → ${now}：知识库规则有更新，这个库还没按新版本体检过`,
    fix: '读一次 skill `project-node-memory-guide`（细则都在里面），再按本报告的 advice 逐条处理。（注意不要影响当前工作，可先列入 todo）',
  }
}
