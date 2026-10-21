# project-node-memory

A DSH plugin that treats a **Markdown directory as a database**: 9 `kb_*` tools for the agent, and a three-column panel for humans (sidebar entry: “Project Node KB”).

[npm](https://www.npmjs.com/package/project-node-memory) · [GitHub](https://github.com/doubter439-max/project-node-memory) · [中文](README.md)

> Renamed from `dsh-nodekb` in 0.2.0. Tool names (`kb_*`) and the library format are unchanged.

No index database, no vectors, no background process. The library *is* the `.nodekb/` directory inside your project — a pile of Markdown files that stay plain Markdown after you uninstall the plugin.

```
project/
└── .nodekb/
    ├── index/entry.md        ## 3.1 Compile contract
    ├── doc/03-build.md       <node name="fact:abi" type="fact">…</node>
    ├── lessons/001.md
    └── diag_ignore.json      optional: boilerplate exemptions
```

## Why an agent needs it

An agent finds things with `read` / `grep` / `glob`, and pays for it in **probing**: grep hits five files, it reads all five, and only one paragraph mattered. nodekb collapses that into four moves:

| Capability | Tool | What it saves |
|---|---|---|
| See the structure before reading prose | `kb_read mode=toc` | one ~200-token outline instead of a full read |
| Stable TID addressing (`doc:03-build:3.1`) | `kb_read target=…` | immune to line drift; editing a file does not break references |
| References expand in place (transclusion) | `kb_read mode=subtree` | one assembled context instead of manual pasting |
| Structural self-check | `kb_diag` | dangling refs, refs to positional sections, cycles, orphans — checked right after every edit |

There is a hard stop on size: `mode=subtree` that exceeds `maxlen` (50000 characters by default) **fails loudly** and tells you to switch to `toc` / `node`, instead of silently truncating.

## Making the agent actually use it

Tool descriptions are only read *after* an agent has already decided to write something down. Four layers flip that default:

1. **A system-prompt section** (on by default; `prompt.enabled=false` turns it off) — present every turn, five lines of rules: if you are going to persist knowledge, use `.nodekb/` + `kb_*`, do not hand-build `docs/*.md` with `write`. About 450 characters; `GET /nodekb/api/prompt` reports whether it registered.
2. **Make “create a library” a single call** — `kb_init` lays out `doc/ facts/ lessons/ todo/ index/entry.md` plus the placement conventions in `.nodekb/README.md` (idempotent, never overwrites). Without it, an agent invents its own directory layout.
3. **Writes go through a tool too** — `kb_write` validates TIDs, that `<node>` sits on its own line, and that the path stays inside the library, then runs `diag` immediately and reports dangling refs and duplicate blocks. `write` has no such layer, so the rules would otherwise live only in the agent's memory.
4. **A bundled skill, `project-node-memory-guide` (loaded on demand)** — the prompt section stays at five lines; the writing guide (how to split files, how to name TIDs, what to read before writing, three counter-examples) lives in `skills/project-node-memory-guide/SKILL.md`. It works right after install with **zero manual steps**: when the host `skills` service is available the plugin registers the body in memory via `ctx.skills.register()` (no prompt cost until used, revoked when the plugin is disabled). `skill.enabled=false` turns it off; `GET /nodekb/api/skill` reports whether it registered.

   > Note: DSH discovers skill files only under `$DSH_HOME/skills`, `<workspace>/.dsh/skills`, and paths explicitly listed by a preset. It does **not** scan `skills/` inside an npm package, so shipping a `SKILL.md` alone is not enough — either register it in memory (what this plugin does) or copy it into the user's skill root at startup (which leaves a file behind).

## Install

```bash
dsh plugin add project-node-memory
```

From source (development):

```bash
npm pack                       # produces project-node-memory-<version>.tgz
dsh plugin add ./project-node-memory-<version>.tgz
```

> Always `add` the packed `.tgz`, never the source directory: installing a directory creates a **link dependency**, and moving or deleting that directory afterwards makes DSH fail to start. Host-side changes require a DSH restart; panel changes hot-load on reinstall.

## Panel

A new sidebar icon (“Project Node KB”); it opens a three-column center panel (modeled on nodekb's MCP WebUI):

- **Left**: the node tree (`title · type · chars`) on top, with a search box that switches to a hit list on Enter; **graph settings** below — layout direction (vertical/horizontal), expansion depth, per-type visibility toggles, expand-all / fit.
- **Center**: the **node graph**. A deterministic tree layout (parent left, children right, or top-down), nodes outlined by type, wheel to zoom, drag to pan, click to select, double-click to collapse a branch; `+ / − / fit` and the current zoom level sit in the corner.
- **Right**: node content on top (rendered **Markdown, including LaTeX**; `[[TID]]` links are clickable), node properties below (tid, type, parent, source file line, char count, child sections, backlinks, file rename button). “Raw / source” views stay monospaced plain text.

Markdown is rendered by a small built-in renderer (headings / lists / code / tables / quotes / emphasis / links). **LaTeX goes through MathML**: `$…$` inline, `$$…$$` and ```math fences are display formulas. No KaTeX, no font files — layout is left to the browser's native MathML engine. Fractions, roots, sub/superscripts, Greek letters, ∑∏∫, matrices (pmatrix/bmatrix/vmatrix), cases, `\left…\right`, `\text{}`, `\mathrm/\mathbf/\mathbb` and other common constructs are supported; unknown commands render literally instead of crashing.

The panel is read-only and talks to the `/nodekb/api/*` routes registered by the host half. Writing is writing Markdown — use the `write` / `edit` tools.
The right column renders at most 10000 characters per node (with a truncation notice beyond that); wide tables scroll horizontally and long text scrolls vertically.

## The 9 tools

| Tool | What it does |
|---|---|
| `kb_list` | Which libraries exist and which is the default. Call it when unsure what `kb` to pass |
| `kb_read` | `target` + `mode` (`subtree` default / `node` / `toc` / `raw`) + `maxlen` |
| `kb_search` | Chinese-friendly retrieval (2-gram index + multi-term weighting + substring fallback); returns stable TIDs, types, source lines, snippets |
| `kb_diag` | Structural self-check; fails outright when there are errors, so you do not find out after reading |
| `kb_backlinks` | Who references this node. Run it before renaming a TID or deleting a node |
| `kb_init` | Scaffold a `.nodekb` library (idempotent): `doc/ facts/ lessons/ todo/ index/` plus placement conventions |
| `kb_write` | Write into the library: `append` / `replace` / `create` / `node` (rewrite one `<node>` block in place); validates before writing, self-checks after |
| `kb_rename` | Rename a file node and rewrite every `[[TID]]` reference in the library (including `[[tid:1.2]]`); re-reads before writing, so concurrent edits are not clobbered |
| `kb_vcs_status` | Snapshot history and uncommitted changes of the library's embedded git repo (explains itself when git is missing) |

## How libraries are located

1. `lib` — a path (a skill directory, or the `.nodekb` inside it); it must fall inside the workspace or a registered library.
2. `kb` — a name (from the registry, or discovered in the workspace, e.g. a skill name).
3. Neither — the workspace's own `.nodekb/`, then a single discovered library, then a single registered one.

**Auto-discovery**: once a workspace is known, libraries are not only looked up at its root but also at conventional locations (bounded BFS, depth 2 by default):

```
<ws>/.nodekb                          → name "workspace"
<ws>/.dsh/skills/<skill>/.nodekb        → name "<skill>"
<ws>/<subdir>/.nodekb                  → name "relative/path"
<ws>/<subdir>/.dsh/skills/<skill>/.nodekb
```

`node_modules` / `dist` / `build` / `out` / `target` / `coverage` and dot-directories are skipped, and the number of `readdir` calls is capped, so the panel can call it on every load. That is what “the knowledge base travels with the project” means: point at a project root and the `.nodekb/` libraries inside its skills surface by themselves.

Registries use the same format as the Python edition's `kb_registry.json`; the plugin reads `.nodekb/registry.json` in the workspace and the global registry in your home directory. Configuration can also be inline:

```yaml
- insert:
    - id: nodekb
      name: project-node-memory
      config:
        libraries:
          my-notes: /path/to/notes    # name → directory (which must contain .nodekb/)
        registries:
          - /path/to/kb_registry.json
```

`config.workspace` overrides “the workspace”; by default it is the session workspace, falling back to the process cwd.

The panel has no session context, so it follows the workspace of the **most recent `kb_*` tool call** (whatever project the agent last read is what the panel shows). The directory dropdown in its header lists the project directories DSH has used (each annotated with how many libraries it found), and the “Directory” button lets you type a path. The choice is stored in browser localStorage and only affects the panel, not the tools.

## Syntax (this is all you need)

```md
## 3.1 Compile contract     → node tid = doc:03-build:3.1 (positional, cannot be a reference target)
<node name="fact:abi" type="fact" parent="doc:03-build">
body                                     ← explicit node; references expand only this node
</node>

[[fact:abi]]              → reference; expanded in place when rendered
[[doc:03-build]]          → referencing a file/folder expands the whole subtree
```

Two hard rules: `<node>` / `</node>` must each sit on their own line, and an explicit node name must not collide with a file-derived TID.

## Self-check (runs without DSH)

```bash
node scripts/check.mjs      # 235 assertions: manifest contract / tools / routes / client slots / rename rewriting / init+write / prompt section / bundled skill
node test/parity.mjs        # line-by-line parity against the Python implementation (needs python and the nodekb source)
```

`scripts/check.mjs` runs the client bundle inside a `vm`, captures `__ModuleLoader__.load({id, factory})`, and asserts `id === package.json.name` (getting this id wrong produces `bundle loaded without registering`).

## What it depends on in DSH

The plugin touches 8 host APIs, all under `lib/host/`. This table says what breaks and how far the damage spreads:

| Host API | Used in | If it changes | Existing isolation |
|---|---|---|---|
| `apply(ctx, config)` + `inject = ['tools','webServer']` | `lib/index.js` | service renamed → the row never activates (**silently absent**, DSH still starts) | static inject, never throws |
| `ctx.tools.register(def)` | `lib/host/tools.js` | a definition is rejected → that tool disappears | **registered one by one**; `GET /nodekb/api/tools` lists what failed |
| `ctx.webServer.register({kind:'prefix',…})` | `lib/host/routes.js` | registration refused → panel has no data, tools keep working | exceptions swallowed; a `globalThis` trampoline forwards stale routes to the newest handler |
| `ctx.inject([...], cb)` | `prompt.js` / `skill.js` | dynamic injection unavailable → section/skill not registered | falls back to a direct lookup; failure only warns |
| `ctx.systemPrompt.section({name,order,text})` | `lib/host/prompt.js` | section missing → agent stops preferring it (tools remain) | failure swallowed, `/api/prompt` proves it |
| `ctx.skills.register({…})` | `lib/host/skill.js` | guide missing from the skill catalog | failure swallowed, `/api/skill` proves it |
| `exec.workspace / cwd / session` | `lib/host/runtime.js` | workspace unknown → wrong default library | 5-step fallback: config → env → exec → last tool workspace → process cwd |
| `window.__ModuleLoader__.load({id,factory})` | `lib/client.js` | id mismatch → `bundle loaded without registering` | self-check asserts id === package name |
| `ctx.slots.inject` / `slots.register` | `lib/client.js` | slot name or props renamed → icon does not appear | uses the official `inject`, records failures in `/api/client-report` and explains itself in-panel |

**The engine and the data format depend on nothing from DSH** (only `node:fs` + `node:path`), so host version changes cannot reach your knowledge base.

## After uninstall

`.nodekb/` is an ordinary Markdown tree with no private format:

- `read` / `grep` / `edit` keep working; `[[TID]]` degrades to plain text (no expansion, no validation).
- The Python nodekb editions (MCP) read the same library — the formats match, and `test/parity.mjs` guards exactly that with 16 parity cases.
- Reinstalling any later version needs no migration.
- What degrades is **maintenance**: after hand edits there is no `diag` net, and renaming files leaves `[[old]]` references dangling because `kb_rename` is not there to rewrite them.

## Boundaries

- **Writes are bounded**: `kb_init` only scaffolds (never overwrites), `kb_write` only writes inside the library (out-of-bounds is refused), `kb_rename` handles reference migration on rename. Everything else can still be edited with `write` / `edit` — just without validation.
- **No automatic memory**: it does not capture sessions or scan in the background. What is in the library is what a human (or an agent, explicitly) put there.
- **Zero dependencies**: imports nothing from `@deepseek-ai/*` and declares no peerDependencies.
- The cache is invalidated by a signature over every Markdown file's `mtime/size`; it does not rely on `fs.watch`.

## License

MIT
