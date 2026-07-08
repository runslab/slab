// Admission feeder for lake-tokyo — a PRIVATE background worker.
// Reaches its lake ONLY through the system wire (LAKE_URL).
const http = require('http')
const NAMES = 'Haruto,Yui,Sota,Sakura,Ren,Aoi'.split(',')
let sent = 0
setInterval(async () => {
  const url = process.env.LAKE_URL
  if (!url) return
  try {
    await fetch(url + '/Patient', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAMES[Math.floor(Math.random() * NAMES.length)] + ' ' + Math.floor(Math.random() * 900 + 100) }),
    })
    sent += 1
  } catch { /* lake asleep — try again next tick */ }
}, 9000)
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(req.url === '/health' ? { status: 'ok' } : { feeder: 'feeder-tokyo', sent }))
}).listen(process.env.PORT || 3000)
