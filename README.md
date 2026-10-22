# project-node-memory

> 简体中文 · [English](README_EN.md)

把 **Markdown 目录当成知识库** 的 DSH 插件：为 Agent 提供 9 个 `kb_*` 工具，为人类提供知识节点面板（侧栏入口名「项目节点知识库」）。

没有索引数据库、没有向量、没有后台进程。完整知识库位于项目下的 `.nodekb/` 目录——一堆 md 文件，删掉插件之后它仍然是普通 md。

本 README 只描述**当前版本**的行为；每个版本的变更记录在 [Releases](https://github.com/levodoubt/project-node-memory/releases)。

```
项目/
└── .nodekb/
    ├── index/entry.md        ## 3.1 编译契约
    ├── doc/03-build.md       <tscl id="fact:abi">…</tscl>
    ├── lessons/001.md
    └── diag_ignore.json      可选：豁免样板块
```

## 它能为 Agent 带来什么

Agent 默认靠 `read` / `grep` / `glob` 找东西，代价是**试探**：grep 到 5 个文件，逐个 read，才发现真正要的只有其中一段。本插件把这层收敛成四件事：

| 能力                                | 对应工具               | 省下什么                                          |
| ----------------------------------- | ---------------------- | ------------------------------------------------- |
| 先看结构再读正文                    | `kb_read mode=toc`     | 一次 ~200 token 的目录视图替代整篇 read           |
| 稳定 TID 寻址（`doc:03-build:3.1`） | `kb_read target=…`     | 不受行号漂移影响；改文件不打断引用                |
| 引用就地展开（转写）                | `kb_read mode=subtree` | 一次拿到装配好的上下文，不用手动拼                |
| 结构自检                            | `kb_diag`              | 悬空引用 / 引用位置型段落 / 循环 / 孤儿，改完就查 |

返回文本体积设有硬闸：`mode=subtree` 超过 `maxlen`（默认 50000 字符）直接报错，并告知改用 `toc` / `node`，而不是悄悄截断。

## 怎么让 Agent 真的用它

工具描述只在 Agent 已经决定「我要沉淀知识」时才被读到；要让它**优先**选这条路，靠四层：

1. **系统提示词段落**（默认开，`prompt.enabled=false` 可关）——每轮都在，规则只有五行：要沉淀就用 `.nodekb/` + `kb_*`，别拿 `write` 手搭 `docs/*.md`。
   段落常驻约 450 字，实测 `GET /nodekb/api/prompt` 可自证是否注册成功。

2. **把「建库」变成一次调用**——`kb_init` 直接铺出 `doc/ lessons/ todo/ index/entry.md` 与 `.nodekb/README.md` 里的落位约定（幂等，已存在不覆盖）。没有这一步，Agent 会自己发明目录结构。

3. **写也走工具**——`kb_write` 写前校验 TID / `<node>` 独占一行 / 路径不越界，写后立刻跑 diag 把悬空引用与重复块报回来。`write` 没有任何一层会拦，所以规则只能靠记。

4. **随包技能 `project-node-memory-guide`（按需加载）**——提示词段落只有五行，写法规程（文件怎么分、TID 怎么起、先读什么再写什么、三个反例）放在 `skills/project-node-memory-guide/SKILL.md`。
   装好即生效，**不需要任何手工步骤**：宿主 `skills` 服务可用时插件用 `ctx.skills.register()` 把正文注册在内存里（不用时零提示词开销，禁用插件即撤回）。`skill.enabled=false` 可关；`GET /nodekb/api/skill` 自证是否注册成功。

   > 注：DSH 的 skill 文件发现只扫 `$DSH_HOME/skills`、`<workspace>/.dsh/skills` 与 preset 里显式声明的路径，**不会**去扫 npm 包内的 `skills/` 目录。所以「把 SKILL.md 打进包」本身不会让它被发现——要么注册进内存（本插件的做法），要么启动时把文件写进用户的 skill 根目录（会在家目录留残留）。

## 装

```bash
dsh plugin add project-node-memory      # npm 发布后
```

从源码装（开发用）：

```bash
npm pack                       # 产出 project-node-memory-<版本>.tgz
dsh plugin add ./project-node-memory-<版本>.tgz
```

> 打包后再 `add` 那个 `.tgz`，不要直接 `add` 源码目录：目录形式装的是 **link 依赖**，目录被移动或删除后 DSH 会起不来。Host 侧改动需要重启 DSH；面板改动重新安装即热载。

## 配置

全部可选，写在 `cordis.patch.yml` 的该行 `config:` 下：

| 键               | 默认                                            | 作用                                                          |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| `workspace`      | 会话工作区 → 进程 cwd                           | 覆盖「工作区」，库发现与路径白名单都以它为界                  |
| `libraries`      | 无                                              | `名字: 目录`，显式登记工作区之外的库（目录下需有 `.nodekb/`） |
| `registries`     | 工作区 `.nodekb/registry.json` + 用户全局注册表 | 额外的 `kb_registry.json`（与 Python 版同格式）               |
| `exclude`        | 见下                                            | 库发现时忽略的目录名，支持 `*` 通配；`!pattern` 强制放行     |
| `prompt.enabled` | `true`                                          | 是否注册系统提示词段落                                        |
| `skill.enabled`  | `true`                                          | 是否把随包 Skill 注册进宿主 `skills` 服务                     |

`exclude` 默认忽略这些名字：`tmp`、`tmp_*`、`temp*`、`.tmp*`、`*_probe`、`nodekb_lab`、`__pycache__`、`_release_assets`、`venv`。临时目录、探针目录里的 `.nodekb` 通常是实验残渣，列进选择器只会碍事。要放行某个目录写 `"!tmp_keep"`；要额外忽略写 `"scratch"`（与默认名单叠加）。

```yaml
config:
  exclude: ['tmp_*', '!tmp_keep', 'scratch']
```

## 面板

侧边栏多一个图标（名字「项目节点知识库」），点开是中栏三列：

- **左**：上半是节点树（`标题 · 类型 · 字符数`），顶部搜索框回车换成命中列表；下半是**图设置**——布局方向（上下/左右）、展开层数、类型筛选（点一下隐藏该类型）、全部展开 / 适应视图
- **中**：**节点图**。父左子右（或上下）的确定性树形布局，节点框按类型描边取色，滚轮缩放、拖动平移、点节点选中、双击折叠该支；右下角有 `+ / − / 适应` 和当前缩放比例
- **右**：上半是节点内容（**markdown 渲染**，`[[TID]]` 可点），下半是节点属性（tid、类型、父、源文件行号、字符数、子节数、被谁引用、文件改名按钮）。「原文 / 源码」两个视图保持等宽纯文本

正文的 markdown 是自己写的小渲染器（标题 / 列表 / 代码 / 表格 / 引用 / 强调 / 链接），**LaTeX 走 MathML**：`$…$` 行内、`$$…$$` 与 ```math 围栏是独立公式块。不依赖 KaTeX、不带字体文件，排版交给浏览器原生的 MathML 引擎。支持分数、根号、上下标、希腊字母、∑∏∫、矩阵（pmatrix/bmatrix/vmatrix）、cases、`\left…\right`、`\text{}`、`\mathrm/\mathbf/\mathbb` 等常用子集；不认识的命令按字面显示，不会崩。

面板只读，数据走宿主侧注册的 `/nodekb/api/*`。写库就是写 md——用 `write` / `edit` 工具，或者 `kb_write`。
右栏正文单次最多渲染 10000 字符（超出显示截断提示）；宽表格横向滚动，长文本纵向滚动。

## 9 个工具

| 工具            | 干什么                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `kb_list`       | 有哪些库、哪个是默认。不确定传什么 `kb` 时先调它                                               |
| `kb_read`       | `target` + `mode`（`subtree` 默认 / `node` / `toc` / `raw`）+ `maxlen`                         |
| `kb_search`     | 中文友好检索（2-gram + 多词加权 + 少见时退化子串），返回稳定 TID、类型、源行、片段             |
| `kb_diag`       | 结构自检；有 error 时直接失败，别读完才发现引用断了                                            |
| `kb_backlinks`  | 谁引用了它。改 TID / 删节点前先跑                                                              |
| `kb_init`       | 建 `.nodekb` 骨架（幂等），铺出 `doc/ lessons/ todo/ index/` 与落位约定                 |
| `kb_write`      | 写库：`append` / `replace` / `create` / `node`（就地改写一个 `<node>` 块）；写前校验、写后自检 |
| `kb_rename`     | 文件改名 + 全库引用一起改写；写前重读，别人刚改的不覆盖                                        |
| `kb_vcs_status` | 库内嵌 git 的快照历史与未提交改动（git 缺失时只说明，不报错）                                  |

## 库怎么定位

所有 `kb_*` 工具只有一个定位参数 `kb`，它同时接受**名字**与**路径**：

1. `kb` 给路径（技能目录，或其下的 `.nodekb`，绝对或相对工作区）——必须落在工作区或已注册库内
2. `kb` 给名字（注册表里的名字，或工作区里发现的名字，如某个技能名）
3. 都不给：工作区自带的 `.nodekb/` → 工作区里发现且唯一的库 → 注册表里唯一的库

**自动发现**：给了工作区之后，库里不只在工作区根找，还会按约定位置下钻（有界 BFS，默认 2 层）：

```
<ws>/.nodekb                          → 名字 workspace
<ws>/.dsh/skills/<技能>/.nodekb        → 名字 <技能>
<ws>/<子目录>/.nodekb                  → 名字 相对路径
<ws>/<子目录>/.dsh/skills/<技能>/.nodekb
```

跳过 `node_modules` / `dist` / `build` / `out` / `target` / `coverage` / 点目录，`readdir` 次数有上限，所以面板每次加载都敢调。这就是「知识库跟着项目走」：指到项目根，技能里那些 `.nodekb/` 自己会浮出来。

注册表与 Python 版 `kb_registry.json` 同格式，默认读工作区下的 `.nodekb/registry.json` 与用户目录里的全局注册表。插件配置也可以直接内联：

```yaml
- insert:
    - id: nodekb
      name: project-node-memory
      config:
        libraries:
          my-notes: D:\notes      # 名字 → 目录（目录下需有 .nodekb/）
        registries:
          - D:\shared\kb_registry.json
```

`config.workspace` 可覆盖「工作区」；优先级是 **exec 上下文（面板点的目录 / 会话工作区）→ config.workspace → 环境变量 `DSH_NODEKB_WORKSPACE` → 最近一次工具用过的目录 → 进程 cwd**。所以在面板里换目录总能生效，配置只当默认值。

面板拿不到会话上下文，所以它默认跟随**最近一次 `kb_*` 工具调用所在的工作区**（Agent 读过哪个项目，面板就显示哪个项目）；顶栏的目录下拉只列出 DSH 用过的、且**真的有 `.nodekb`** 的项目目录（标了各自发现几个库），点右上「目录」也可以手填路径。选择存在浏览器 localStorage，只影响面板，不影响工具。

面板的两个下拉是联动的：**工作区 → 该工作区里的库**（`GET /nodekb/api/libs?scope=workspace`），全局注册表里的库单独归到「全局注册」分组，路径已不存在的注册项不显示（`exists:false`）。

想知道某个请求最后解析成了哪个工作区，直接看 `GET /nodekb/api/where`：它把 config / env / exec / 上次记忆 / 进程 cwd 与最终结论一起吐出来。

### 「注册」到底指什么

没有注册这一步也能用 —— 只要库落在工作区里的约定位置（见上），它就会出现在列表里。`kb_registry.json` 只是给**不在工作区里**的库用的（比如 F 盘另一个项目、共享笔记目录）：

```json
{ "libraries": { "my-notes": { "path": "D:\\notes" } } }
```

读取顺序：`config.libraries` → `config.registries` 指定的文件 → `<ws>/.nodekb/registry.json` → `<ws>/kb_registry.json` → 用户目录的全局注册表（`~/.dsh/nodekb/registry.json`）。注册表里登记的名字优先级高于自动发现的名字，路径重复的以先出现的为准。

给条目加 `"hidden": true` 后，它**只作为别名**存在：仍然可以用 `kb="my-notes"` 调用（老文档里写死的库名不会失效），但不会出现在面板的知识库下拉里。

```json
{ "libraries": { "my-notes": { "path": "D:\\notes", "hidden": true } } }
```

## 语法

```md
## 3.1 编译契约            → 节点 tid = doc:03-build:3.1（位置型）
<node name="fact:abi" type="fact" parent="doc:03-build">
正文                                    ← 显式节点
</node>

[[node="doc:03-build:3.1"]]   → 结构引用：渲染成一个链接，不复制正文
[[tscl="fact:abi"]]           → 值嵌入：把 <tscl id="fact:abi"> 的定义体替换进来

<tscl id="fact:abi">
三条硬规则：…（这个 id 全库只能定义一次）
</tscl>
```

一条原则：**结构用节点（链接），值用 tscl（嵌入）**。同一个数字/结论写两遍就是漂移，
`kb_diag` 会报；写成 `<tscl>` 定义后各处只留一个引用，改一处全库同步。

硬规则：`<node>` / `</node>` 必须各占整行；`<tscl>` 内部不做结构解析（里面的 `##` 不算标题）；
同一 `tscl` id 全库只能定义一次，且不能与节点 TID 同名。

定义也可以**就地写在句子中间**，渲染时标签被剥掉、值留在原处：

```md
当前版本号为：<tscl id="fact:ver">v1.23.45</tscl>，向下兼容 v1.22。
ABI 校验见 [[tscl="fact:ver"]]。
```

句内定义**必须单行闭合**（行首的 `<tscl>` 才有跨行保护）；定义别写进表格行（`|` 会破格，
`kb_diag` 会 warning）。要核一个值，`kb_read target=<定义 id>` 直接回
「定义体 / 定义在哪个节点 / 被谁引用」。

旧写法 `[[TID]]` 仍兼容（有定义时当宏、否则当链接），`kb_diag` 会 warning，2.0 移除。

## 自检（不装 DSH 也能跑）

```bash
node scripts/check.mjs      # 292 项：清单契约 / 工具 / 路由 / 客户端槽位 / 改名改写 / 建库写库 / tscl / 提示词段落 / 随包技能
node test/parity.mjs        # 与 Python 原实现逐条对拍（需要 python 与 nodekb 源码）
```

`scripts/check.mjs` 在 vm 里跑客户端 bundle，捕获 `__ModuleLoader__.load({id, factory})`，
断言 `id === package.json.name`（写错这个 id 会报 `bundle loaded without registering`）。

装进 DSH 之后，四个端点就地自证（`http://127.0.0.1:<端口>/nodekb/api/`）：

| 端点             | 说明什么                                               |
| ---------------- | ------------------------------------------------------ |
| `/version`       | 活着的处理器是哪一版（热载后旧路由可能还在，用这个认） |
| `/tools`         | 宿主收下几个 `kb_*`，被拒的是哪个                      |
| `/prompt`        | 系统提示词段落挂上没有                                 |
| `/skill`         | 随包 Skill 有没有进宿主技能表                          |
| `/client-report` | 浏览器侧槽位注册到了哪一步（图标不出现时看这个）       |

## 边界

- **写操作有边界**：`kb_init` 只建骨架（不覆盖），`kb_write` 只写库内路径（越界直接拒绝），`kb_rename` 负责改名的引用搬迁。其它随意改写仍可走 `write` / `edit`，只是没有校验。
- **不做自动记忆**：不抓会话、不后台扫描。库里的内容是人（或 Agent 显式）放进去的。
- **零依赖**：不 import 任何 `@deepseek-ai/*`，不声明 peerDependencies。
- 缓存按全库 md 的 `mtime/size` 签名失效，不依赖 `fs.watch`。

## 对 DSH 版本的依赖面

插件只碰宿主 8 个 API，全部集中在 `lib/host/`。哪一条变了、坏到什么程度，都在这张表里：

| 宿主 API                                                | 用在哪                   | 变了会怎样                                                  | 已有的隔离                                                            |
| ------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `apply(ctx, config)` + `inject = ['tools','webServer']` | `lib/index.js`           | 服务名不存在 → 整行不激活（**静默不加载**，DSH 仍正常启动） | 静态 inject，不抛错                                                   |
| `ctx.tools.register(def)`                               | `lib/host/tools.js`      | 定义字段被拒收 → 该工具消失                                 | **逐条注册**，一条失败不影响其余；`GET /nodekb/api/tools` 报 `failed` |
| `ctx.webServer.register({kind:'prefix',…})`             | `lib/host/routes.js`     | 注册被拒 → 面板无数据，工具照旧                             | 异常被吞，`globalThis` 跳板让旧路由转发到新处理器                     |
| `ctx.inject([...], cb)`                                 | `prompt.js` / `skill.js` | 动态注入不可用 → 段落/技能不注册                            | 退回同步取值；仍失败只告警                                            |
| `ctx.systemPrompt.section({name,order,text})`           | `lib/host/prompt.js`     | 段落不出现 → Agent 不优先用它（工具仍在）                   | 失败被吞，`/api/prompt` 自证                                          |
| `ctx.skills.register({…})`                              | `lib/host/skill.js`      | 写法规范不进技能目录                                        | 失败被吞，`/api/skill` 自证                                           |
| `exec.workspace / cwd / session`                        | `lib/host/runtime.js`    | 定位不到工作区 → 默认库位置错                               | 4 级回退：exec → config → env → 上次工具用过的 → 进程 cwd             |
| `window.__ModuleLoader__.load({id,factory})`            | `lib/client.js`          | id 不匹配 → `bundle loaded without registering`             | 自检断言 id === 包名                                                  |
| `ctx.slots.inject` / `slots.register`                   | `lib/client.js`          | 槽名或 props 改名 → 图标不出现                              | 走 official `inject`，失败写 `/api/client-report` 并在面板内自述      |

**引擎与数据格式不依赖 DSH 任何东西**（纯 `node:fs` + `node:path`），所以数据侧不会被宿主版本变化波及。

## 卸载之后

`.nodekb/` 就是普通 Markdown 目录，没有任何私存格式：

- 直接 `read` / `grep` / `edit` 照常，`[[TID]]` 退化成普通文本（不再展开、不再校验）。
- Python 版 nodekb（MCP）读同一个库，格式一致——`test/parity.mjs` 16 项对拍守的就是这条。
- 重新装回任意后续版本，库不需要迁移。
- 唯一会变糙的是**维护性**：手改文件后没有 `diag` 兜底，改名要靠手搬引用（`kb_rename` 不在时没人帮你改 `[[old]]`）。

## License

MIT
