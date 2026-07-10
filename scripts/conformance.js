#!/usr/bin/env node
// Conformance harness — the executable spec of the slab daemon surface.
// Boots an ephemeral daemon (own SLAB_DIR + ports), drives it through the
// app / system / job lifecycle over plain HTTP, and asserts on responses.
// The Go daemon is done when this passes with DAEMON_CMD pointed at it:
//
//   node scripts/conformance.js                          # spec the TS daemon
//   DAEMON_CMD="./go/bin/slabd" node scripts/conformance.js   # gate the port
//
// Apps get unique names per run: the docker engine is shared with whatever
// rack is live on this machine, and container names are slab-<app>.

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const PORT = Number(process.env.CONF_PORT ?? 17766)
const PROXY = Number(process.env.CONF_PROXY ?? 18080)
const DAEMON_CMD = process.env.DAEMON_CMD ?? 'node dist/daemon.js'
const API = `http://127.0.0.1:${PORT}`
const RUN = Math.random().toString(36).slice(2, 7)

// CONF_RUNG limits scope to a parity-ladder stage: 1 = app lifecycle only,
// 2 = +systems, 3 = +jobs (default: everything).
const RUNG = Number(process.env.CONF_RUNG ?? 99)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-conf-'))
let daemon = null
let failures = 0
let n = 0

function ok(cond, name, extra) {
  n++
  if (cond) console.log(`ok ${n} - ${name}`)
  else { failures++; console.log(`not ok ${n} - ${name}${extra ? ` :: ${extra}` : ''}`) }
}

