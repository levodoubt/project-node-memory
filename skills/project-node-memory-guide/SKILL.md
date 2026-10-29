---
name: project-node-memory-guide
version: 1.5.18
description: 用 .nodekb/ + kb_* 工具沉淀项目长期知识（设计决策、踩坑、事实常量、待办、交接）时的写法规范——什么时候该写、文件怎么分、TID 怎么起、唯一事实用 tscl 怎么共享、先读什么再写什么。准备创建知识库时先读该技能。
---

# 写项目节点知识库（`.nodekb/`）

本文件是**高频使用内容**；完整规则在 `references/`（相对本技能目录），需要时再读。

想知道「这版多了什么」：`references/changes.md`。

## 什么时候该写

**值得写**：设计决策与理由、踩过的坑（症状 + 根因 + 对策）、事实常量（版本号、路径、阈值、接口字段）、待办与交接。

**不该写**：一次性调试输出、能从代码直接读出的内容（函数签名、目录列表）、临时状态。

判据是「下次换个人/换个会话，不知道这条会不会重做一遍错事」。不要把整段对话贴进 `doc/`（记结论，不记过程）；同一件事不要在 `doc/` 和 `lessons/` 各写一份——抽成 `<tscl>` 定义，两处引用。

## 先读再写

```
kb_read mode=toc            # 结构 + 每节字符数，几百 token
kb_read target=<TID>        # 按需读一支
kb_search query=...         # toc 里找不到再搜
```

- **不要**一次把整库读进上下文；写之前先确认这个结论是不是已经写在别处了。
- 节点太大就按行开窗：`kb_read target=<TID> mode=node offset=41 limit=60`、`kb_read target=<TID> find=关键词`（整串没中会按词退让）、`kb_search query=... lines=true`。超 `maxlen` 会截断并给续读坐标，不报错。
- `kb_read mode=toc` 默认只展开两层（`depth` 可调，`0` = 只看本节点），大库的目录不再一次上千 token；有子节的节点报「整支 N 字符」，目录节点自身 0 字符，靠这个数判断值不值得进去。
- 要按字段判断就传 `format: "json"`（`kb_list` / `kb_read` / `kb_search` / `kb_backlinks` / `kb_diag`）：给结构化结果，省得正则切片散文；`kb_diag` 在 json 模式下不抛异常，看 `exit_code`。
- `kb_search` 是**词面**检索（中文 2-gram、英文切词）：搜关键词更有效。命中里 `tid` 是稳定句柄，`ref` 才是真正命中的节点，两者对不上按 `ref` 定位。片段里的 `[[tscl="x"]]` 已嵌成值。
- 行号只是**同一次解析快照内的临时坐标**；写进文档的引用一律用 TID。

## 目录规划

| 目录             | 放什么                           | 判据                           |
| ---------------- | -------------------------------- | ------------------------------ |
| `doc/`           | 主题文档：架构、模块、流程、配置 | 「是什么、怎么运转」           |
| `lessons/`       | 踩坑记录                         | 「症状 → 根因 → 对策」三行齐全 |
| `todo/`          | 未完成事项、阻塞、交接           | 有明确的下一步动作             |
| `index/entry.md` | 总入口与落位约定                 | 只放导航，不放正文             |

推荐做法，可自行增删。**一个主题一个文件**，单文件建议 1 KB - 4 KB；变大按子主题拆成 `##` 段或独立文件，过小就合并。

## 节点、TID 与引用

- **文件节点**：`doc/03-坑.md` → `doc:03-坑`。库根散文件（`README.md`）的 TID 没有前缀（`readme`），且它是文件节点：只能「路径 + replace」改整篇。
- **显式节点**：`<node name="abi">` 的 `name` 就是 TID（**不要求含冒号**），可跨文件引用；开闭标签各占一行，单行 `<node name="x">正文</node>` 也合法。
- **段节点**：`## 3.1 xxx` → `<文件TID>:3.1`。它是**位置型**的（插一节就漂），链接它只是 warning，别当长期锚点；它的父节点恒为文件节点。
- **属性缺省**：`title` = `name`；`type` = 目录名；`parent` = **文件节点**（同文件多个 `<node>` 是兄弟，不链式）。属性单双引号等价。
- **读可以前缀兜底**（`target=doc:02` 命中 `doc:02-运行环境`），**写引用要写全**。
- **代码区不解析**：围栏与行内代码里的 `[[…]]` / `<node>` / `<tscl>` 是示例，不解析、不计引用、不跟改名（``` ` 与 `~~~` 同等）。
- 两种引用：`[[node="TID"]]` 出链接不复制正文；`[[tscl="fact:x"]]` 把定义体嵌进来（**同一 id 全库只能定义一次**，值用 `fact:` 前缀）。

细节（大小写化、`###` 不建节点、嵌套、行内定义、宏体约束）：`references/syntax.md`。

## 写入（`kb_write`）

