// Sovereign patient lake — Kanto (Tokyo). In-memory FHIR-ish store.
const http = require('http')
const patients = []
const REGION = process.env.REGION || 'Kanto (Tokyo)'
http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.url === '/health') return send(200, { status: 'ok' })
  if (req.method === 'POST' && req.url === '/Patient') {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      try {
        const p = JSON.parse(raw || '{}')
        patients.push({ id: patients.length + 1, name: p.name ?? 'unknown', admitted: new Date().toISOString() })
        if (patients.length > 500) patients.shift()
        send(201, { id: patients.length })
      } catch { send(400, { error: 'bad patient' }) }
    })
    return
  }
  if (req.url === '/Patient') return send(200, { patients: patients.slice(-10).reverse() })
  send(200, { lake: 'tokyo', region: REGION, sovereign: true, patients: patients.length })
}).listen(process.env.PORT || 3000)
