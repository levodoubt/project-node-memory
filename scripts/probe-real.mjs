/**
 * 真实库探针：不开服务器，直接用引擎读一个装机库并算一次改名计划。
 *
 * 用途：重启前就能验证「rename / render / diag 在真实数据上跑得动」，
 * 而不是等宿主重载插件之后才发现算错。只读 —— dry_run，不写任何文件。
 *
 *   node scripts/probe-real.mjs [库根] [节点 TID] [新文件名]
 */
import fs from 'node:fs'
import { parse_library } from '../lib/engine/mdlib.js'
import { render_node, toc_lines, node_info } from '../lib/engine/render.js'
import { diag } from '../lib/engine/diag.js'
import { renameFileNode, formatRename } from '../lib/engine/rename.js'

const LIB = process.argv[2] || 'D:/desktop/FilmMeasureProject/.dsh/skills/about-film-measure-project/.nodekb'
let TID = process.argv[3] || 'doc:03-工程经验与已知坑'
const NEW = process.argv[4] || (TID.split(':').pop() + '-v2')

const out = []
function log(...a) { out.push(a.join(' ')) }

if (!fs.existsSync(LIB)) {
  log(`库不存在: ${LIB}`)
  fs.writeFileSync('.probe-real.txt', out.join('\n') + '\n', 'utf8')
  process.exit(1)
}

const problems = []
const nodes = parse_library(LIB, problems)
const lib = { nodes, problems, nodekb: LIB }
log(`库: ${LIB}`)
log(`节点: ${nodes.size}  解析问题: ${problems.length}`)

const info = node_info(nodes, TID)
log(`\n[node_info] ${JSON.stringify(info)}`)

const toc = toc_lines(nodes, TID)
log(`\n[toc] ${toc.length} 行`)
log(toc.slice(0, 4).join('\n'))

const r0 = String(render_node(nodes, TID))
log(`\n[render_node] ${r0.length} 字符`)
log(r0.split('\n').slice(0, 6).join('\n'))

const d = diag(nodes, { problems, libRoot: LIB })
log(`\n[diag] exit=${d.code} errors=${d.report.errors.length} warnings=${d.report.warnings.length} nodes=${d.report.node_count}`)

try {
  const r = renameFileNode({ nodes, problems, nodekb: LIB }, TID, NEW, { dryRun: true })
  log('\n[改名计划 · dry_run]')
  log(formatRename(r))
} catch (e) {
  log(`\n[改名计划] 失败: ${e.message}`)
}

fs.writeFileSync('.probe-real.txt', out.join('\n') + '\n', 'utf8')
console.log('wrote .probe-real.txt')
