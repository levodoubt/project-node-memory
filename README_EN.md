# project-node-memory

> [简体中文](README.md) · English

A DSH plugin that treats **a directory of Markdown as a database**: ten `kb_*` tools for the agent, and a node panel for humans (sidebar entry: 「项目节点知识库」).

No index database, no embeddings, no background process. The library *is* the `.nodekb/` directory in your project — a pile of Markdown files that stay ordinary Markdown if you uninstall the plugin.

## Why an agent needs it

By default an agent reaches for `read` / `grep` / `glob`, and pays for **trial and error**: grep finds five files, it reads each one, and only then discovers that one paragraph was the answer. nodekb collapses that into four moves:

| Capability | Tool | What it saves |
|---|---|---|
| Look at structure before text | `kb_read mode=toc` | A ~200-token outline instead of a full read |
| Stable TID addressing (`doc:03-build:3.1`) | `kb_read target=…` | No line-number drift; moving text doesn't break references |
| In-place reference expansion (transclusion) | `kb_read mode=subtree` | Assembled context in one call instead of manual stitching |
| Structure self-check | `kb_diag` | Dangling refs, refs to positional sections, cycles, orphans — check right after editing |

There is a hard size gate too: a `mode=subtree` render above `maxlen` (default 50,000 characters) fails loudly and tells you to use `toc` / `node` instead of silently truncating.

## Making the agent actually use it

A tool description is only read *after* the agent has already decided "I should record knowledge". Getting it to prefer this path takes four layers:

1. **A system-prompt section** (on by default, `prompt.enabled=false` to disable).
   It is present every turn, and the rule is five lines: to record something use `.nodekb/` + `kb_*`, don't hand-roll `docs/*.md` with `write`.
   The section is ~450 characters; `GET /nodekb/api/prompt` proves whether it registered.

2. **Make "create a library" one call.**
   `kb_init` lays out `doc/ lessons/ todo/ index/entry.md` plus the placement conventions in `.nodekb/README.md` (idempotent, never overwrites). Without it, the agent invents its own directory structure.

3. **Writes go through a tool too.**
   `kb_write` validates TID syntax, that `<node>` / `</node>` sit on their own lines, and that the path stays inside the library — then runs `diag` immediately and reports dangling refs and duplicate blocks. Plain `write` has no such layer, so the rules survive only by memory.

4. **A bundled skill, `project-node-memory-guide`** (loaded on demand).
   The prompt section is five lines; the writing conventions (how to split files, how to name TIDs, what to read before writing, three anti-patterns) live in `skills/project-node-memory-guide/SKILL.md`.
   It works out of the box with **no manual step**: when the host exposes a `skills` service, the plugin registers the body in memory via `ctx.skills.register()` (no prompt cost until used, withdrawn when the plugin is disabled). `skill.enabled=false` disables it; `GET /nodekb/api/skill` proves whether it registered.

   > Note: DSH discovers skills only from `$DSH_HOME/skills`, `<workspace>/.dsh/skills`, and paths declared explicitly in a preset. It **does not** scan a `skills/` directory inside an npm package, so shipping `SKILL.md` in the tarball is not enough by itself. Either register it in memory (this plugin) or copy it into the user's skill root at startup (which leaves files behind in the home directory).

## Install

```bash
dsh plugin add project-node-memory      # once published to npm
```

From source (development):

```bash
npm pack                       # produces project-node-memory-<version>.tgz
dsh plugin add ./project-node-memory-<version>.tgz
```

> Install the packed `.tgz`, not the source directory: a directory install is a **link dependency**, and moving or deleting that directory stops DSH from starting. Host-side changes need a DSH restart; panel changes hot-reload on reinstall.

## Configuration

All optional, under `config:` on the plugin's row in `cordis.patch.yml`:

| Key | Default | Effect |
|---|---|---|
| `workspace` | none (auto-detected) | Overrides "the workspace"; see the resolution order below. Tool calls prefer the session header's cwd |
| `libraries` | none | `name: directory` pairs registering libraries outside the workspace (each needs a `.nodekb/`) |
| `registries` | workspace `.nodekb/registry.json` + user-global registry | Extra `kb_registry.json` files (same format as the Python build) |
| `exclude` | see below | Directory names skipped during discovery (`*` wildcard; `!pattern` forces inclusion) |
| `prompt.enabled` | `true` | Register the system-prompt section |
| `skill.enabled` | `true` | Register the bundled skill with the host `skills` service |
| `git` | `true` | Embedded git snapshots: auto-commit after each `kb_write`; set `false` to disable |
| `advice` | `{ minFragNodes: 10, fragChars: 500, longSection: 10000, maxItems: 5 }` | Thresholds and cap for the `advice` tier of `kb_diag` |

