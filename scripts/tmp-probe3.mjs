// temp probe 2: is ws honored?
const PORT = process.argv[2] || '62226'
const base = `http://127.0.0.1:${PORT}/nodekb/api`
const show = async (p) => {
  try {
    const r = await fetch(base + p)
    const t = await r.text()
    console.log(`\n### ${p} → ${r.status}\n${t.slice(0, 700)}`)
  } catch (e) {
    console.log(`\n### ${p} → ERR ${e.message}`)
  }
}
await show('/libs?ws=' + encodeURIComponent('F:/ComfyUI'))
await show('/libs?ws=' + encodeURIComponent('F:/arcc1330') + '&scope=ws')
await show('/tree?ws=' + encodeURIComponent('F:/arcc1330') + '&kb=about-ros2')
