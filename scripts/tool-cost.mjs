// 统计每个工具在模型侧的成本：description + 参数 schema 的字符数（≈ token 数的 0.4）
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const mod = await import(pathToFileURL(path.join(root, 'lib/host/tools.js')).href)
const registered = []
const ctx = { tools: { register: (t) => { registered.push(t); return () => {} } } }
mod.buildTools(ctx, {})
const rows = registered.map((t) => {
  const schema = JSON.stringify(t.parameters)
  const desc = t.description || ''
  const chars = desc.length + schema.length
  return { name: t.name, desc: desc.length, schema: schema.length, chars, props: Object.keys(t.parameters.properties || {}).length }
})
rows.sort((a, b) => b.chars - a.chars)
let total = 0
for (const r of rows) {
  total += r.chars
  console.log(`${r.name.padEnd(16)} chars=${String(r.chars).padStart(5)} desc=${String(r.desc).padStart(4)} schema=${String(r.schema).padStart(4)} props=${r.props}`)
}
console.log(`total chars=${total}  ≈tokens=${Math.round(total / 2.6)}`)