`exclude` defaults to `tmp`, `tmp_*`, `temp*`, `.tmp*`, `*_probe`, `nodekb_lab`, `__pycache__`, `_release_assets`, `venv`. A `.nodekb` inside a scratch or probe directory is usually leftover from an experiment; listing it only clutters the selector. Use `"!tmp_keep"` to force one back in, and plain names to add more:

```yaml
config:
  exclude: ['tmp_*', '!tmp_keep', 'scratch']
```

## Panel

The sidebar gains an icon (「项目节点知识库」); opening it gives a three-column center panel:

- **Left**: node tree (`title · type · chars`), a search box that swaps in a hit list on Enter; below it **graph settings** — layout direction (vertical/horizontal), expansion depth, type filters (click to hide a type), expand-all / fit-view.
- **Middle**: the **node graph**. A deterministic tree layout (parents left, children right — or top-down), node boxes stroked by type, wheel to zoom, drag to pan, click to select, double-click to collapse a branch; `+ / − / fit` and the current zoom ratio sit bottom-right.
- **Right**: node content on top (**Markdown rendered**, `[[TID]]` clickable) and node properties below (tid, type, parent, source file line, chars, child sections, backlinks, rename button). The "raw" and "source" views stay monospace plain text.

The Markdown renderer is a small home-grown one (headings, lists, code, tables, quotes, emphasis, links). **LaTeX goes through MathML**: `$…$` inline, `$$…$$` and ```math fences as display blocks. No KaTeX, no font files — layout is handed to the browser's native MathML engine. Supported subsets include fractions, roots, super/subscripts, Greek letters, ∑∏∫, matrices (pmatrix/bmatrix/vmatrix), cases, `\left…\right`, `\text{}`, `\mathrm/\mathbf/\mathbb`; unknown commands render literally instead of crashing.

The panel is read-only; data flows through host routes under `/nodekb/api/*`. Writing a library means writing Markdown — via `write` / `edit`, or `kb_write`.
The right column renders at most 10,000 characters per view (with a truncation notice); wide tables scroll horizontally and long text scrolls vertically.

## The tools

| Tool | What it does |
|---|---|
| `kb_list` | Which libraries exist (absolute paths and origins) plus the workspace this call resolved to. Call this first when unsure what `kb` to pass |
| `kb_read` | `target` + `mode` (`subtree` default / `node` / `toc` / `raw`) + `maxlen` |
| `kb_search` | CJK-friendly retrieval (2-gram index + multi-term weighting + substring fallback), returns stable TID, type, source line, snippet |
| `kb_diag` | Structure self-check in three tiers: `errors` / `warnings` / `advice`; `advice` is "could be leaner" guidance and never affects the exit code |
| `kb_backlinks` | Who references this node. Run before renaming a TID or deleting a node |
| `kb_init` | Scaffold `.nodekb` (idempotent): `doc/ lessons/ todo/ index/` plus placement conventions; `parts` narrows which directories it lays out |
| `kb_register` | Register an existing library in the **project's own** `kb_registry.json` (never the global registry or the plugin config) |
| `kb_write` | Write into the library: `append` / `replace` / `create` / `node` (rewrite one `<node>` block or `##` section in place); validates, self-checks, **auto-snapshots** on success |
| `kb_rename` | Rename a file and rewrite every reference pointing at it; re-reads before writing, so concurrent edits are never clobbered |
| `kb_vcs_status` | Recent snapshots + uncommitted changes of the library's embedded git repo (`count` defaults to 5); `kb_write` / `kb_rename` snapshot automatically, `git: false` turns it off; explains itself when git is missing |

### The three tiers of `kb_diag`

- `errors` — dangling refs, duplicate TIDs, duplicate definitions, tree cycles: the structure is broken, must fix.
- `warnings` — legacy bare refs, links to positional TIDs, multi-line macros inside table cells, orphan nodes: fix as needed.
- `advice` — **written correctly but could be leaner**, five kinds: ≥10 Markdown files under one parent whose **whole text** is under 500 chars (counted as preamble + all `##` sections + `<node>` bodies, so "one file per chapter" is never misjudged as fragmentary), the same sentence spread across several nodes (promote to a `<tscl>` definition), a library without `index/entry.md`, Markdown without an H1, a section longer than 10000 characters (its `fix` notes that splitting a section shifts positional TIDs). Every item carries a `fix` and **never affects `exit_code`**, so CI can ignore it.

A `##` section's parent is **always the file node**: "organise by `##`" and named `<node>` anchors can coexist in one file, and the TOC lists them as siblings instead of chaining `3.1 → lesson1 → 3.2`.

A default `parent` follows **structure**, not "the first `<node>` in this file": sibling `<node>` blocks written at file level all hang off the file node, while a `<node>` written *inside* another one hangs off that outer node (flat = parallel, nested tags = nested nodes). `###` and deeper are **not nodes and not section boundaries** — they stay part of the `##` section's body, so referencing `doc:x:1.1` reports a stale TID prefix. The advice knobs (`minFragNodes`, `fragChars`, `longSection`, `maxItems`) can be overridden under `advice: { … }` in the plugin config.

After a plugin upgrade, the first `kb_diag` adds a `plugin-updated` item asking the agent to re-read the bundled skill — once per library (state lives in `.nodekb/.plugin-state.json`, which is git-ignored).

## How a library is located

Every `kb_*` tool takes exactly one location parameter, `kb`, which accepts **either a name or a path**:

1. `kb` = a path (a skill directory or its `.nodekb`, absolute or workspace-relative) — must fall inside the session workspace, any registered workspace, or a registered library.
2. `kb` = a name (from a registry, or discovered in the workspace, e.g. a skill name).
3. Neither — the workspace's own `.nodekb/` → the single library discovered in the workspace → the single registered library.

### Discovery

Given a workspace, it looks beyond the root at conventional locations (bounded BFS, depth 2 by default):

```text
<ws>/.nodekb                          → name "workspace"
<ws>/.dsh/skills/<skill>/.nodekb       → name "<skill>"
<ws>/<subdir>/.nodekb                  → name = relative path
<ws>/<subdir>/.dsh/skills/<skill>/.nodekb
```

It skips `node_modules` / `dist` / `build` / `out` / `target` / `coverage` / dot-directories and caps `readdir` calls, so the panel can afford to run it on every load. That is what "the knowledge base travels with the project" means: point at a project root and the `.nodekb/` directories inside skills surface on their own.

A library can carry two names (the discovered one plus the registry one). `kb_list` **merges them into one row**, printed as `- <discovered name>  <path>  (aliases: <registry name>)` — otherwise the names you can actually pass to `kb=` are invisible in the listing and you have to guess from memory.

### Registries

Registries use the same format as the Python build's `kb_registry.json`; by default the plugin reads `.nodekb/registry.json` in the workspace and the global registry in the user directory. Libraries can also be declared inline:

```yaml
- insert:
    - id: nodekb
      name: project-node-memory
      config:
        libraries:
          my-notes: D:\notes      # name → directory (must contain .nodekb/)
        registries:
          - D:\shared\kb_registry.json
```

### Resolving the workspace

"The workspace" is the basis for both library resolution and the writable allowlist:

1. **the session header's `cwd`** (for tool calls) — `exec.agent.id` → `ctx.get('sessions').get(id).header.cwd`. This is the only reliable source: the `exec` DSH hands a tool has no `cwd`/`workspace` field at all.
2. an explicit directory in `exec` (the `ws` a panel request carries).
3. `config.workspace`.
4. the `DSH_NODEKB_WORKSPACE` environment variable.
5. only for the panel (which has no session): the workspace of the most recent tool call; last resort, the process cwd.

Every `kb_list` / `kb_init` receipt states which workspace was used and which layer it came from; `GET /nodekb/api/where` reports the same.

When creating or writing, `kb_init` refuses a target inside **another** registered workspace and prints both paths — so a relative path can never silently land in another project. To work there, open a session in that project; or use `kb_register` to register an existing library with the current project.

`kb_register` writes only `<project>/kb_registry.json` (commit it), never the global registry or the plugin config — permissions become solvable from inside the tool set.

The panel has no session context, so it follows **the workspace of the most recent `kb_*` tool call** (whichever project the agent read, the panel shows). The directory dropdown in the header lists only projects DSH has used **that actually contain a `.nodekb`**, annotated with how many libraries each has; the 「目录」 button lets you type a path. The choice is stored in browser localStorage and affects the panel only, never the tools.

The two panel dropdowns are linked: **workspace → libraries in that workspace** (`GET /nodekb/api/libs?scope=workspace`), while globally registered libraries get their own "global registrations" group; registrations whose path no longer exists are hidden (`exists:false`).

To see which workspace a request finally resolved to, call `GET /nodekb/api/where`: it prints config / env / exec / last-used / process cwd together with the verdict.

### What "register" actually means

You can skip registration entirely — a library sitting in a conventional location inside the workspace (see above) shows up in the listing anyway. `kb_registry.json` exists for libraries **outside** the workspace (another project on another drive, a shared notes directory):

```json
{ "libraries": { "my-notes": { "path": "D:\\notes" } } }
```

Read order: `config.libraries` → files named by `config.registries` → `<ws>/.nodekb/registry.json` → `<ws>/kb_registry.json` → the user-global registry (`~/.dsh/nodekb/registry.json`). Registered names outrank auto-discovered names, and for duplicate paths the first one wins.

Add `"hidden": true` to an entry to keep it as an **alias only**: `kb="my-notes"` still resolves (old docs keep working) but it never shows up in the panel's library picker or in `kb_list` (unless `includeHidden`). A non-hidden registration pointing at an already-discovered library is merged into that library's row as `(aliases: …)`.

```json
{ "libraries": { "my-notes": { "path": "D:\\notes", "hidden": true } } }
```

## Syntax

```md
## 3.1 Compile contract     → node tid = doc:03-build:3.1 (positional)
<node name="fact:abi" type="fact" parent="doc:03-build">
body                                    ← explicit node
</node>

[[node="doc:03-build:3.1"]]   → structural reference: becomes a link, body is NOT copied
[[tscl="fact:abi"]]           → value embed: the body of <tscl id="fact:abi"> is substituted

<tscl id="fact:abi">
three hard rules: … (this id may be defined exactly once per library)
</tscl>
```

One rule of thumb: **structure is a node (link), a single value is tscl (embed)**. Writing the same number or conclusion twice is drift and `kb_diag` reports it; define it once as `<tscl>` and leave references at every use site, so a single edit updates the whole library.

Hard rules:

- `<node>` / `</node>` must each occupy an entire line.
- Nothing inside `<tscl>` is parsed as structure (a `##` there is not a heading).
- A `tscl` id may be defined exactly once per library and must not collide with a node TID.
- `<node tid="…">` and `<node name="…">` are equivalent (`title="…"` gives a display name).
- A `<node>` without `name`/`tid` falls back to plain body text and raises a `kb_diag` warning — it never vanishes silently, and `</node>` never leaks into the text.

Fences (``` or ~~~, closing fence same char and at least as long) and `` `inline code` `` are opaque everywhere: `[[…]]`, `<node>`, `<tscl>` and `#` inside them are examples — not parsed, not counted as references, not counted as definitions, not renamed. You never have to switch to full-width brackets when writing docs.

Explicit node TIDs **need no colon** (`<node name="abi">` → TID `abi`), and attribute values accept single or double quotes alike. `kb_write`'s `target` resolves as: an existing TID → a root file name → a path (`.md` appended); anything else is refused instead of creating a stray file at the library root that the parser cannot see.

### Four write-time guards

All of them belong to the "reported success, library corrupted" family, added in 1.5.5:

1. `content` is normalised to LF first and re-joined with the file's own newline style — never `\r\r\n`; an `append` gets its trailing newline from the tool, so a CRLF file never ends up with a bare `LF`.
2. `content` containing `</node>` is refused (that tag belongs *outside* the node — writing it truncates the node); `<node>` / `<tscl>` open tags must be balanced (an unclosed one swallows whatever follows). Legal forms stay legal: a single-line `<node name="x">text</node>`, and a line-start `<tscl id="v">1</tscl> trailing prose`. A whole-file `mode=replace` is exempt from the balance check — there the author is in charge.
3. Paths must end in lowercase `.md` and no segment may start with a dot (`.draft/x.md`, `.hidden.md` are skipped by the parser, so writing there produces an invisible file).
4. Receipts print `/`-separated paths; a section write adds "heading / blank / body / blank" and rewriting it repeatedly never piles up blank lines.

Unclosed structure that gets in by hand edit, `git merge`, or the `mode=replace` escape hatch is caught by the parser itself: `kb_diag` reports an unclosed `<node>` / `<tscl>` as an **error** (before 1.5.6 it was 0 error / 0 warning while section nodes silently disappeared).

Write-time validation uses the parser's own rules (1.5.7): `<node>` / `<tscl>` inside fences or **inline code** is an example, not structure, so prose that teaches the syntax may spell it out; error line numbers refer to the `content` you passed (leading/trailing blank lines excluded), so you no longer get "says line 7, the problem is line 8".

TIDs support prefix fallback: `kb_read target=doc:02` matches `doc:02-runtime-environment` (when the prefix is ambiguous across files/folders it still errors and lists candidates).

### Inline definitions

A definition may also sit **inline in the middle of a sentence** — the tags are stripped when rendered and the value stays where it is written:

```md
Current version: <tscl id="fact:ver">v1.23.45</tscl>, backward compatible with v1.22.
ABI check: [[tscl="fact:ver"]].
```

An inline definition **must close on the same line** (only a line-start `<tscl>` gets cross-line protection), and it must not go into a table row (a `|` inside the body breaks the row; `kb_diag` warns). To check one value, `kb_read target=<definition id>` returns the body, where it is defined, and who references it.

The old `[[TID]]` form still works (macro when a definition exists, link otherwise) with a `kb_diag` warning, and goes away in 2.0.

## Self-check and endpoints

No DSH required:

```bash
node scripts/check.mjs      # full self-check: manifest contract / tools / routes / client slots / rename rewriting / scaffold + write / tscl / prompt section / bundled skill (prints "N passed")
node test/parity.mjs        # case-by-case parity against the Python implementation (needs python and nodekb sources)
```

`scripts/check.mjs` runs the client bundle in a `vm`, captures `__ModuleLoader__.load({id, factory})`, and asserts `id === package.json.name` (getting that id wrong yields `bundle loaded without registering`).

Once installed, five endpoints testify in place (`http://127.0.0.1:<port>/nodekb/api/`):

| Endpoint | What it proves |
|---|---|
| `/version` | Which version the live handler is (after a hot reload the old route may still be serving) |
| `/tools` | How many `kb_*` tools the host accepted, and which were rejected |
| `/prompt` | Whether the system-prompt section is attached |
| `/skill` | Whether the bundled skill reached the host skill table |
| `/client-report` | How far client-side slot registration got (look here when the icon is missing) |

## Boundaries

- **Writes are bounded**: `kb_init` only scaffolds (never overwrites), `kb_write` only writes inside the library (out-of-bounds paths are refused), `kb_rename` handles reference migration on rename. Anything else can still go through `write` / `edit` — just without validation.
- **No automatic memory**: it does not capture sessions or scan in the background. Whatever is in the library was put there by a human or by an explicit agent action.
- **Zero dependencies**: imports nothing from `@deepseek-ai/*`, declares no peer dependencies.
- The cache invalidates on a whole-library `mtime/size` signature; it does not use `fs.watch`.

## Host API surface (version-compatibility)

The plugin touches eight host APIs, all under `lib/host/`. What breaks, and how badly, is this table:

| Host API | Used in | If it changes | Isolation already in place |
|---|---|---|---|
| `apply(ctx, config)` + `inject = ['tools','webServer']` | `lib/index.js` | Service renamed → the row never activates (**silently absent**; DSH still boots) | Static inject never throws |
| `ctx.tools.register(def)` | `lib/host/tools.js` | Definition rejected → that one tool disappears | **Registered one by one**; `GET /nodekb/api/tools` reports `failed` |
| `ctx.webServer.register({kind:'prefix',…})` | `lib/host/routes.js` | Registration refused → panel has no data, tools unaffected | Errors swallowed; a `globalThis` trampoline forwards old routes to the newest handler |
| `ctx.inject([...], cb)` | `prompt.js` / `skill.js` | Dynamic injection unavailable → section/skill not registered | Falls back to a direct service lookup; failure only warns |
| `ctx.systemPrompt.section({name,order,text})` | `lib/host/prompt.js` | Section missing → agent won't prefer it (tools still work) | Failure swallowed; `/api/prompt` testifies |
| `ctx.skills.register({…})` | `lib/host/skill.js` | Conventions skill never appears | Failure swallowed; `/api/skill` testifies |
| `exec.workspace / cwd / session` | `lib/host/runtime.js` | Workspace unresolvable → wrong default library | Four-stage fallback: exec → config → env → last used → process cwd |
| `window.__ModuleLoader__.load({id,factory})` | `lib/client.js` | id mismatch → `bundle loaded without registering` | Self-check asserts id === package name |
| `ctx.slots.inject` / `slots.register` | `lib/client.js` | Slot name or props renamed → icon missing | Uses the official `inject`; failures go to `/api/client-report` and are described in the panel |

**The engine and data format depend on nothing from DSH** (pure `node:fs` + `node:path`), so the data side is unaffected by host version churn.

## After uninstalling

`.nodekb/` is an ordinary Markdown directory with no private format:

- `read` / `grep` / `edit` work as before; `[[TID]]` degrades to plain text (no expansion, no validation).
- The Python build (MCP) reads the same library — the formats are identical, which is what the 16 parity cases in `test/parity.mjs` guard.
- Reinstalling any later version needs no migration.
- Only **maintainability** degrades: no `diag` net after hand edits, and renames no longer rewrite `[[old]]` for you while `kb_rename` is gone.

## License

MIT
