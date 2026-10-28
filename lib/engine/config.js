/**
 * config —— 让命令行与工具层认同一套库名（1.5.15 起）。
 *
 * 起因：工具层（宿主里的 kb_*）拿的是 DSH 插件配置（`cordis.patch.yml` 的
 * `- id: nodekb` → `config.libraries` / `config.registries`），而 `nodekb` 命令行是
 * 另一个进程，读不到那份配置——于是同一个库，工具层认注册名 `filmmeasure`，
 * 命令行报「未注册的库 filmmeasure」，只能每次都手写绝对路径。
 *
 * 做法：插件在宿主里启动时把**生效配置**抄一份到 `~/.dsh/nodekb/config.json`
 * （只读字段：registries / libraries / workspace / exclude / advice），命令行启动时读它。
 * 这是唯一的方向（插件 → 文件 → CLI），不反向依赖 YAML 解析——DSH 的
 * `cordis.patch.yml` 是带注释和外挂格式的 YAML，自己解析只会随版本漂。
 *
 * 优先级：环境变量 `NODEKB_CONFIG` → `~/.dsh/nodekb/config.json` → 空配置。
 * 多 profile（desktop / web）并存时后写者覆盖：这个文件只当「默认约定」用，
 * 需要精确控制时仍可在命令行传 `--kb <路径>` 或设 `NODEKB_CONFIG`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const STATE_DIR = path.join(os.homedir(), '.dsh', 'nodekb')
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json')

/** 能从插件配置里安全抄出来的字段（其余是宿主内部用的，抄出去只会误导） */
const KEEP = ['registries', 'libraries', 'workspace', 'exclude', 'advice']

function pick(cfg) {
  const out = {}
  for (const k of KEEP) {
    const v = cfg && cfg[k]
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out
}

/**
 * 插件启动时调用：把生效配置落到 `~/.dsh/nodekb/config.json`。
 * 失败一律静默——配置文件写不了不该影响插件启动（只读文件系统、只读 home 都可能）。
 * @returns {{file:string, written:boolean}|null}
 */
export function rememberConfig(config, { file = process.env.NODEKB_CONFIG || CONFIG_FILE } = {}) {
  try {
    const data = pick(config)
    const next = JSON.stringify({ updated_at: new Date().toISOString(), ...data }, null, 2) + '\n'
    let prev = ''
    try {
      prev = fs.readFileSync(file, 'utf8')
    } catch {
      prev = ''
    }
    if (prev) {
      try {
        const old = JSON.parse(prev)
        if (JSON.stringify(pick(old)) === JSON.stringify(data)) return { file, written: false }
      } catch {
        /* 旧文件坏了就覆盖 */
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, next, 'utf8')
    return { file, written: true }
  } catch {
    return null
  }
}

/**
 * 命令行启动时调用：读回插件抄下来的配置。
 * 没有文件 / 文件坏了 → `{}`（命令行仍能按当前目录发现库、按路径显式打开）。
 * @returns {{registries?:string[], libraries?:object, workspace?:string, exclude?:string[], advice?:object}}
 */
export function loadConfig({ file = process.env.NODEKB_CONFIG || CONFIG_FILE } = {}) {
  try {
    // 剥 BOM：PowerShell 的 `Set-Content -Encoding utf8` / 记事本存出来的 JSON 带 BOM，
    // JSON.parse 直接抛错，于是「明明配好了」却一个库都不认。
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return pick(data)
  } catch {
    return {}
  }
}