async function api(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

async function waitFor(fn, what, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timeout waiting for ${what}`)
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf-8' }).trim()
}

function fixtureApp(name, extraToml = '') {
  const d = path.join(dir, 'fixtures', name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'slab.toml'),
`name = "${name}"
type = "service"
port = 80
image = "nginx:alpine"
${extraToml}
`)
  return d
}

async function main() {
  // ── boot an ephemeral daemon ────────────────────────────────────────────
  const [cmd, ...args] = DAEMON_CMD.split(' ')
  daemon = spawn(cmd, args, {
    env: { ...process.env, SLAB_DIR: dir, SLAB_PORT: String(PORT), SLAB_PROXY_PORT: String(PROXY) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const daemonLog = []
  daemon.stdout.on('data', (d) => daemonLog.push(d.toString()))
  daemon.stderr.on('data', (d) => daemonLog.push(d.toString()))
  await waitFor(async () => (await api('GET', '/v1/apps')).status === 200, 'daemon boot', 20000)
  ok(true, 'daemon boots and serves /v1/apps')

  // ── app lifecycle: create → deploy → route → logs → stop/start ─────────
  const web = `conf-web-${RUN}`
  const srcWeb = fixtureApp(web, 'volumes = ["data:/data"]\n\n[env]\nGREETING = "conformance"')

  let r = await api('POST', '/v1/apps', { sourceDir: srcWeb })
  ok(r.status === 201 && r.json?.app?.name === web, 'POST /v1/apps creates from sourceDir', r.text)
  ok(r.json?.app?.manifest?.volumes?.[0] === 'data:/data', 'manifest volumes parsed')

  r = await api('POST', `/v1/apps/${web}/deploy`)
  ok(r.status === 200 && r.json?.app?.state === 'running', 'deploy → running', r.text)
  const hostPort = r.json?.app?.hostPort
  ok(Number.isInteger(hostPort) && hostPort >= 20000, 'hostPort allocated for public app')

  r = await api('GET', '/v1/apps')
  ok(Array.isArray(r.json?.apps ?? r.json) || r.status === 200, 'GET /v1/apps lists')

  // fetch() forbids overriding Host — use a raw request for the ingress check.
  // Deploy returns when the container runs, not when the app listens, so the
  // probe retries briefly (same contract on both daemons).
  const probeProxy = () => new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY, path: '/', headers: { Host: `${web}.localhost` } },
      (res) => { res.resume(); resolve(res.statusCode) },
    )
    req.on('error', reject)
    req.end()
  })
  let proxiedStatus = 0
  await waitFor(async () => (proxiedStatus = await probeProxy()) === 200, 'ingress 200', 8000).catch(() => {})
  ok(proxiedStatus === 200, 'ingress routes Host header → app', `status ${proxiedStatus}`)

  const env = docker('exec', `slab-${web}`, 'env')
  ok(env.includes('PORT=80'), 'PORT injected from manifest.port')
  ok(env.includes('GREETING=conformance'), 'manifest env injected')

  // volumes: data survives a redeploy
  docker('exec', `slab-${web}`, 'sh', '-c', 'echo survived > /data/probe')
  r = await api('POST', `/v1/apps/${web}/deploy`)
  ok(r.status === 200, 'second deploy succeeds')
  const probe = docker('exec', `slab-${web}`, 'cat', '/data/probe')
  ok(probe === 'survived', 'named volume survives redeploy')
  ok(docker('volume', 'ls', '--format', '{{.Name}}').includes(`slab-${web}-data`), 'volume namespaced slab-<app>-<name>')

  r = await api('GET', `/v1/apps/${web}/logs?tail=10`)
  ok(r.status === 200, 'logs endpoint answers')

  r = await api('POST', `/v1/apps/${web}/stop`)
  ok(r.status === 200 && (r.json?.app?.state === 'stopped'), 'stop → stopped', r.text)
  r = await api('POST', `/v1/apps/${web}/start`)
  ok(r.status === 200 && (r.json?.app?.state === 'running'), 'start → running', r.text)

  if (RUNG < 2) {
    r = await api('DELETE', `/v1/apps/${web}`)
    ok(r.status === 204, 'DELETE app')
    try { docker('volume', 'rm', `slab-${web}-data`) } catch {}
    console.log(`\n${n - failures}/${n} passed (rung 1 scope)`)
    process.exitCode = failures ? 1 : 0
    return
  }

  // ── system: wires, private members, shared network ──────────────────────
  const sysName = `conf-sys-${RUN}`
  const apiApp = `conf-api-${RUN}`
  fixtureApp(apiApp, 'public = false')
  const sysDir = path.join(dir, 'fixtures')
  const sysFile = path.join(sysDir, 'system.toml')
  fs.writeFileSync(sysFile,
`name = "${sysName}"

[apps.${web}]
source = "./${web}"

[apps.${apiApp}]
source = "./${apiApp}"

[wires]
"${web}.API_URL" = "http://${apiApp}:80"
`)
  r = await api('POST', '/v1/systems', { sourceFile: sysFile })
  ok(r.status === 200 || r.status === 201, 'POST /v1/systems registers the system', r.text)
  r = await api('POST', `/v1/systems/${sysName}/deploy`)
  ok(r.status === 200, 'POST /v1/systems/:name/deploy deploys members', r.text)

  r = await api('GET', `/v1/apps/${apiApp}`)
  ok(r.json?.app?.manifest?.public === false, 'private member manifest parsed', r.text)
  const published = docker('port', `slab-${apiApp}`)
  ok(published === '', 'private member has NO published docker port', published)

  const envWeb = docker('exec', `slab-${web}`, 'env')
  ok(envWeb.includes(`API_URL=http://${apiApp}:80`), 'wire injected as env on the caller')

  let cross = ''
  try { cross = docker('exec', `slab-${web}`, 'sh', '-c', `wget -qO- -T 5 http://${apiApp}:80 >/dev/null && echo reached`) } catch (e) { cross = String(e.message) }
  ok(cross === 'reached', 'members resolve each other by app name on the system network', cross)

  r = await api('GET', '/v1/systems')
  ok(r.status === 200 && JSON.stringify(r.json).includes(sysName), 'GET /v1/systems lists the system')

  // ── jobs: run-to-completion, exit codes, logs ───────────────────────────
  r = await api('POST', '/v1/jobs', { image: 'alpine:3', command: ['sh', '-c', 'echo conf-ok'] })
  ok(r.status === 200 || r.status === 201, 'POST /v1/jobs accepts an image job', r.text)
  const jobId = r.json?.job?.id ?? r.json?.id
  await waitFor(async () => {
    const j = await api('GET', `/v1/jobs/${jobId}`)
    return (j.json?.job?.state ?? j.json?.state) === 'succeeded'
  }, 'job success', 60000)
  ok(true, 'job runs to succeeded')
  r = await api('GET', `/v1/jobs/${jobId}/logs`)
  ok(r.text.includes('conf-ok'), 'job logs kept')

  r = await api('POST', '/v1/jobs', { image: 'alpine:3', command: ['sh', '-c', 'exit 3'] })
  const failId = r.json?.job?.id ?? r.json?.id
  await waitFor(async () => {
    const j = await api('GET', `/v1/jobs/${failId}`)
    return (j.json?.job?.state ?? j.json?.state) === 'failed'
  }, 'job failure', 60000)
  const failed = await api('GET', `/v1/jobs/${failId}`)
  ok((failed.json?.job?.exitCode ?? failed.json?.exitCode) === 3, 'exit code propagates', failed.text)

  // ── teardown surface: system rm keeps apps, app rm removes ─────────────
  r = await api('DELETE', `/v1/systems/${sysName}`)
  ok(r.status === 200 || r.status === 204, 'DELETE system detaches')
  for (const a of [web, apiApp]) {
    r = await api('DELETE', `/v1/apps/${a}`)
    ok(r.status === 204, `DELETE app ${a === web ? '(public)' : '(private)'}`)
  }
  ok(docker('volume', 'ls', '--format', '{{.Name}}').includes(`slab-${web}-data`), 'volume KEPT after rm (data-safe default)')
  docker('volume', 'rm', `slab-${web}-data`)

  console.log(`\n${n - failures}/${n} passed`)
  if (failures) { console.log('--- daemon log tail ---'); console.log(daemonLog.join('').split('\n').slice(-15).join('\n')) }
  process.exitCode = failures ? 1 : 0
}

main()
  .catch((err) => { console.error(`fatal: ${err.message}`); process.exitCode = 1 })
  .finally(() => {
    if (daemon) daemon.kill()
    // belt & suspenders: remove any containers this run leaked
    try {
      const leftovers = docker('ps', '-aq', '--filter', `name=conf-.*-${RUN}`)
      if (leftovers) execFileSync('docker', ['rm', '-f', ...leftovers.split('\n')])
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
