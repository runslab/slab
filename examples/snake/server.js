// slab arcade: snake. Serves the game; relays scores to the PRIVATE
// scoreboard through the system wire (SCORE_URL) — the browser never
// touches the scoreboard directly.
const http = require('http')
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>slab snake</title>
<style>
  body { background:#131418; color:#ece9e2; font:13px ui-monospace,Menlo,monospace; display:flex; flex-direction:column; align-items:center; padding-top:30px; }
  h1 { font-size:12px; letter-spacing:.3em; color:#ffb454; margin-bottom:14px; }
  canvas { background:#0b0c09; border:1px solid #33363e; border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,.5); }
  #hud { margin:12px; color:#9a9da5; }
  table { margin-top:8px; border-collapse:collapse; font-size:12px; }
  td { padding:2px 14px; color:#9a9da5; } td:first-child { color:#ffb454; }
</style></head><body>
<h1>SLAB ARCADE - SNAKE</h1>
<canvas id="c" width="352" height="352"></canvas>
<div id="hud">arrows to move - score 0</div>
<table id="top"></table>
<script>
const cv = document.getElementById('c'), cx = cv.getContext('2d'), G = 22, N = 16
let snake, dir, food, score, dead, timer
function reset() {
  snake = [{x:8,y:8}]; dir = {x:1,y:0}; score = 0; dead = false
  food = spawn(); clearInterval(timer); timer = setInterval(tick, 110)
}
function spawn() { return { x: Math.floor(Math.random()*N), y: Math.floor(Math.random()*N) } }
document.addEventListener('keydown', e => {
  const d = { ArrowUp:{x:0,y:-1}, ArrowDown:{x:0,y:1}, ArrowLeft:{x:-1,y:0}, ArrowRight:{x:1,y:0} }[e.key]
  if (d) { e.preventDefault(); if (!(d.x === -dir.x && d.y === -dir.y)) dir = d }
  if (dead && e.key === ' ') reset()
})
async function gameOver() {
  dead = true; clearInterval(timer)
  document.getElementById('hud').textContent = 'dead - score ' + score + ' - space to restart'
  await fetch('/score', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ player:'anon', score }) }).catch(()=>{})
  loadTop()
}
async function loadTop() {
  const r = await fetch('/top'); const d = await r.json()
  document.getElementById('top').innerHTML = (d.top ?? []).map((t,i) => '<tr><td>#'+(i+1)+'</td><td>'+t.player+'</td><td>'+t.score+'</td></tr>').join('')
}
function tick() {
  const h = { x: snake[0].x + dir.x, y: snake[0].y + dir.y }
  if (h.x < 0 || h.y < 0 || h.x >= N || h.y >= N || snake.some(s => s.x === h.x && s.y === h.y)) return gameOver()
  snake.unshift(h)
  if (h.x === food.x && h.y === food.y) { score += 10; food = spawn() } else snake.pop()
  document.getElementById('hud').textContent = 'arrows to move - score ' + score
  cx.fillStyle = '#0b0c09'; cx.fillRect(0, 0, 352, 352)
  cx.fillStyle = '#f07f78'; cx.fillRect(food.x*G+3, food.y*G+3, G-6, G-6)
  snake.forEach((s, i) => {
    cx.fillStyle = i ? '#71d68d' : '#ffb454'
    cx.fillRect(s.x*G+2, s.y*G+2, G-4, G-4)
  })
}
reset(); loadTop()
</script></body></html>`
http.createServer(async (req, res) => {
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type ?? 'application/json' }); res.end(body) }
  if (req.url === '/health') return send(200, '{"status":"ok"}')
  if (req.method === 'POST' && req.url === '/score') {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', async () => {
      try {
        if (process.env.SCORE_URL) await fetch(process.env.SCORE_URL + '/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })
        send(201, '{"ok":true}')
      } catch { send(502, '{"error":"scoreboard unreachable"}') }
    })
    return
  }
  if (req.url === '/top') {
    try {
      const r = await fetch((process.env.SCORE_URL ?? '') + '/top')
      return send(200, await r.text())
    } catch { return send(200, '{"top":[]}') }
  }
  send(200, PAGE, 'text/html; charset=utf-8')
}).listen(process.env.PORT || 3000)