```
kb_write target=lessons/003-x.md  mode=create  content=...
kb_write target=<节点TID>          mode=node    content=...
kb_write target=doc/03-...md      mode=append  content=...
```

三条铁律：

1. **写完看回执里的校验结果**（悬空引用、重复定义、标签形态都会当场报）。
2. 改已有内容用 `append` / `node`，**不要 `replace` 整篇**；`mode=node` 的 `content` 不要带标题行。
3. 路径必须**小写 `.md`**；`content` 里不要写 `</node>`，标签要成对，未闭合会被拒。

`target` 判定顺序：库里已有的 TID（含无冒号的）→ 库根文件名 → 像路径的字符串（补 `.md`）→ 否则报「没有名为 … 的文件或节点」。

写入/改名成功后自动 git 快照（`autosnap: N 处变更`），**自检有 error 时不快照**；不想快照配 `git: false`。

细节（`mode=node` 的限制、CRLF、行号、四道拦截、解析器兜底）：`references/write.md`。

## 改名（`kb_rename`）

- `new_name` **只能是同目录文件名**（不能带 `/` 或 `..`）；跨目录搬先 `git mv` 再修引用。撞已有 TID 会拒。
- 它会重写 `[[…]]` 与 `<node>` 的 `tid=` / `name=` / `parent=`；改名后还有旧前缀就 `kb_diag` warning。
- 先自检再快照；**只改大小写也可以**（TID 本来就小写，只动文件系统）。
- 要一次改很多个文件用 `nodekb rename --batch 计划.json`（先 `--dry-run`），别写脚本循环。

## 诊断（`kb_diag`）

| 档         | 含义                                                                                                                  | 怎么处理                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `errors`   | 真损坏：悬空引用、重复 TID/定义、树环、未闭合 `<node>`/`<tscl>`                                                       | 必修                       |
| `warnings` | 疑似漂移：旧语法裸引用、位置型 TID 链接、孤儿节点、散文里不可解析的 TID 文本、TID 大小写不合规、违反本库 `rules.json` | 按需处理                   |
| `advice`   | 没问题但可改进：碎片文件、缺入口/H1、段节点过长、示例被写成了定义                                                     | 建议处理，不影响 exit_code |

- `advice` 每条带 `fix`，一次最多 5 条，不会让 `kb_diag` 失败（CI 可以无视）。
- 确属有意、又不想每次看见：`diag_ignore.json` 的 `advice` 按 `{code, tid}` 压掉单条，`warnings` 按整条文案正则压掉一条 warning（1.5.17）。
- 阈值默认 `minFragNodes 10 / fragChars 500 / longSection 10000 / maxItems 5`，可在插件配置 `advice: { … }` 覆盖。

细节（豁免表 `diag_ignore.json` 的三组正则、TID 文本核对的豁免、`plugin-updated`）：`references/diag.md`。

## 建库与注册

- 建库：`kb_init` 的 `dir` 是**库目录本身**（通常 `.nodekb`）；传上级目录会被拒。默认铺 `doc/`、`index/entry.md`、`lessons/`、`todo/`，只用几个就传 `parts: ["doc","index"]`（`README.md` 与 `diag_ignore.json` 总是铺）。
- 找不到库先 `kb_list`（会写明工作区、来源与每个库的绝对路径）；已有库用 `kb_register dir=<库目录> name=<名字>` 登记进项目。
- 列表末尾还会提醒「另有 N 个库不在本工作区」（打开过的库记在 `~/.dsh/nodekb/index.json`）：它们不会被本工作区的名字解析到，用路径传 `kb=`。
- 升级后第一次 `kb_diag` 会多一条 `plugin-updated`（提醒重读本技能），每条库只提醒一次；它不受 `advice.display` 控制、但计入 `advice.limit`。

## 命令行与库规矩

- 不在 DSH 里也能用同一套引擎：`nodekb list|read|search|backlinks|diag|write|rename|vcs`，`--json` 与工具层同构，退出码 0/1/2。**不要**再自己写包装脚本。详见 `references/cli.md`。
- 想声明「本库必须这么写」（按目录的引用风格、文件体积上限），写 `.nodekb/rules.json`。没有该文件时行为不变。详见 `references/rules.md`。

## 明细索引

| 需要时读                | 内容                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `references/syntax.md`  | TID 全规则、属性缺省、两种引用、行内定义、代码区、渲染上限 |
| `references/write.md`   | `kb_write` 全部限制、`target` 判定、校验两层、四道拦截     |
| `references/diag.md`    | 三档细节、advice 阈值与判据、豁免表（五组）、TID 文本核对  |
| `references/cli.md`     | `nodekb` 命令表、`--json`、退出码、批量改名计划文件        |
| `references/rules.md`   | `rules.json` 两个键的语义与现成配置                        |
| `references/changes.md` | 版本升级说明：新版本更新了什么                             |
