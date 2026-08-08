const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
await new Promise((r) => (ws.onopen = r))
await send('Runtime.enable', {})
const ev = async (expr, timeout = 60000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout })
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description||'').slice(0,200)
  return r.result?.result?.value }
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1, buttons:1 })
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1, buttons:0 }) }

console.log('modal open?', await ev(`!!document.querySelector('.modal-backdrop, .mx-back')`))
console.log('ALL buttons:', JSON.stringify(await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean)`)))
// find the modal's primary Export button (inside the modal, not the topbar)
const pos = await ev(`(() => {
  const m = document.querySelector('.modal-backdrop, .mx-back'); if(!m) return null
  const b = [...m.querySelectorAll('button')].filter(x=>/export/i.test(x.textContent||''))
  const t = b[b.length-1]; if(!t) return null
  const r = t.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), label:t.textContent.trim()}
})()`)
console.log('modal export button:', JSON.stringify(pos))
if (pos) {
  await ev(`window.__jobLog.length = 0`)
  await click(pos.x, pos.y)
  console.log('clicked — watching job log for 75s...')
  for (let i = 0; i < 15; i++) {
    await sleep(5000)
    const s = await ev(`(() => { const l=window.__jobLog; const last=l[l.length-1]; return {n:l.length, last} })()`)
    console.log(`  t+${(i+1)*5}s`, JSON.stringify(s))
    if (s && s.last && s.last.active === false && /Exported|failed|cancel/i.test(s.last.msg||'')) break
  }
  const full = await ev(`window.__jobLog.map(e=>e.percent+(e.active?'':'*')).join(' ')`)
  console.log('PERCENT SEQUENCE (* = active:false):')
  console.log(full)
  console.log('final:', JSON.stringify(await ev(`window.__jobLog[window.__jobLog.length-1]`)))
}
ws.close(); process.exit(0)
