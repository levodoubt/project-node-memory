/**
 * skill —— 随包分发一条「怎么写这个知识库」的技能。
 *
 * 为什么要做：系统提示词那段只能点到为止（常驻 token 有预算），而「文件怎么分、
 * TID 怎么起、先读什么再写什么」这种规范篇幅不小、又不是每一轮都需要。skill 正好
 * 是「按需加载、不用时不占提示词预算」的容器。
 *
 * 为什么不是把 SKILL.md 拷进用户的 $DSH_HOME/skills：那样能生效，但会在用户家目录
 * 留下插件无权回收的文件（升级残留、卸载残留），而且需要该目录可写。宿主的 skills
 * 服务提供 `register()`，把技能注册在内存里——随包版本走、禁用即撤回、零写入。
 *
 * 技能注册是**可选服务**，所以走动态注入：服务不在时插件照常起来（工具、面板、
 * 提示词段落都不受影响）。
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 必须是 kebab-case（宿主 skill 注册表按这个名字做唯一键） */
export const SKILL_NAME = 'project-node-memory-guide'
export const SKILL_SOURCE = 'project-node-memory'

export const DEFAULT_SKILL_DESCRIPTION =
  '用 .nodekb/ + kb_* 工具沉淀项目长期知识时的写法规范：什么时候该写、文件怎么分、TID 怎么起、先读什么再写什么。准备手写 docs/*.md 之前先读这一条。'

/** 随包 SKILL.md 的位置：lib/host/ 上两级就是包根，skills/ 是它的兄弟目录。 */
function skillFileCandidates() {
  return [new URL('../../skills/project-node-memory-guide/SKILL.md', import.meta.url)]
}

/** 读随包 SKILL.md；读不到返回 undefined（不抛）。 */
export function readBundledSkillText() {
  for (const url of skillFileCandidates()) {
    try {
      return fs.readFileSync(fileURLToPath(url), 'utf8')
    } catch {
      /* 试下一个候选 */
    }
  }
  return undefined
}

/**
 * 拆出 YAML front matter。
 * 只认简单 `key: value`（够用即可，不引依赖）；值两端的引号会剥掉。
 */
export function splitFrontMatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { meta: {}, body: src }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    meta[kv[1]] = v
  }
  return { meta, body: src.slice(m[0].length) }
}

/** 最近一次注册结果（给 /nodekb/api/skill 自证用） */
const STATE = { registered: false, reason: 'not-run', name: SKILL_NAME, chars: 0 }

export function skillState() {
  return { ...STATE }
}

/**
 * 把随包 SKILL.md 注册成宿主内存里的 skill。
 * @returns {() => void} disposer（未接上 skills 服务时是空函数）
 */
export function registerSkill(ctx, config) {
  const c = (config && config.skill) || {}
  if (c.enabled === false) {
    Object.assign(STATE, { registered: false, reason: 'disabled-by-config', chars: 0 })
    return () => {}
  }

  const raw = typeof c.text === 'string' && c.text.trim() ? c.text : readBundledSkillText()
  if (typeof raw !== 'string' || !raw.trim()) {
    Object.assign(STATE, { registered: false, reason: 'missing-skill-file', chars: 0 })
    console.warn('[project-node-memory] 随包 SKILL.md 缺失，技能不注册（工具与面板不受影响）')
    return () => {}
  }

  const { meta, body } = splitFrontMatter(raw)
  const name = typeof meta.name === 'string' && meta.name ? meta.name : SKILL_NAME
  const description =
    (typeof c.description === 'string' && c.description.trim()) ||
    (typeof meta.description === 'string' && meta.description.trim()) ||
    DEFAULT_SKILL_DESCRIPTION
  const content = body.trim()
  const skill = {
    name,
    description,
    content,
    source: SKILL_SOURCE,
    // 模型和用户都能调：/skill 命令与目录都要看到它
    invocation: { modelInvocable: true, userInvocable: true },
  }

  const attach = (svc) => {
    if (!svc || typeof svc.register !== 'function') {
      Object.assign(STATE, { registered: false, reason: 'no-skills-service', chars: 0 })
      return null
    }
    try {
      const dispose = svc.register(skill)
      Object.assign(STATE, { registered: true, reason: 'ok', name, chars: content.length })
      return () => {
        Object.assign(STATE, { registered: false, reason: 'disposed', chars: 0 })
        if (typeof dispose === 'function') dispose()
      }
    } catch (e) {
      Object.assign(STATE, { registered: false, reason: 'error: ' + (e && e.message), chars: 0 })
      console.warn('[project-node-memory] 技能注册失败:', e && e.message)
      return null
    }
  }

  // 首选：动态注入（skills 服务可能晚于本插件就绪）
  if (typeof ctx.inject === 'function') {
    let off = null
    try {
      const effect = ctx.inject(['skills'], (child) => {
        off = attach(child && child.skills)
        return off || undefined
      })
      return () => {
        try {
          if (typeof effect === 'function') effect()
          else if (effect && typeof effect.dispose === 'function') effect.dispose()
        } catch {
          /* 卸载期忽略 */
        }
        if (off) off()
      }
    } catch (e) {
      Object.assign(STATE, { registered: false, reason: 'inject-error: ' + (e && e.message), chars: 0 })
      return () => {}
    }
  }

  // 退路：直接取
  let svc = null
  try {
    svc = ctx.skills || (typeof ctx.get === 'function' ? ctx.get('skills') : null)
  } catch {
    svc = null
  }
  if (!svc) {
    Object.assign(STATE, { registered: false, reason: 'no-skills-service', chars: 0 })
    return () => {}
  }
  const off = attach(svc)
  return () => {
    if (off) off()
  }
}
