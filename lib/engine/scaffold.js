/**
 * scaffold —— 给一个目录铺出 .nodekb 骨架。
 *
 * 目的不是「生成一堆空文件」，而是把**约定**写进库里：后来的人（或 Agent）
 * 打开 .nodekb/README.md 就知道该放哪、该多大、什么时候引用而不是复述。
 * 幂等：已存在的文件一律跳过，绝不动用户已写的内容。
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
| \`facts/\` | 事实常量（一个节点一条） | 值本身即答案：版本号、公差、系数、路径、阈值 |
| \`lessons/\` | 踩过的坑 | 换个人还会再踩，且「怎么发现的」比结论更值钱 |
| \`todo/\` | 待办与计划 | 有明确完成条件 |
| \`index/entry.md\` | 入口索引 | 只放指针（\`[[TID]]\`），不要复述正文 |

## 三条硬规则

1. **一个主题一个文件，取 < 4KB**。超过就拆成 \`doc/03-xxx.md\` 的多节，入口表加一行指针。
2. **不要复述**。同一段数字/结论只写一次，其它地方用 \`[[TID]]\` 引用；改名时 \`kb_rename\` 会一起改写。
3. **写之前先 \`kb_read mode=toc\` 看结构**，写完跑 \`kb_diag\`：悬空引用、引用位置型段落、循环、重复 TID 都会当场报出来。

## 语法（就两条）

- 文件即节点：\`doc/03-build.md\` → TID \`doc:03-build\`；\`## 3.1 标题\` → 子节点 \`doc:03-build:3.1\`
- 显式节点：\`<node name="fact:abi" type="fact">\` … \`</node>\`，标签必须**独占一行**
- 引用：\`[[doc:03-build:3.1]]\`（引用文件夹/文件展开整支，引用显式节点只展开它自己）
`

const ENTRY = `# 入口索引

只放指针，不复述正文。每条一行：\`- [[TID]] 一句话说明\`。

## 主题

- [[doc:00-overview]] 项目概览与结构

## 事实

（\`facts/\` 下的节点）

## 待办

（\`todo/\` 下的条目）
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

const FACTS = `# 事实

一个常量一条 \`<node name="fact:xxx" type="fact">\`：值 + 单位 + 出处 + 什么时候会变。
值本身即答案的东西才放这里，解释性内容放 doc/。
`

const IGNORE = `{
  "blocks": [],
  "lines": []
}
`

const SEEDS = [
  ['README.md', README],
  ['index/entry.md', ENTRY],
  ['doc/00-overview.md', OVERVIEW],
  ['facts/README.md', FACTS],
  ['lessons/README.md', LESSONS],
  ['todo/README.md', TODO],
  ['diag_ignore.json', IGNORE],
]

/**
 * @param {string} nodekbDir 目标 .nodekb 目录（不存在则创建）
 * @returns {{nodekb:string, created:string[], skipped:string[]}}
 */
export function scaffold(nodekbDir) {
  const created = []
  const skipped = []
  for (const [rel, content] of SEEDS) {
    const abs = path.join(nodekbDir, rel)
    if (fs.existsSync(abs)) {
      skipped.push(rel)
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
    created.push(rel)
  }
  return { nodekb: nodekbDir, created, skipped }
}
