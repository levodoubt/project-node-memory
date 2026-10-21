/**
 * prompt —— 往系统提示词里加一段「本项目的知识库怎么用」。
 *
 * 这是让 Agent **优先**用 kb_* 而不是自己拿 write 搭 docs/ 的唯一常驻手段：
 * 工具描述只有在模型已经决定「我要写知识」时才会被读到，而提示词每一轮都在。
 * 代价是常驻 token，所以整段压到 ~450 字，只留 schema 表达不了的约定。
 *
 * 插件配置 prompt.enabled=false 可以关掉；prompt.text 可以整段替换。
 */

export const PROMPT_SECTION_NAME = 'project-node-memory'
export const PROMPT_SECTION_ORDER = 100

export const DEFAULT_PROMPT = [
  '## 项目知识库（project-node-memory）',
  '',
  '本项目需要沉淀长期知识（设计决策、踩坑、事实常量、待办、交接）时，**用 `.nodekb/` + `kb_*` 工具**，不要用 write/edit 手搭 `docs/*.md` 式的渐进式文档——手写没有校验、没有稳定 TID、没有引用展开。',
  '',
  '- 建库：`kb_init` 一次铺出骨架（`doc/ facts/ lessons/ todo/ index/entry.md` + 约定说明）。已有 `.nodekb/` 就别重建。',
  '- 写库：`kb_write`（append/replace/create，或对显式节点用 mode=node）。它写前校验 TID 与 `<node>` 独占一行，写后立刻跑 diag 把悬空引用/重复块报回来；同样的事用 write 做没有任何一层会拦。',
  '- 读库：先 `kb_read mode=toc` 看结构（几百 token），再按 TID 读一支；找不到就 `kb_search`。别一次性把整库读进上下文。',
  '- 改名前先 `kb_backlinks`，改名用 `kb_rename`（会重写全库引用并跳过被并发改过的文件）。',
  '- 一个主题一个文件、取 < 4KB；结论只写一次，别处用 `[[TID]]` 引用。',
].join('\n')

function textOf(config) {
  const p = (config && config.prompt) || {}
  if (typeof p.text === 'string' && p.text.trim()) return p.text
  return DEFAULT_PROMPT
}

/** 最近一次注册的结果（给 /nodekb/api/prompt 自证用） */
const STATE = { registered: false, reason: 'not-run', chars: 0, name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER }

export function promptState() {
  return { ...STATE }
}

/**
 * @returns {() => void} disposer（未接上 systemPrompt 服务时是空函数）
 *
 * 注意：`systemPrompt` 是**可选服务**，不能写进静态 `inject`（拿不到就整个插件不激活，
 * 连工具一起没了）。宿主给的是动态注入 `ctx.inject(['systemPrompt'], (child) => …)`：
 * 服务就绪时回调，插件先照常起来。
 */
export function registerPrompt(ctx, config) {
  const p = (config && config.prompt) || {}
  if (p.enabled === false) {
    Object.assign(STATE, { registered: false, reason: 'disabled-by-config', chars: 0 })
    return () => {}
  }

  const attach = (sp) => {
    if (!sp || typeof sp.section !== 'function') {
      Object.assign(STATE, { registered: false, reason: 'no-systemPrompt-service', chars: 0 })
      return null
    }
    const text = textOf(config)
    try {
      const dispose = sp.section({ name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, text })
      Object.assign(STATE, { registered: true, reason: 'ok', chars: text.length })
      return () => {
        Object.assign(STATE, { registered: false, reason: 'disposed', chars: 0 })
        if (typeof dispose === 'function') dispose()
      }
    } catch (e) {
      Object.assign(STATE, { registered: false, reason: 'error: ' + (e && e.message), chars: 0 })
      console.warn('[project-node-memory] 提示词段落注册失败:', e && e.message)
      return null
    }
  }

  // 首选：动态注入，服务晚于插件就绪也能接上
  if (typeof ctx.inject === 'function') {
    let off = null
    try {
      const effect = ctx.inject(['systemPrompt'], (child) => {
        off = attach(child && child.systemPrompt)
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
  let sp = null
  try {
    sp = ctx.systemPrompt || (typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null)
  } catch {
    sp = null
  }
  if (!sp) {
    Object.assign(STATE, { registered: false, reason: 'no-systemPrompt-service', chars: 0 })
    return () => {}
  }
  const off = attach(sp)
  return () => {
    if (off) off()
  }
}
