// Private scoreboard — only the game (same system) can reach it.
const http = require('http')
let top = []
http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.url === '/health') return send(200, { status: 'ok' })
  if (req.method === 'POST' && req.url === '/score') {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      try {
        const s = JSON.parse(raw)
        top.push({ player: String(s.player ?? 'anon').slice(0, 12), score: Number(s.score) || 0, at: new Date().toISOString() })
        top.sort((a, b) => b.score - a.score)
        top = top.slice(0, 10)
        send(201, { rank: top.findIndex(t => t.at === top[top.length - 1]?.at) + 1 })
      } catch { send(400, { error: 'bad score' }) }
    })
    return
  }
  send(200, { top })
}).listen(process.env.PORT || 3000)
