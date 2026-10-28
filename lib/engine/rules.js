/**
 * rules —— 库自己的规矩（`.nodekb/rules.json`）。
 *
 * 为什么需要它：每个项目对知识库都有一套「我们这儿这么写」的约定——ros2 库要求
 * 「只有 doc/ 与 lessons/ 允许展开引用，且目标必须是 fact:*，其余目录写反引号纯文本」，
 * 还定了「单文件 4KB、doc 12KB」。这些以前只能写在各自的 README 里靠人守，
 * 或者由项目自己写脚本 gate。写进库里的规则文件之后，`kb_diag` 就能照着查。
 *
 * 设计原则：
 * - 没有 rules.json 的库行为完全不变（默认零配置、零告警）；
 * - 只做「声明式检查」，不做自动改写：违规报 warning 附文件行号，改不改由人和模型决定；
 * - 关键词只有两个，宁可少而明确：`refStyle`（引用风格）与 `limits.bytes`（文件体积）。
 *
 * ```json
 * {
 *   "refStyle": { "default": "plain", "doc": "expand", "lessons": "expand" },
 *   "limits": { "bytes": { "default": 12288, "lessons": 4096 } }
 * }
 * ```
 *
 * refStyle 的取值：
 * - `expand`：允许 `[[node="…"]]`；`[[tscl="…"]]` 只允许指向 `fact:` 开头的定义
 *   （不许把随手写的常量散在各处展开）。
 * - `plain`：不许写 `[[…]]` 引用，要写就写反引号里的纯文本（TID 仍然可读，只是不建链接）。
 *
 * 目录键：文件相对库根的第一段目录名（`doc`、`lessons`、…）；库根下的散文件用 `.`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { codeRegions, makeFenceTracker } from './parse.js'

export const RULES_FILE = 'rules.json'
export const REF_STYLES = ['plain', 'expand']

/** 文件相对路径 → 规则里的目录键（第一段目录；库根文件是 `.`） */
export function rulesDirKey(rel) {
  const p = String(rel || '').split(path.sep).join('/')
  const i = p.indexOf('/')
  return i < 0 ? '.' : p.slice(0, i)
}

function bad(code, message) {
  return { code, message }
}

/**
 * 读库的规则文件。不存在 → `{ rules: null }`（零配置）；写坏了 → problems 里带一条，
 * 不抛异常（规则文件本身坏掉不该让整个库读不了）。
 * @returns {{ file: string|null, rules: object|null, problems: object[] }}
 */
export function loadRules(libRoot) {
  const out = { file: null, rules: null, problems: [] }
  if (!libRoot) return out
  const file = path.join(libRoot, RULES_FILE)
  if (!fs.existsSync(file)) return out
  out.file = file

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    out.problems.push(bad('rules-invalid', `${RULES_FILE} 不是合法 JSON，本库的规矩未生效：${e.message}`))
    return out
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    out.problems.push(bad('rules-invalid', `${RULES_FILE} 顶层必须是对象（形如 {"refStyle":{…},"limits":{…}}）`))
    return out
  }

  const rules = {}
  for (const key of Object.keys(raw)) {
    if (key !== 'refStyle' && key !== 'limits') {
      out.problems.push(bad('rules-unknown', `${RULES_FILE} 里的未知字段「${key}」被忽略（只认 refStyle / limits）`))
    }
  }

  if (raw.refStyle !== undefined) {
    if (!raw.refStyle || typeof raw.refStyle !== 'object' || Array.isArray(raw.refStyle)) {
      out.problems.push(bad('rules-invalid', `${RULES_FILE} 的 refStyle 必须是对象：{"default":"plain","doc":"expand"}`))
    } else {
      const style = {}
      for (const [dir, val] of Object.entries(raw.refStyle)) {
        if (!REF_STYLES.includes(val)) {
          out.problems.push(
            bad('rules-invalid', `${RULES_FILE} 的 refStyle.${dir} 只能是 ${REF_STYLES.join(' / ')}：「${val}」`),
          )
          continue
        }
        style[dir === '' ? '.' : dir] = val
      }
      rules.refStyle = style
    }
  }

  if (raw.limits !== undefined) {
    const bytes = raw.limits && typeof raw.limits === 'object' ? raw.limits.bytes : undefined
    if (raw.limits && typeof raw.limits === 'object' && Object.keys(raw.limits).some((k) => k !== 'bytes')) {
      out.problems.push(bad('rules-unknown', `${RULES_FILE} 的 limits 只认 bytes，其余字段被忽略`))
    }
    if (bytes !== undefined) {
      if (!bytes || typeof bytes !== 'object' || Array.isArray(bytes)) {
        out.problems.push(bad('rules-invalid', `${RULES_FILE} 的 limits.bytes 必须是对象：{"default":12288,"doc":4096}`))
      } else {
        const limits = {}
        for (const [dir, val] of Object.entries(bytes)) {
          if (!Number.isFinite(val) || val <= 0) {
            out.problems.push(bad('rules-invalid', `${RULES_FILE} 的 limits.bytes.${dir} 必须是正数：「${val}」`))
            continue
          }
          limits[dir === '' ? '.' : dir] = val
        }
        rules.limits = { bytes: limits }
      }
    }
  }

  // 一条规则都没落下来时，把 problems 交回去就够了
  out.rules = Object.keys(rules).length ? rules : null
  return out
}

