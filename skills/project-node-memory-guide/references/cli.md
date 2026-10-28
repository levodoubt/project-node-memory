# 命令行（`nodekb`，1.5.12 起）

不在 DSH 里也能用同一套引擎：脚本、CI、别的 agent 平台调 `nodekb` 即可，**不要**再自己写 `kbq.py` / `kb_lint.mjs` / `kb_diag_dir.mjs` 这类包装器（本机五个库各自造过一轮，全部是同一个缺口）。

| 命令 | 作用 |
| --- | --- |
| `nodekb list [--all]` | 列可用的库（`--all` 连全局登记一起列） |
| `nodekb read <TID\|定义id>` | 同 `kb_read`：`--node/--toc/--raw`、`--offset/--limit`、`--find 词` |
| `nodekb search <查询>` | 同 `kb_search`：`--lines`、`--type`、`--limit` |
| `nodekb backlinks <TID\|定义id>` | 同 `kb_backlinks` |
| `nodekb diag [--strict]` | 同 `kb_diag`，退出码 0/2 |
| `nodekb write <TID\|相对路径>` | 同 `kb_write`：`--mode`、`--content/--file/--stdin` |
| `nodekb rename <目标> <新文件名>` | 同 `kb_rename`，`--dry-run` 只报不动；`--batch 计划.json` 批量改 |
| `nodekb vcs [status\|log] [--count N]` | 快照历史（只读） |

- 库定位：`--kb <库名|库目录|任意目录>`；省略时用当前目录的 `.nodekb`。命令行里**显式给路径**就是授权，所以不像工具层那样受工作区白名单限制；按名字找库时才用当前目录的发现结果。
- **库名与工具层一致（1.5.15 起）**：插件在宿主里启动时把生效配置抄到 `~/.dsh/nodekb/config.json`（只抄 `registries` / `libraries` / `workspace` / `exclude` / `advice`），命令行读它——于是工具层认的 `kb="filmmeasure"`，`nodekb diag --kb filmmeasure` 也认，不必每次手写绝对路径。`NODEKB_CONFIG=<文件>` 可指定另一份；`libraries` 里写技能目录或 `.nodekb` 本身都行。宿主没启动过（没这份文件）时，命令行仍能按当前目录发现库、按路径打开。
- `--toc` 默认只往下展开两层（`--depth N` 调，`0` = 只列目标节点本身）；目录是定位用的，整支递归在大库上一次就是上千 token。有子节的节点头部会多报一个「整支 N 字符」（自身 + 全部后代）——目录节点自身是 0 字符，靠这个数才知道值不值得点进去。
- `--find 词` 与 `kb_read find=` 同一个实现：整串没中时按词退让（每个词都要出现、不限顺序），回执写明用了哪几个词。命中给的是**文件行号**，只在当前解析快照内有效，别写进文档。
- `--diag` 会把 advice 一起算出来（阈值/开关来自配置里的 `advice`），并且与 `kb_diag` 同构：插件升级后第一次运行同样会在 advice 最前面给一条一次性的 `plugin-updated`。
- 每个读命令都支持 `--json`，字段与工具层 `format: "json"` 一致（`{tid, source, lines, chars, hits, …}` / diag 的 `{errors, warnings, advice, exit_code}`），脚本里直接 `JSON.parse` 判分支。`--out 结果.json` 会按后缀自动当 `--json`，不必再补。
- Windows 上别用管道接中文 JSON（PowerShell 按 CP936 收 UTF-8 会 `ArgumentException`）：`--out 结果.json` 直接落文件，回执给相对路径与字符数。
- 退出码：`0` 成功 / `1` 无命中或无变更 / `2` 参数错或自检有 error。
- 批量改名的计划文件：`[{target, new_name}]` 或 `{"renames":[…]}`（也接受 `[["doc/a.md","b"]]`）；逐条重读库、中途失败即停，回执里写明前几条已落盘。**先跑 `--dry-run` 看一眼会改哪些引用。**
