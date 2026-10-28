# 库自己的规矩（`.nodekb/rules.json`，1.5.13 起）

`diag_ignore.json` 管「哪些警告别报」，`rules.json` 管「我们这儿必须这么写」。没有这个文件时行为完全不变。

```json
{
  "refStyle": { "default": "plain", "doc": "expand", "lessons": "expand" },
  "limits": { "bytes": { "default": 12288, "lessons": 4096 } }
}
```

- 目录键是文件相对库根的**第一段目录**（`doc`、`lessons`…），库根下的散文件用 `.`；没列出的目录回落到 `default`，连 `default` 都没有就不查。
- `refStyle`：
  - `expand` —— 允许 `[[node="…"]]`；`[[tscl="…"]]` **只允许指向 `fact:` 开头的定义**（随手写的常量不许到处展开）。
  - `plain` —— 不许写 `[[…]]`，要写就写反引号里的纯文本（TID 仍可读，只是不建链接）。
- `limits.bytes`：单个文件的体积上限（字节）。超了报 warning，fix 是「拆成几个文件，或把这条规则改掉」。
- 围栏里的示例、行内代码里的写法都不算违规；报错带库内相对路径与文件行号。
- `rules.json` 写坏了（不是 JSON、字段非法）只报一条 warning，不会让库读不了。

规则是**声明式检查**，插件不会替你自动改写：违规照常报出来，改不改由你决定。

## 换个库抄这里的现成配置

- 单库小项目（值不值得拆）：不用建。
- 多目录、只有 `doc/` 需要展开引用、`lessons/` 要纯文本：`{"refStyle":{"default":"plain","doc":"expand"}}`。
- 文件体积门禁（例如 doc 12 KB、lessons 4 KB）：`{"limits":{"bytes":{"default":65536,"doc":12288,"lessons":4096}}}`。
