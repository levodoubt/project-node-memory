/**
 * scaffold —— 给一个目录铺出 .nodekb 骨架。
 *
 * 目的不是「生成一堆空文件」，而是把**约定**写进库里：后来的人（或 Agent）
 * 打开 .nodekb/README.md 就知道该放哪、该多大、什么时候引用而不是复述。
 * 幂等：已存在的文件一律跳过，绝不动用户已写的内容。
 *
 * 1.1 起不再预建 facts/：需要「唯一事实」时用 <tscl> 定义 + 引用，而不是单独开目录。
 * 目录与节点类型都是约定，不是约束——项目需要什么就加减什么。
 */

import fs from 'node:fs'
import path from 'node:path'

const README = `# 本库约定（.nodekb）

这是 **node project memory** 库：md 文件即数据库，没有索引库、没有向量、没有后台进程。
删掉插件之后它仍然是普通 md。

## 落位

| 目录 | 放什么 | 判据 |
|---|---|---|
| \`doc/\` | 主题文档（一块一块的正文） | 会随版本演进、需要通读的解释性内容 |
| \`lessons/\` | 踩过的坑 | 换个人还会再踩，且「怎么发现的」比结论更值钱 |
| \`todo/\` | 待办与计划 | 有明确完成条件 |
| \`index/entry.md\` | 入口索引 | 只放指针，不要复述正文 |

**目录与节点类型都是约定，不是约束**：项目没有待办就别建 \`todo/\`，需要 \`adr/\`、\`api/\`、\`runbook/\` 就自己加，
节点类型也一样（\`type="fact"\`、\`type="decision"\`、\`type="api"\` 都是自由的）。
上面这张表只是「不知道放哪时」的默认答案，不是白名单。

## 四条硬规则

1. **一个主题一个文件，取 < 4KB**。超过就拆成 \`doc/03-xxx.md\` 的多节，入口表加一行指针。
2. **不要复述**。同一句话只写一次：结构用 \`[[node="…"]]\` 指过去，真正的「值」写成 \`<tscl>\` 定义再引用。
3. **写之前先 \`kb_read mode=toc\` 看结构**，写完跑 \`kb_diag\`：悬空引用、重复定义、循环、重复 TID 都会当场报出来。
4. **事实只写一处**。同一个数字/结论出现两次就算漂移，\`kb_diag\` 会报。

## 语法（三种标记）

- 文件即节点：\`doc/03-build.md\` → TID \`doc:03-build\`；\`## 3.1 标题\` → 子节点 \`doc:03-build:3.1\`
- 显式节点：\`<node name="lesson:abi" type="lesson">\` … \`</node>\`，标签必须**独占一行**
- 结构引用：\`[[node="doc:03-build:3.1"]]\` —— 渲染成一个链接，**不展开**（内容不复制）
- 值嵌入：先定义
  \`\`\`md
  <tscl id="fact:abi">
  三条硬规则：1) 只用 C ABI；2) 名字加前缀 \`fm_\`；3) 导出结构体必须定长。
  </tscl>
  \`\`\`
  再写 \`[[tscl="fact:abi"]]\` —— 渲染时整段替换进来。**同一个 id 全库只能定义一次**，
  改一处，所有引用处同时变；这就是用引用代替复述的意义。
`

const ENTRY_WITH_DOC = `# 入口索引

只放指针，不复述正文。结构用 \`[[node="TID"]]\`，值用 \`[[tscl="id"]]\`。

## 主题

- [[node="doc:00-overview"]] 项目概览与结构

## 其它

按项目实际增删：待办（\`todo/\`）、决策（\`adr/\`）、接口（\`api/\`）……没有的目录直接删掉。
`

const ENTRY_BARE = `# 入口索引

只放指针，不复述正文。结构用 \`[[node="TID"]]\`，值用 \`[[tscl="id"]]\`。

## 主题

（写完第一篇 doc 后，在这里加一行指向它的文件 TID；这个库没铺 doc/ 目录）
`

const OVERVIEW = `# 项目概览

## 这个项目是什么

（一段话说清楚）

## 目录与关键文件

（只列「改动会牵连很多地方」的那几个）

## 运行时与依赖

（版本、入口、构建方式）
`

const LESSONS = `# 教训

一条一个 \`<node name="lesson:xxx" type="lesson">\`，写「现象 → 为什么 → 怎么发现的」。
比结论更值钱的是发现它的过程。
`

const TODO = `# 待办

一条一个 \`<node name="todo:xxx" type="todo">\`，每条要有**明确的完成条件**。
`

const IGNORE = `{
  "blocks": [],
  "lines": []
}
`

const SEEDS = [
  ['README.md', README, '*'],
  ['index/entry.md', null, 'index'], // 内容按是否铺 doc/ 决定（见 scaffold）
  ['doc/00-overview.md', OVERVIEW, 'doc'],
  ['lessons/README.md', LESSONS, 'lessons'],
  ['todo/README.md', TODO, 'todo'],
  ['diag_ignore.json', IGNORE, '*'],
]

export const SCAFFOLD_PARTS = ['doc', 'index', 'lessons', 'todo']

/**
 * @param {string} nodekbDir 目标 .nodekb 目录（不存在则创建）
 * @param {{parts?: string[]}} [opts] parts 里只填要的目录组（doc/index/lessons/todo），
 *   缺省四件套全铺；README.md 与 diag_ignore.json 总是铺。
 * @returns {{nodekb:string, created:string[], skipped:string[]}}
 */
export function scaffold(nodekbDir, opts = {}) {
  const want = Array.isArray(opts.parts) && opts.parts.length ? opts.parts.map((p) => String(p).trim()) : SCAFFOLD_PARTS
  const created = []
  const skipped = []
  for (const [rel, content, group] of SEEDS) {
    if (group !== '*' && !want.includes(group)) continue
    const abs = path.join(nodekbDir, rel)
    if (fs.existsSync(abs)) {
      skipped.push(rel)
      continue
    }
    const body = content == null ? (want.includes('doc') ? ENTRY_WITH_DOC : ENTRY_BARE) : content
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body, 'utf8')
    created.push(rel)
  }
  return { nodekb: nodekbDir, created, skipped }
}
