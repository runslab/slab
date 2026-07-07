// slab — daemon entrypoint. Runs the HTTP API (DAEMON_PORT) and the ingress
// proxy (PROXY_PORT) in a single process.
import path from 'path'
import express, { Request, Response, NextFunction } from 'express'
import { AppRecord, Engine, Manifest, DAEMON_PORT, PROXY_PORT } from './types'
import { loadState, saveState, allocateHostPort, getSecrets, setSecrets, deleteSecrets } from './state'
import { loadManifest, parseDuration } from './manifest'
import { createProxy } from './proxy'
import { createEngine } from './engine'
import { dashboardHtml } from './dashboard'
import { openTunnel, closeTunnel } from './tunnel'
import { cloneOrPull, normalizeGitUrl, repoDirName } from './git'

const IDLE_REAP_INTERVAL_MS = 30_000
const LAST_REQUEST_SAVE_THROTTLE_MS = 5_000

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>

function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
}

// req.params values are typed string | string[] by the generic ParamsDictionary
// (repeated-param routes); every route here uses a single :name segment.
function nameParam(req: Request): string {
  const v = req.params.name
  return Array.isArray(v) ? v[0] : v
}

async function main(): Promise<void> {
  const state = loadState()
  const engine: Engine = createEngine()

  await reconcile(state, engine)
  saveState(state)

  function getAppOr404(name: string): AppRecord {
    const app = state.apps[name]
    if (!app) throw new HttpError(404, `unknown app "${name}"`)
    return app
  }

  const api = express()
  api.use(express.json())

  // Rolling 60s of request timestamps per app — powers the req/min column
  const reqTimes = new Map<string, number[]>()
  function reqPerMin(name: string): number {
    const now = Date.now()
    return (reqTimes.get(name) ?? []).filter((t) => now - t < 60_000).length
  }

  api.get('/v1/apps', wrap(async (_req, res) => {
    res.json({ apps: Object.values(state.apps).map((a) => ({ ...a, reqPerMin: reqPerMin(a.name) })) })
  }))

  api.post('/v1/apps', wrap(async (req, res) => {
    let sourceDir = req.body?.sourceDir
    let gitUrl: string | null = null
    if (typeof req.body?.gitUrl === 'string' && req.body.gitUrl) {
      gitUrl = normalizeGitUrl(req.body.gitUrl)
      try {
        sourceDir = await cloneOrPull(gitUrl, repoDirName(gitUrl))
      } catch (err) {
        throw new HttpError(400, (err as Error).message)
      }
    } else if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) {
      throw new HttpError(400, 'body must be { sourceDir: <absolute path> } or { gitUrl }')
    }
    let manifest: Manifest
    try {
      manifest = loadManifest(sourceDir)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    if (state.apps[manifest.name]) {
      throw new HttpError(409, `app "${manifest.name}" already exists`)
    }
    const hostPort = allocateHostPort(state)
    const record: AppRecord = {
      name: manifest.name,
      sourceDir,
      gitUrl,
      manifest,
      hostPort,
      containerId: null,
      imageTag: null,
      version: 0,
      state: 'created',
      lastRequestAt: null,
      createdAt: new Date().toISOString(),
      deployedAt: null,
      error: null,
      exposed: false,
      publicUrl: null,
    }
    state.apps[manifest.name] = record
    saveState(state)
    res.status(201).json({ app: record })
  }))

  api.get('/v1/apps/:name', wrap(async (req, res) => {
    res.json({ app: getAppOr404(nameParam(req)) })
  }))

  api.delete('/v1/apps/:name', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    closeTunnel(record.name)
    await engine.removeContainer(record)
    deleteSecrets(record.name)
    delete state.apps[record.name]
    saveState(state)
    res.status(204).end()
  }))

  api.post('/v1/apps/:name/expose', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    record.publicUrl = await openTunnel(record)
    record.exposed = true
    saveState(state)
    res.json({ app: record })
  }))

  api.post('/v1/apps/:name/hide', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    closeTunnel(record.name)
    record.exposed = false
    record.publicUrl = null
    saveState(state)
    res.json({ app: record })
  }))

  api.post('/v1/apps/:name/deploy', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    record.state = 'building'
    record.error = null
    saveState(state)
    try {
      if (record.gitUrl) {
        await cloneOrPull(record.gitUrl, path.basename(record.sourceDir))
        // manifest may have changed upstream — re-read it
        record.manifest = loadManifest(record.sourceDir)
      }
      const imageTag = await engine.buildImage(record)
      const secrets = getSecrets(record.name)
      const env: Record<string, string> = { ...record.manifest.env, ...secrets }
      if (record.manifest.postgres) {
        env.DATABASE_URL = await engine.ensurePostgres(record.name)
      }
      const containerId = await engine.runContainer(record, imageTag, env)
      record.containerId = containerId
      record.imageTag = imageTag
      record.version += 1
      record.state = 'running'
      record.deployedAt = new Date().toISOString()
      record.error = null
      saveState(state)
      res.json({ app: record })
    } catch (err) {
      record.state = 'error'
      record.error = (err as Error).message
      saveState(state)
      res.status(500).json({ error: record.error })
    }
  }))

  api.post('/v1/apps/:name/stop', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    await engine.stopContainer(record)
    record.state = 'stopped'
    saveState(state)
    res.json({ app: record })
  }))

  api.post('/v1/apps/:name/start', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    await engine.startContainer(record)
    record.state = 'running'
    saveState(state)
    res.json({ app: record })
  }))

  api.get('/v1/apps/:name/logs', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    const tail = parseTail(req.query.tail)
    const logs = await engine.getLogs(record, tail)
    res.json({ logs })
  }))

  api.put('/v1/apps/:name/secrets', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    const values = req.body?.values
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      throw new HttpError(400, 'body must be { values: Record<string, string> }')
    }
    setSecrets(record.name, values as Record<string, string>)
    res.status(204).end()
  }))

  api.get('/v1/apps/:name/secrets', wrap(async (req, res) => {
    const record = getAppOr404(nameParam(req))
    res.json({ keys: Object.keys(getSecrets(record.name)) })
  }))

  api.get('/v1/health', wrap(async (_req, res) => {
    res.json({ status: 'ok', apps: Object.keys(state.apps).length, proxyPort: PROXY_PORT })
  }))

  api.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(dashboardHtml(PROXY_PORT))
  })

  api.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  api.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500
    res.status(status).json({ error: err.message || 'internal error' })
  })

  const lastRequestSaveAt = new Map<string, number>()
  function onRequest(name: string): void {
    const app = state.apps[name]
    if (!app) return
    app.lastRequestAt = new Date().toISOString()
    const now = Date.now()
    const times = reqTimes.get(name) ?? []
    times.push(now)
    reqTimes.set(name, times.filter((t) => now - t < 60_000))
    const last = lastRequestSaveAt.get(name) ?? 0
    if (now - last >= LAST_REQUEST_SAVE_THROTTLE_MS) {
      lastRequestSaveAt.set(name, now)
      saveState(state)
    }
  }

  const proxyServer = createProxy({ state, engine, onRequest })

  startIdleReaper(state, engine)

  api.listen(DAEMON_PORT, '127.0.0.1', () => {
    proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
      const appCount = Object.keys(state.apps).length
      console.log(`slab daemon up — api:${DAEMON_PORT} proxy:${PROXY_PORT} apps:${appCount}`)
    })
  })
}

