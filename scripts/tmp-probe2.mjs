// temp probe: inspect live panel endpoints
const PORT = process.argv[2] || '62226'
const base = `http://127.0.0.1:${PORT}/nodekb/api`
const ws = process.argv[3] || 'F:/arcc1330'

const show = async (p) => {
  try {
    const r = await fetch(base + p)
    const t = await r.text()
    console.log(`\n### ${p} → ${r.status}\n${t.slice(0, 1200)}`)
  } catch (e) {
    console.log(`\n### ${p} → ERR ${e.message}`)
  }
}

await show('/version')
await show('/workspaces')
await show('/libs?ws=' + encodeURIComponent(ws))
await show('/libs')
