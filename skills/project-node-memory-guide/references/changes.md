# 版本升级说明

> 当前推送版本：1.5.18
> 上一推送版本：1.5.8

> 本说明只陈列本次推送版本相比于上一个推送版本的变化，更早的版本变更不记录。

## 1.5.9 — 窗口读与命中行

- `kb_read` 多了 `offset` / `limit`（按行取窗）与 `find`（只回命中行，带文件行号）。长节点不必整段吃。
- 超过 `maxlen` 不再报错截断失败，而是**按行截断 + 结尾给续读用的 `offset`**：先 `kb_read mode=toc` 定位，再按窗读。
- `kb_search lines=true` 给每个命中节点最多 3 条行级命中，省一次 `kb_read`。
- 行号只是**同一次快照内的临时坐标**：文档正文里引用别的节点，仍然只写 TID。

## 1.5.10 — 面板检索态

- 面板里检索后点结果只换预览，不会退出检索；只有搜索框右侧 `×`（或 Esc）才退出。
- 命中词在左侧列表与右栏预览里高亮，点条目会滚到第一处命中。

## 1.5.11 — 节点图方框自适应

- 节点图的方框高度随标题行数变（宽仍是 188），标题最多 30 字符、超出省略，最多 3 行。
- 自动换行不拆连续单词（`pip`、`ASCII`、`kb_read` 整词换行），收尾标点不另起一行。

## 1.5.12 — 命令行、JSON 输出、散文 TID 核对

- 新增 `nodekb` 命令行（`list|read|search|backlinks|diag|write|rename|vcs`），**不再需要自己写包装脚本**：`--kb` 指定库、`--json` 给结构化结果、退出码 0/1/2。详见 `cli.md`。
- 五个读工具与 `kb_diag` 支持 `format: "json"`：直接拿到 `{tid, source, lines, hits…}`，按 `exit_code` 分支，不用再正则拆散文。
- `kb_diag` 的 warnings 多了两类：**散文/行内代码里不可解析的 TID 文本**、**TID 大小写不合规**（TID 一律小写，`doc:031-T7代理` 会被指出来）。围栏里的示例、`[[…]]` 真引用、路径对照不查。
- 豁免写进 `.nodekb/diag_ignore.json` 的第三组 `tids`（正则数组）。

## 1.5.13 — 改名与库规矩

- **只改大小写的改名**可以用 `kb_rename` 了（`031-T7代理.md → 031-t7代理.md`）：TID 本就是小写，引用不动，只改文件系统里的名字。以前在 Windows/macOS 上报「目标已存在」。
- 一次改很多文件用 `nodekb rename --batch 计划.json`（`[{target,new_name}]` 或 `{"renames":[…]}`，也可 `--dry-run` 先演练）；中途失败即停，并说明前面哪几条已落盘。
- 新增 `.nodekb/rules.json`：按目录声明**引用风格**（`plain` 纯文本 / `expand` 允许 `[[node=…]]`，`[[tscl=…]]` 只准指向 `fact:*`）与**文件体积上限**。没有该文件时行为完全不变。详见 `rules.md`。

## 1.5.14 — 本技能瘦身（就是你正在读的结构）

- 技能正文收到 6000 字符以内，明细按需读：`syntax.md`、`write.md`、`diag.md`、`cli.md`、`rules.md`，加上这份 `changes.md`。
- 工具描述与参数描述删掉了与技能重复的部分和过程性说明——**能力没变，只是说明变短了**。
- 升级后第一次 `kb_diag` 仍会多一条 `plugin-updated` 提醒（每个库一次），按它给的链接读回本技能即可。

## 1.5.15 — 库名统一、advice 能看见也能管、段写入认标题

- **命令行认同一套库名**：插件启动时把生效配置抄到 `~/.dsh/nodekb/config.json`，`nodekb diag --kb filmmeasure` 与工具层 `kb="filmmeasure"` 从此同名可用；`config.libraries` 里写技能目录或 `.nodekb` 本身都行。
- **advice 不再是一坨**：`advice.display=false` 整块关掉，`advice.limit` 控条数（`0` = 不限），`diag_ignore.json` 新增 `advice: [{code, tid}]` 逐条豁免。
- **命令行也报 advice**：`nodekb diag` 以前恒为 0 条，阈值也不吃配置；现在与工具层一致。
- **`--out <文件>`**：中文 JSON 过 PowerShell 管道会坏（PS 按 CP936 收 UTF-8），直接落文件，回执给相对路径与字符数；文件是干净 UTF-8、不带 BOM。
- **目录视图默认折叠**：`mode=toc` 只往下展开两层（`depth` 可调，`0` = 只列目标节点），大库不再一次吐上千 token。
- **段写入认标题**：首行给同级或更浅的标题就连标题一起换（改段名不必整篇 `replace`）；贴回本段同名标题会被剥掉；给更深标题仍拒绝。
- **举例不再被当成错链接**：悬空引用的报错直接说明「要么写错、要么只是举例——举例请用反引号」，同一处也不会再被「不可解析的 TID 文本」重复报一遍。

## 1.5.16 — 目录能看出值不值得点、find 不再挑词序

- `kb_read mode=toc` 对**有子节**的节点多报「整支 N 字符」（自身 + 全部后代）：目录节点自身是 0 字符，光看原来的数字判断不出底下有多厚。
- `kb_read find=` 整串没中时按词退让（每个词都要出现、不限顺序）：`Fresnel coefficient` 能找到 `Fresnel reflection coefficient`；退让后仍为空才报未命中。
- `plugin-updated` 提醒搬到 `lib/engine/notice.js`，`nodekb diag` 与 `kb_diag` 同构；`nodekb … --out 结果.json` 自动当 `--json`。

## 1.5.17 — 一份实现、一种豁免、一份库的记忆

- **`find` 只有一份实现**：宿主 `kb_read` 以前直接调 `findLines`，工具描述里写的「按词退让」在宿主层不生效；现在两边都走 `search.js` 的 `findWithFallback`。
- **`example-tscl` advice**：行首写一个 `<tscl id="示例">` 会真的开定义块，把后面的章节全吞进定义体。定义体里出现围栏外的 `##` 标题或 `<node>` 时提示「多半是把示例写成了定义」，并给出放围栏 / 改成行内写法的修法。
- **`diag_ignore.json` 新增 `warnings` 组**：整条警示文案按正则豁免（如 `^不可解析的 TID 文本`），比 `tids` 粗、能不用就不用；「内容重复」「节点内重复行」的报错也会顺带告诉你这条通道。
- **跨项目的库有记忆**：以前打开过的库记进 `~/.dsh/nodekb/index.json`，`kb_list` 与 `nodekb list` 末尾提醒「另有 N 个库不在本工作区」（附名字与目录）；它不参与解析，用的时候仍要传路径。夹具/测试库不记。

## 1.5.18 — 升级提醒的四个边界

- **命令行也吃 `advice.limit`**：`plugin-updated` 与改进建议已归一为同一个 `withNotice()`，两边都按上限截断；以前命令行只 `unshift` 不截，同一个库两条入口的条数不一样。
- **带 BOM 的状态文件不再被当成「1.5.0 之前」**：读 `.nodekb/.plugin-state.json` 时先剥 BOM（PowerShell 写过的文件会带），文案不再错报旧版本。
- **状态写不进去会说**：只读库、权限不足时回执追加「（状态文件写不进去，下次还会提醒）」，不再每跑一次都静默重复同一句。
- **口径写明**：这条提醒**不受** `advice.display` 控制（那个开关只关改进建议），但计入 `advice.limit` / `maxItems`。
