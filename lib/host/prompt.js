/**
 * prompt —— 往系统提示词里加一段「本项目的知识库怎么用」。
 *
 * 这是让 Agent **优先**用 kb_* 而不是自己拿 write 搭 docs/ 的唯一常驻手段：
 * 工具描述只有在模型已经决定「我要写知识」时才会被读到，而提示词每一轮都在。
 *
 * 分工（2026-10 定的）：**这里只说「有这东西、怎么起步、去哪看细则」**，
 * 细则（TID 起法、写入形态、检索语义、诊断豁免、vcs）全部在 skill
 * `project-node-memory-guide` 里——skill 按需加载，不占常驻 token。
 * 整段压在 ~400 字符，别再把细则搬回来。
 *
 * 插件配置 prompt.enabled=false 可以关掉；prompt.text 可以整段替换。
 */

export const PROMPT_SECTION_NAME = 'project-node-memory'
export const PROMPT_SECTION_ORDER = 100

export const DEFAULT_PROMPT = [
  '## 项目知识库（project-node-memory）',
  '',
  '本项目用 `.nodekb/` + `kb_*` 工具沉淀长期知识（决策、踩坑、事实常量、待办、交接），写进去的内容会被后续会话按 TID 精确读取。',
  '',
  '- 建库 `kb_init`（幂等）；写库 `kb_write`；读库先 `kb_read mode=toc` 再按 TID 读一支，别整库进上下文。',
  '- 引用两种：`[[node="x"]]` 出链接（不复制正文），`[[tscl="x"]]` 嵌值（同一值全库只写一处）。',
  '- 写完跑 `kb_diag`：errors 必修，warnings 视情况，advice 是「还能更省」的改进建议。',
  '- **使用细则（TID 起法、写入形态、检索语义、诊断豁免、快照）见 skill `project-node-memory-guide`；若不清楚这个技能，至少完整读一次。**',
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
