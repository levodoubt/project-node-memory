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
- 每个读命令都支持 `--json`，字段与工具层 `format: "json"` 一致（`{tid, source, lines, chars, hits, …}` / diag 的 `{errors, warnings, advice, exit_code}`），脚本里直接 `JSON.parse` 判分支。
- 退出码：`0` 成功 / `1` 无命中或无变更 / `2` 参数错或自检有 error。
- 批量改名的计划文件：`[{target, new_name}]` 或 `{"renames":[…]}`（也接受 `[["doc/a.md","b"]]`）；逐条重读库、中途失败即停，回执里写明前几条已落盘。**先跑 `--dry-run` 看一眼会改哪些引用。**