/** 本文件适用的引用风格；没声明就是 null（不检查） */
function styleFor(rules, dirKey) {
  const style = rules && rules.refStyle
  if (!style) return null
  if (style[dirKey] !== undefined) return style[dirKey]
  return style.default ?? null
}

/** 本文件的体积上限；没声明就是 null */
function bytesFor(rules, dirKey) {
  const bytes = rules && rules.limits && rules.limits.bytes
  if (!bytes) return null
  if (bytes[dirKey] !== undefined) return bytes[dirKey]
  if (bytes['.'] !== undefined) return bytes['.']
  return bytes.default ?? null
}

/** 把一行的行内代码抹成等长空格（围栏由调用方跳过） */
function blankInline(line) {
  const regions = codeRegions(line)
  if (!regions.length) return line
  let out = ''
  let cursor = 0
  for (const [a, b] of regions) {
    if (a < cursor || a >= line.length) continue
    out += line.slice(cursor, a) + ' '.repeat(b - a)
    cursor = Math.min(b, line.length)
  }
  return out + line.slice(cursor)
}

const NODE_REF = /\[\[node\s*=\s*"([^"]+)"\]\]/g
const TSCL_REF = /\[\[tscl\s*=\s*"([^"]+)"\]\]/g

/**
 * @param {Map<string, object>} nodes openLibrary 的结果
 * @param {{refStyle?:object, limits?:object}|null} rules loadRules().rules
 * @param {string} libRoot 库根（`.nodekb`）
 * @returns {{warnings: object[], rewritten: []}} —— 只有 warnings，名字对齐 diag 其它检查
 */
export function checkRules(nodes, rules, libRoot) {
  const warnings = []
  if (!rules || !libRoot) return warnings

  for (const node of nodes.values()) {
    if (node.kind !== 'file') continue
    const abs = String(node.source || '').split('#')[0]
    if (!abs) continue
    const rel = path.relative(libRoot, abs)
    if (!rel || rel.startsWith('..')) continue
    const dirKey = rulesDirKey(rel)
    const relPosix = rel.split(path.sep).join('/')

    const style = styleFor(rules, dirKey)
    if (style) {
      let text
      try {
        text = fs.readFileSync(abs, 'utf8')
      } catch {
        text = ''
      }
      if (text) {
        const fenceOf = makeFenceTracker()
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (fenceOf(line) !== 'outside') continue
          const masked = blankInline(line)
          if (!masked.includes('[[')) continue

          for (const m of masked.matchAll(NODE_REF)) {
            if (style === 'plain') {
              warnings.push({
                code: 'rules-ref-style',
                message: `${relPosix} 第 ${i + 1} 行：本目录（${dirKey}）按 rules.json 要求写纯文本引用，不能用 [[node="…"]]（${m[1]}）`,
              })
            }
          }
          for (const m of masked.matchAll(TSCL_REF)) {
            if (style === 'plain') {
              warnings.push({
                code: 'rules-ref-style',
                message: `${relPosix} 第 ${i + 1} 行：本目录（${dirKey}）按 rules.json 要求写纯文本引用，不能用 [[tscl="…"]]（${m[1]}）`,
              })
            } else if (style === 'expand' && !m[1].startsWith('fact:')) {
              warnings.push({
                code: 'rules-ref-style',
                message: `${relPosix} 第 ${i + 1} 行：rules.json 规定本目录只能展开 fact:* 定义，[[tscl="${m[1]}"]] 不是`,
              })
            }
          }
        }
      }
    }

    const limit = bytesFor(rules, dirKey)
    if (limit) {
      let size = 0
      try {
        size = fs.statSync(abs).size
      } catch {
        size = 0
      }
      if (size > limit) {
        warnings.push({
          code: 'rules-file-size',
          message: `${relPosix} ${(size / 1024).toFixed(1)} KB，超过 rules.json 给本目录（${dirKey}）定的 ${(limit / 1024).toFixed(1)} KB——拆成几个文件，或把这条规则改掉`,
        })
      }
    }
  }

  return warnings
}
