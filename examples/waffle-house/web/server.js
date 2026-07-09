// waffle-web — the public tier. Talks to waffle-api via API_URL (wired by the
// system); when the api lives on another node, the trunk makes this URL work
// anyway. No client-side calls to the api — it's private.
const http = require('http')

const PORT = process.env.PORT ?? 3000
const API_URL = process.env.API_URL ?? 'http://waffle-api:3001'

function page(orders, error) {
  const rows = orders
    .map((o) => `<li><b>#${o.id}</b> ${escapeHtml(o.topping)} <small>${o.created_at}</small></li>`)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>the waffle</title>
<style>
  body { font-family: ui-monospace, monospace; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
  h1 { letter-spacing: .05em; } li { margin: .4rem 0; } small { opacity: .5 }
  form { margin: 1.5rem 0; } input { font: inherit; padding: .4rem; width: 60%; }
  button { font: inherit; padding: .4rem 1rem; cursor: pointer; }
  .err { color: #c00; }
</style></head><body>
<h1>🧇 the waffle</h1>
<p>public web (this page) → private api → pg-cluster. One system, ${''
}possibly several machines.</p>
<form method="POST" action="/">
  <input name="topping" placeholder="order a topping — e.g. maple syrup" maxlength="100" required>
  <button>order</button>
</form>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<ul>${rows || '<li>no orders yet — be the first</li>'}</ul>
</body></html>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/') {
      const body = await readBody(req)
      const topping = decodeURIComponent(
        (new URLSearchParams(body).get('topping') ?? '').replace(/\+/g, ' '),
      )
      await fetch(`${API_URL}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topping }),
      })
      res.writeHead(303, { location: '/' })
      return res.end()
    }
    const r = await fetch(`${API_URL}/orders`)
    const orders = r.ok ? await r.json() : []
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(orders, r.ok ? null : `api said ${r.status}`))
  } catch (err) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page([], `can't reach the api: ${String(err.message ?? err)}`))
  }
})

server.listen(PORT, () => console.log(`waffle-web listening on :${PORT}`))
