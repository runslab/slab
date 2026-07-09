// waffle-api — the middle tier. Owns the orders table, reachable only by
// system-mates (public = false). DATABASE_URL points at pgbouncer:6432.
const http = require('http')
const { Pool } = require('pg')

const PORT = process.env.PORT ?? 3000
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

let schemaReady
function ensureSchema() {
  schemaReady ??= pool.query(`
    CREATE TABLE IF NOT EXISTS waffle_orders (
      id serial primary key,
      topping text not null,
      created_at timestamptz default now()
    )
  `)
  return schemaReady
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  try {
    await ensureSchema()
    if (req.method === 'GET' && req.url === '/orders') {
      const { rows } = await pool.query(
        'SELECT id, topping, created_at FROM waffle_orders ORDER BY id DESC LIMIT 50',
      )
      return sendJson(res, 200, rows)
    }
    if (req.method === 'POST' && req.url === '/orders') {
      const { topping } = JSON.parse((await readBody(req)) || '{}')
      if (!topping || typeof topping !== 'string' || topping.length > 100) {
        return sendJson(res, 400, { error: 'topping (string, ≤100 chars) required' })
      }
      const { rows } = await pool.query(
        'INSERT INTO waffle_orders (topping) VALUES ($1) RETURNING id, topping, created_at',
        [topping],
      )
      return sendJson(res, 201, rows[0])
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: String(err.message ?? err) })
  }
})

server.listen(PORT, () => console.log(`waffle-api listening on :${PORT}`))
