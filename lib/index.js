/**
 * project-node-memory —— 宿主侧入口（Node，ESM）。
 *
 * 一个包两面：
 * - 这一面跑在 DSH 宿主进程：注册 6 个 kb_* 工具 + 给面板用的只读 HTTP 路由
 * - 另一面 lib/client.js 跑在浏览器：侧边栏图标 + 中栏面板
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：那条路会从 profile 的 node_modules 里解析到
 * 另一份运行时，把整个基础层一起打崩（tiddlywiki 版踩过）。
 */

import { buildTools } from './host/tools.js'
import { registerRoutes } from './host/routes.js'
import { registerPrompt } from './host/prompt.js'
import { registerSkill } from './host/skill.js'

export const name = 'project-node-memory'
export const inject = ['tools', 'webServer']

/**
 * 配置（全部可选）：
 * - libraries: { 名字: 技能目录绝对路径 }   —— 内联登记库
 * - registries: [注册表 JSON 路径]           —— 与 Python 版 kb_registry.json 同格式
 * - workspace: 工作区路径（默认取会话工作区，取不到用进程 cwd）
 * - exclude: ['tmp_*', '!tmp_keep']   —— 库发现时额外忽略的目录名（支持 * 通配；
 *   `!` 前缀表示强制放行，可覆盖默认名单）。默认已忽略 tmp/temp/*_probe/nodekb_lab 等。
 * - prompt: { enabled?: false, text?: string } —— 系统提示词里的那段约定（默认开）
 */
export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const disposers = []
  // 启动期绝不向外抛：插件装坏了顶多是它自己不可用，不能连累宿主起不来。
  try {
    disposers.push(...buildTools(ctx, cfg))
  } catch (error) {
    console.warn('[project-node-memory] 工具注册失败，插件继续以只读路由方式运行：', error)
  }
  try {
    disposers.push(registerPrompt(ctx, cfg))
  } catch (error) {
    console.warn('[project-node-memory] 提示词段落注册失败，工具与面板不受影响：', error)
  }
  try {
    disposers.push(registerSkill(ctx, cfg))
  } catch (error) {
    console.warn('[project-node-memory] 技能注册失败，工具与面板不受影响：', error)
  }
  try {
    disposers.push(registerRoutes(ctx, cfg))
  } catch (error) {
    console.warn('[project-node-memory] 路由注册失败，面板与工具不影响：', error)
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载期忽略 */
      }
    }
  }
}
