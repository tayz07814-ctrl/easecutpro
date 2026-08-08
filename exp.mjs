import { writeFileSync } from 'fs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0; const pending = new Map(); const logs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') { const a=(m.params.args||[]).map(x=>x.value??x.description??'').join(' '); logs.push('['+m.params.type+'] '+a.slice(0,200)) } }
const send = (method, params) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
await new Promise((r) => (ws.onopen = r))
await send('Runtime.enable', {}); await send('Page.enable', {})
const ev = async (expr, timeout = 40000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout })
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description||'').slice(0,200)
  return r.result?.result?.value }
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1, buttons:1 })
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1, buttons:0 }) }
const clickText = async (t) => {
  const pos = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(t)}); if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  if (!pos) return false
  await click(pos.x, pos.y); return true }

if (!(await ev(`document.querySelectorAll('canvas').length`))) {
  const pos = await ev(`(() => { const i=[...document.querySelectorAll('img')].find(x=>x.getBoundingClientRect().width>200); const r=i.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  await click(pos.x, pos.y); await sleep(4000)
}
console.log('opened editor, canvases:', await ev(`document.querySelectorAll('canvas').length`))
await ev(`window.__jobLog.length = 0`)
console.log('clicked Export:', await clickText('Export'))
await sleep(1500)
console.log('modal buttons:', JSON.stringify(await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,24)`)))