function parseTail(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 100
  return Math.min(1000, Math.floor(n))
}

// On startup, ask the engine what's actually running and correct any stale
// state left over from a previous daemon run (e.g. after a crash/reboot).
async function reconcile(state: ReturnType<typeof loadState>, engine: Engine): Promise<void> {
  for (const app of Object.values(state.apps)) {
    if (!app.containerId) continue
    try {
      const running = await engine.isRunning(app)
      app.state = running ? 'running' : app.manifest.type === 'function' ? 'sleeping' : 'stopped'
    } catch (err) {
      console.error(`reconcile: failed to check ${app.name}: ${(err as Error).message}`)
    }
    // Re-open tunnels for exposed apps (quick-tunnel URLs change per session)
    if (app.exposed) {
      try {
        app.publicUrl = await openTunnel(app)
        console.log(`tunnel: ${app.name} -> ${app.publicUrl}`)
      } catch (err) {
        app.publicUrl = null
        console.error(`tunnel: failed to expose ${app.name}: ${(err as Error).message}`)
      }
    }
  }
}

function startIdleReaper(state: ReturnType<typeof loadState>, engine: Engine): void {
  setInterval(() => {
    for (const app of Object.values(state.apps)) {
      if (app.manifest.type !== 'function') continue
      if (app.state !== 'running') continue
      if (!app.lastRequestAt) continue
      const idleMs = Date.now() - new Date(app.lastRequestAt).getTime()
      const timeoutMs = parseDuration(app.manifest.idle_timeout ?? '5m')
      if (idleMs < timeoutMs) continue
      engine.stopContainer(app)
        .then(() => {
          app.state = 'sleeping'
          saveState(state)
        })
        .catch((err) => {
          console.error(`idle reaper: failed to stop ${app.name}: ${(err as Error).message}`)
        })
    }
  }, IDLE_REAP_INTERVAL_MS)
}

main().catch((err) => {
  console.error('slab daemon failed to start:', err)
  process.exit(1)
})
