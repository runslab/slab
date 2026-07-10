// slab — ingress proxy. Routes by Host header (<app>.localhost[:port] or
// <app>.slab) to the app's hostPort. Wakes sleeping functions on request.
import http from 'http'
import net from 'net'
import httpProxy from 'http-proxy'
import { SlabState, Engine, AppRecord } from './types'
import { clientFor } from './api-client'

const WAKE_TIMEOUT_MS = 15_000
// cluster ingress route cache: appName -> {host, proxyPort} | null (5s TTL)
const clusterRoutes = new Map<string, { at: number; route: { node: string; host: string; proxyPort: number } | null }>()
function hostOfUrl(u: string): string { try { return new URL(u).hostname } catch { return u } }
const WAKE_POLL_INTERVAL_MS = 200

export interface ProxyDeps {
  state: SlabState
  engine: Engine
  onRequest: (appName: string) => void
}

function extractAppName(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  const host = hostHeader.split(':')[0]
  const m = /^([a-z0-9-]+)\.(?:localhost|slab)$/.exec(host)
  return m ? m[1] : null
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

// Polls until the app answers HTTP on 127.0.0.1:port. A bare TCP connect is not
// enough: Docker's port publisher accepts connections as soon as the container
// starts, before the app inside is listening. Any HTTP status (even 5xx) counts
// as awake; connection errors mean keep waiting.
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path: '/', timeout: 2000 },
        (res) => {
          res.resume()
          resolve()
        }
      )
      const retry = () => {
        req.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for port ${port}`))
          return
        }
        setTimeout(attempt, WAKE_POLL_INTERVAL_MS)
      }
      req.on('error', retry)
      req.on('timeout', retry)
      req.end()
    }
    attempt()
  })
}

export function createProxy(deps: ProxyDeps): http.Server {
  const { state, engine, onRequest } = deps
  const proxy = httpProxy.createProxyServer({ ws: false })

  proxy.on('error', (err, _req, res) => {
    if (res instanceof http.ServerResponse && !res.headersSent) {
      sendJson(res, 502, { error: `proxy error: ${err.message}` })
    }
  })

  async function resolvePeerApp(name: string): Promise<{ node: string; host: string; proxyPort: number } | null> {
    const cached = clusterRoutes.get(name)
    if (cached && Date.now() - cached.at < 5000) return cached.route
    let route: { node: string; host: string; proxyPort: number } | null = null
    for (const peer of Object.values(state.peers ?? {})) {
      try {
        const c = clientFor(peer.url, peer.token, 3000)
        const { apps } = await c.listApps()
        if (!apps.some((a) => a.name === name && a.hostPort != null)) continue
        const h = await c.health()
        route = { node: h.node ?? peer.name, host: hostOfUrl(peer.url), proxyPort: h.proxyPort }
        break
      } catch { /* peer unreachable — try the next */ }
    }
    clusterRoutes.set(name, { at: Date.now(), route })
    return route
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const name = extractAppName(req.headers.host)
    if (!name) {
      sendJson(res, 404, { error: 'unknown app' })
      return
    }
    const app: AppRecord | undefined = state.apps[name]
    if (!app) {
      // cluster ingress: a peer may run it — reverse-proxy to that node's
      // ingress (one rack, any node). The Host header travels as-is.
      const route = await resolvePeerApp(name)
      if (route) {
        onRequest(name)
        proxy.web(req, res, { target: `http://${route.host}:${route.proxyPort}` }, (err) => {
          if (!res.headersSent) sendJson(res, 502, { error: `cluster ingress to ${route.node} failed: ${err.message}` })
        })
        return
      }
      sendJson(res, 404, { error: 'unknown app' })
      return
    }
    if (app.manifest.public === false) {
      sendJson(res, 403, { error: 'app is private — reachable only inside its systems' })
      return
    }

    // provider apps: the ingress dials the substrate's endpoint directly —
    // app.localhost:8080 fronts a Fargate task the same way it fronts a container
    const providerApp = !!app.target && app.target !== 'docker'
    if (providerApp) {
      if (!app.endpoint) {
        sendJson(res, 503, { error: `app runs on ${app.target} but has no endpoint yet — redeploy or wait for the task to start` })
        return
      }
      onRequest(name)
      // endpoints may be full https urls (app runner / lambda function urls) —
      // changeOrigin so the Host header matches the substrate's domain
      const target = app.endpoint.startsWith('http') ? app.endpoint : `http://${app.endpoint}`
      proxy.web(req, res, { target, changeOrigin: true, secure: true }, (err) => {
        if (!res.headersSent) sendJson(res, 502, { error: `proxy error (${app.target}): ${err.message}` })
      })
      return
    }

    if (app.hostPort == null) {
      sendJson(res, 503, { error: 'app has never been deployed' })
      return
    }

    onRequest(name)

    try {
      if (app.manifest.type === 'function') {
        const running = await engine.isRunning(app)
        if (!running) {
          await engine.startContainer(app)
          await waitForPort(app.hostPort, WAKE_TIMEOUT_MS)
        }
      }
    } catch (err) {
      sendJson(res, 502, { error: `failed to wake app: ${(err as Error).message}` })
      return
    }

    proxy.web(req, res, { target: `http://127.0.0.1:${app.hostPort}` }, (err) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `proxy error: ${err.message}` })
      }
    })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `proxy error: ${(err as Error).message}` })
      }
    })
  })

  // Best-effort WS support: only forward if the app is already reachable —
  // skip the wake-on-request dance for upgrades to keep this trivial.
  server.on('upgrade', (req, socket, head) => {
    const name = extractAppName(req.headers.host)
    const app = name ? state.apps[name] : null
    if (!app || app.hostPort == null) {
      socket.destroy()
      return
    }
    onRequest(app.name)
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${app.hostPort}` })
  })

  return server
}
