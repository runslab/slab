// slab — daemon entrypoint. Runs the HTTP API (DAEMON_PORT) and the ingress
// proxy (PROXY_PORT) in a single process.
import fs from 'fs'
import os from 'os'
import path from 'path'
import express, { Request, Response, NextFunction } from 'express'
import { AppRecord, Engine, JobRecord, Manifest, SystemManifest, SystemRecord, TrunkConfig, DAEMON_PORT, PROXY_PORT } from './types'
import { loadState, saveState, allocateHostPort, getSecrets, setSecrets, deleteSecrets, slabDir, effectiveNodeConfig } from './state'
import { loadManifest, loadSystemManifest, parseDuration } from './manifest'
import { createProxy } from './proxy'
import { createEngine } from './engine'
import { dashboardHtml, apiHumanHtml, faviconSvg } from './dashboard'
import { openTunnel, closeTunnel } from './tunnel'
import { cloneOrPull, normalizeGitUrl, repoDirName, looksLikeGitUrl } from './git'
import { clientFor } from './api-client'
import { trunkScript, TRUNK_INGRESS_PORT } from './trunk'

const IDLE_REAP_INTERVAL_MS = 30_000
const LAST_REQUEST_SAVE_THROTTLE_MS = 5_000
const JOB_HISTORY_MAX = 50            // finished jobs kept (older ones + their containers are pruned)
const JOB_DEFAULT_TIMEOUT = '30m'

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

function idParam(req: Request): string {
  const v = req.params.id
  return Array.isArray(v) ? v[0] : v
}

function idParamLike(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v
}

// Shared slug rules for job names and the node name (same shape as app names)
const JOB_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/
function sanitizeJobName(raw: string): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(name)) name = `job-${name}`
  name = name.slice(0, 31)
  while (name.length < 2) name += '0'
  return JOB_NAME_RE.test(name) ? name : 'job'
}

// A wire value "mentions" a member when the member name appears as a
// standalone token — covers "http://<member>:port/.." and any other
// hostname-shaped reference, without matching substrings of longer names.
function mentionsMember(value: string, member: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9-])${member}($|[^a-z0-9-])`, 'i')
  return re.test(value)
}

// Topologically order a system's members so that any member referenced as a
// hostname in another member's wire value is deployed first. Falls back to
// manifest order (with a warning) if the wire graph has a cycle.
function topoSortMembers(system: SystemRecord): string[] {
  const members = system.members
  const memberSet = new Set(members)
  const dependsOn = new Map<string, Set<string>>()
  for (const m of members) dependsOn.set(m, new Set())

  for (const [wireKey, value] of Object.entries(system.wires)) {
    const dot = wireKey.indexOf('.')
    if (dot < 0) continue
    const targetApp = wireKey.slice(0, dot)
    if (!memberSet.has(targetApp)) continue
    for (const candidate of members) {
      if (candidate === targetApp) continue
      if (mentionsMember(value, candidate)) {
        dependsOn.get(targetApp)!.add(candidate)
      }
    }
  }

  const adj = new Map<string, string[]>() // dependency -> [dependents]
  for (const m of members) adj.set(m, [])
  const indeg = new Map<string, number>()
  for (const m of members) indeg.set(m, dependsOn.get(m)!.size)
  for (const m of members) {
    for (const dep of dependsOn.get(m)!) adj.get(dep)!.push(m)
  }

  const queue = members.filter((m) => indeg.get(m) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const n = queue.shift()!
    order.push(n)
    for (const dependent of adj.get(n)!) {
      indeg.set(dependent, indeg.get(dependent)! - 1)
      if (indeg.get(dependent) === 0) queue.push(dependent)
    }
  }

  if (order.length !== members.length) {
    console.warn(`system "${system.name}": wire dependency graph has a cycle — falling back to manifest order`)
    return members
  }
  return order
}

async function main(): Promise<void> {
  const nodeCfg = effectiveNodeConfig()
  const state = loadState()
  state.systems ??= {}
  state.jobs ??= {}
  state.peers ??= {}
  state.nodeName ??= sanitizeJobName(os.hostname().replace(/\.(local|lan|home)$/i, ''))
  const systems = state.systems // non-optional local alias, safe to use inside closures/handlers
  const jobs = state.jobs
  const peers = state.peers
  const engine: Engine = createEngine()

  await reconcile(state, engine)
  await reconcileSystems(state, engine)
  saveState(state)

  function getAppOr404(name: string): AppRecord {
    const app = state.apps[name]
    if (!app) throw new HttpError(404, `unknown app "${name}"`)
    return app
  }

  function getSystemOr404(name: string): SystemRecord {
    const system = systems[name]
    if (!system) throw new HttpError(404, `unknown system "${name}"`)
    return system
  }

  // A system that spans nodes gets a node-scoped network name so two daemons
  // sharing one Docker engine (same-machine clusters) get SEPARATE bridges —
  // otherwise the trunk's DNS aliases would collide with the real containers.
  // Single-node systems keep the plain name (no migration).
  function spansNodes(system: SystemRecord): boolean {
    return Object.values(system.memberNodes ?? {}).some((n) => !!n)
  }
  function systemNet(system: SystemRecord): string {
    return spansNodes(system) ? `slab-net-${state.nodeName}-${system.name}` : `slab-net-${system.name}`
  }
  function trunkKey(system: SystemRecord): string {
    return `${state.nodeName}-${system.name}`
  }

  function systemsOf(appName: string): SystemRecord[] {
    return Object.values(systems).filter((s) => s.members.includes(appName))
  }

  // Resolve a member/app source into a concrete sourceDir (+ gitUrl if git-backed).
  // Tries local resolution first (absolute, or relative to baseDir); falls back
  // to git only when nothing exists on disk, to avoid git.ts's shorthand regex
  // misfiring on ordinary relative paths.
  async function resolveSource(source: string, baseDir: string): Promise<{ sourceDir: string; gitUrl: string | null }> {
    const asPath = path.isAbsolute(source) ? source : path.resolve(baseDir, source)
    if (fs.existsSync(asPath)) {
      return { sourceDir: asPath, gitUrl: null }
    }
    if (looksLikeGitUrl(source)) {
      try {
        const gitUrl = normalizeGitUrl(source)
        const sourceDir = await cloneOrPull(gitUrl, repoDirName(gitUrl))
        return { sourceDir, gitUrl }
      } catch (err) {
        throw new HttpError(400, (err as Error).message)
      }
    }
    throw new HttpError(400, `cannot resolve app source "${source}" — no directory at ${asPath} and it does not look like a git URL`)
  }

  // Shared app-creation logic used by POST /v1/apps and system member
  // auto-create (POST /v1/systems). expectedName, when set, is the system
  // manifest's member key — it must match the app's own slab.toml name.
  async function createAppFromSource(source: string, baseDir: string, expectedName?: string): Promise<AppRecord> {
    const { sourceDir, gitUrl } = await resolveSource(source, baseDir)
    let manifest: Manifest
    try {
      manifest = loadManifest(sourceDir)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    if (expectedName && manifest.name !== expectedName) {
      throw new HttpError(400, `member "${expectedName}" source declares app name "${manifest.name}" in its slab.toml — the member key must match the app's name`)
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
    return record
  }

  // Build + (re)start an app's container. Resolves wire env from every system
  // the app belongs to, merges it with manifest env / secrets / DATABASE_URL,
  // and joins the app to each of its systems' networks. Throws on failure
  // (after marking the record errored) — callers decide how to report it.
  async function deployApp(record: AppRecord): Promise<void> {
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

      const memberSystems = systemsOf(record.name)
      const prefix = `${record.name}.`
      const wireEnv: Record<string, string> = {}
      const wireSource: Record<string, string> = {}
      for (const system of memberSystems) {
        for (const [wireKey, value] of Object.entries(system.wires)) {
          if (!wireKey.startsWith(prefix)) continue
          const envKey = wireKey.slice(prefix.length)
          if (envKey in wireEnv && wireEnv[envKey] !== value) {
            throw new Error(
              `wire conflict on ${envKey} for ${record.name}: system "${wireSource[envKey]}" says "${wireEnv[envKey]}", system "${system.name}" says "${value}"`,
            )
          }
          wireEnv[envKey] = value
          wireSource[envKey] = system.name
        }
      }

      const secrets = getSecrets(record.name)
      // Merge order: manifest.env < wires < secrets < DATABASE_URL
      const env: Record<string, string> = { ...record.manifest.env, ...wireEnv, ...secrets }
      if (record.manifest.postgres) {
        env.DATABASE_URL = await engine.ensurePostgres(record.name)
      }

      if (record.manifest.public === false && record.manifest.type === 'function') {
        console.warn(`app "${record.name}" is private and a function — it cannot be woken by the ingress proxy`)
      }

      const networks = memberSystems.map((s) => systemNet(s))
      for (const net of networks) {
        await engine.ensureNetwork(net)
      }

      const containerId = await engine.runContainer(record, imageTag, env, {
        publish: record.manifest.public !== false,
        networks,
      })
      record.containerId = containerId
      record.imageTag = imageTag
      record.version += 1
      record.state = 'running'
      record.deployedAt = new Date().toISOString()
      record.error = null
      broadcast({ type: 'deploy', app: record.name })
      saveState(state)
    } catch (err) {
      record.state = 'error'
      record.error = (err as Error).message
      saveState(state)
      throw err
    }
  }

  // ── jobs: run-to-completion workloads ─────────────────────────────────────

  function getJobOr404(id: string): JobRecord {
    const job = jobs[id]
    if (!job) throw new HttpError(404, `unknown job "${id}"`)
    return job
  }

  const canceledJobs = new Set<string>()

  function newJobId(name: string): string {
    let suffix = Date.now().toString(36).slice(-4)
    while (jobs[`${name}-${suffix}`]) suffix = Math.random().toString(36).slice(2, 6)
    return `${name}-${suffix}`
  }

  // Wait for a started job's container to exit, enforcing the timeout.
  // Also used at boot to re-attach to jobs the previous daemon left running.
  async function finishJob(job: JobRecord): Promise<void> {
    const startedMs = job.startedAt ? new Date(job.startedAt).getTime() : Date.now()
    const remaining = Math.max(1000, startedMs + parseDuration(job.timeout) - Date.now())
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      engine.stopJob(job).catch((err) => console.error(`job ${job.id}: timeout stop failed: ${(err as Error).message}`))
    }, remaining)
    try {
      job.exitCode = await engine.waitJob(job.containerId!)
      job.state = canceledJobs.has(job.id) ? 'canceled'
        : timedOut ? 'failed'
        : job.exitCode === 0 ? 'succeeded' : 'failed'
      if (timedOut) job.error = `timed out after ${job.timeout}`
    } finally {
      clearTimeout(timer)
      canceledJobs.delete(job.id)
    }
    job.finishedAt = new Date().toISOString()
    saveState(state)
    broadcast({ type: 'job', job: job.id, state: job.state })
  }

  // Full lifecycle: build (or pull) -> run -> wait. Fired async by POST
  // /v1/jobs; all failures land on the record, never on the HTTP response.
  async function executeJob(job: JobRecord): Promise<void> {
    try {
      job.state = 'building'
      saveState(state)
      broadcast({ type: 'job', job: job.id, state: 'building' })
      const imageTag = await engine.buildJobImage(job)
      if (canceledJobs.has(job.id)) {
        canceledJobs.delete(job.id)
        job.state = 'canceled'
        job.finishedAt = new Date().toISOString()
        saveState(state)
        return
      }
      job.containerId = await engine.runJob(job, imageTag)
      job.state = 'running'
      job.startedAt = new Date().toISOString()
      saveState(state)
      broadcast({ type: 'job', job: job.id, state: 'running' })
      await finishJob(job)
    } catch (err) {
      job.state = 'failed'
      job.error = (err as Error).message
      job.finishedAt = new Date().toISOString()
      saveState(state)
      broadcast({ type: 'job', job: job.id, state: 'failed' })
    }
  }

  // Keep job history bounded: drop the oldest finished records (and their
  // containers, best-effort) beyond JOB_HISTORY_MAX.
  function pruneJobs(): void {
    const finished = Object.values(jobs)
      .filter((j) => j.state === 'succeeded' || j.state === 'failed' || j.state === 'canceled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const old of finished.slice(JOB_HISTORY_MAX)) {
      engine.removeJob(old).catch(() => { /* container may already be gone */ })
      delete jobs[old.id]
    }
  }

  // Boot reconcile: re-attach to jobs the previous daemon left in flight.
  // A running container is awaited (even if it exited while we were down,
  // docker wait returns its code immediately); anything else is failed.
  for (const job of Object.values(jobs)) {
    if (job.state !== 'queued' && job.state !== 'building' && job.state !== 'running') continue
    if (job.state === 'running' && job.containerId) {
      finishJob(job).catch((err) => {
        job.state = 'failed'
        job.error = `lost after daemon restart: ${(err as Error).message}`
        job.finishedAt = new Date().toISOString()
        saveState(state)
      })
    } else {
      job.state = 'failed'
      job.error = 'interrupted by daemon restart'
      job.finishedAt = new Date().toISOString()
    }
  }
  saveState(state)

  // Write the generated trunk script for a system and return its path
  // (bind-mounted read-only into the trunk container).
  function writeTrunkScript(systemName: string): string {
    const dir = path.join(slabDir(), 'trunks')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${systemName}.js`)
    fs.writeFileSync(file, trunkScript)
    return file
  }

  function hostOfUrl(url: string): string {
    try { return new URL(url).hostname } catch { return url }
  }

  const api = express()
  api.use(express.json())

  // Cluster auth: loopback is always trusted (your own machine); anything
  // else must present this node's SLAB_TOKEN. With no token set, the daemon
  // is loopback-only in practice even when SLAB_BIND opens it up.
  const AUTH_TOKEN = nodeCfg.token
  api.use((req, res, next) => {
    const ip = req.socket.remoteAddress ?? ''
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
    if (loopback) { next(); return }
    if (AUTH_TOKEN && req.headers.authorization === `Bearer ${AUTH_TOKEN}`) { next(); return }
    // browsers can't set headers on page loads / EventSource — accept the
    // token as a query param too (the dashboard moves it to localStorage
    // and strips it from the URL immediately)
    if (AUTH_TOKEN && req.query.token === AUTH_TOKEN) { next(); return }
    res.status(401).json({ error: 'unauthorized — non-loopback requests require Authorization: Bearer $SLAB_TOKEN (or ?token=...)' })
  })

  // Rolling 60s of request timestamps per app — powers the req/min column
  const reqTimes = new Map<string, number[]>()
  function reqPerMin(name: string): number {
    const now = Date.now()
    return (reqTimes.get(name) ?? []).filter((t) => now - t < 60_000).length
  }

  api.get('/v1/apps', wrap(async (req, res) => {
    const payload = { apps: Object.values(state.apps).map((a) => ({ ...a, reqPerMin: reqPerMin(a.name) })) }
    // Content negotiation: browsers get a readable view, machines get JSON
    if ((req.headers.accept ?? '').includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(apiHumanHtml('/v1/apps', payload))
      return
    }
    res.json(payload)
  }))

  api.post('/v1/apps', wrap(async (req, res) => {
    const gitUrlInput = req.body?.gitUrl
    const sourceDirInput = req.body?.sourceDir
    let source: string
    if (typeof gitUrlInput === 'string' && gitUrlInput) {
      source = gitUrlInput
    } else if (typeof sourceDirInput === 'string' && path.isAbsolute(sourceDirInput)) {
      source = sourceDirInput
    } else {
      throw new HttpError(400, 'body must be { sourceDir: <absolute path> } or { gitUrl }')
    }
    const record = await createAppFromSource(source, process.cwd())
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
    try {
      await deployApp(record)
      res.json({ app: record })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
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

  api.get('/v1/systems', wrap(async (req, res) => {
    res.json({ systems: Object.values(systems) })
  }))

  api.post('/v1/systems', wrap(async (req, res) => {
    const sourceFile = req.body?.sourceFile
    if (typeof sourceFile !== 'string' || !path.isAbsolute(sourceFile)) {
      throw new HttpError(400, 'body must be { sourceFile: <absolute path to system.toml> }')
    }
    let manifest: SystemManifest
    try {
      manifest = loadSystemManifest(sourceFile)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    const baseDir = path.dirname(sourceFile)

    const memberNodes: Record<string, string> = {}
    for (const [memberName, cfg] of Object.entries(manifest.members)) {
      if (cfg.node && cfg.node !== state.nodeName) {
        if (!peers[cfg.node]) {
          throw new HttpError(400, `member "${memberName}" is placed on unknown node "${cfg.node}" — register it first: slab peer add ${cfg.node} <url>`)
        }
        memberNodes[memberName] = cfg.node
        continue   // created on the peer at deploy time (adopt)
      }
      if (!state.apps[memberName]) {
        await createAppFromSource(cfg.source, baseDir, memberName)
      }
      // if state.apps[memberName] already exists it is keyed by its own
      // manifest.name, so it trivially matches memberName already.
    }

    const existing = systems[manifest.name]
    const record: SystemRecord = {
      name: manifest.name,
      sourceFile,
      members: Object.keys(manifest.members),
      wires: manifest.wires,
      memberNodes,
      origin: null,
      trunkHostPort: existing?.trunkHostPort ?? null,
      trunkToken: existing?.trunkToken ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      deployedAt: existing?.deployedAt ?? null,
    }
    systems[manifest.name] = record
    saveState(state)
    res.status(existing ? 200 : 201).json({ system: record })
  }))

  api.post('/v1/systems/:name/deploy', wrap(async (req, res) => {
    const system = getSystemOr404(nameParam(req))
    await engine.ensureNetwork(systemNet(system))

    const memberNodes = system.memberNodes ?? {}
    const remoteByNode = new Map<string, string[]>()   // peer name -> member names
    for (const [m, n] of Object.entries(memberNodes)) {
      if (!n || n === state.nodeName) continue
      if (!remoteByNode.has(n)) remoteByNode.set(n, [])
      remoteByNode.get(n)!.push(m)
    }
    const localMembers = system.members.filter((m) => !memberNodes[m] || memberNodes[m] === state.nodeName)

    // ── remote members: each involved peer adopts the system (creates +
    // deploys ITS members, allocates its trunk port) ──
    const peerResults = new Map<string, { trunkPort: number; members: Array<{ name: string; port: number }> }>()
    if (remoteByNode.size > 0) {
      let manifest: SystemManifest
      try {
        manifest = loadSystemManifest(system.sourceFile)
      } catch (err) {
        res.status(500).json({ error: `cannot re-read system manifest ${system.sourceFile}: ${(err as Error).message}` })
        return
      }
      const baseDir = path.dirname(system.sourceFile)
      for (const [peerName, mems] of remoteByNode) {
        const peer = peers[peerName]
        if (!peer) {
          res.status(400).json({ error: `system "${system.name}" places members on unknown node "${peerName}" — slab peer add ${peerName} <url>` })
          return
        }
        // Resolve relative sources against the system.toml dir; git urls pass
        // through (the right choice across real machines — the peer clones).
        const membersPayload: Record<string, { source: string }> = {}
        for (const m of mems) {
          const src = manifest.members[m]?.source ?? ''
          const asPath = path.isAbsolute(src) ? src : path.resolve(baseDir, src)
          membersPayload[m] = { source: fs.existsSync(asPath) ? asPath : src }
        }
        try {
          const r = await clientFor(peer.url, peer.token).adoptSystem({
            name: system.name, origin: state.nodeName!, members: membersPayload,
            wires: system.wires, memberNodes,
          })
          peerResults.set(peerName, r)
        } catch (err) {
          res.status(500).json({ error: `node "${peerName}" failed to adopt system "${system.name}": ${(err as Error).message}` })
          return
        }
      }
    }

    // ── local members, dependency order ──
    const order = topoSortMembers(system).filter((m) => localMembers.includes(m))
    const memberRecords: AppRecord[] = []
    for (const memberName of order) {
      const app = state.apps[memberName]
      if (!app) {
        res.status(500).json({ error: `system "${system.name}" member "${memberName}" is not a known app` })
        return
      }
      try {
        await deployApp(app)
      } catch (err) {
        res.status(500).json({ error: `failed to deploy member "${memberName}" of system "${system.name}": ${(err as Error).message}` })
        return
      }
      memberRecords.push(app)
    }

    // ── trunks: one per involved node, stitching the system together ──
    if (remoteByNode.size > 0) {
      const ports = new Map<string, { port: number; node: string }>()
      for (const m of order) {
        const app = state.apps[m]
        if (app) ports.set(m, { port: app.manifest.port, node: state.nodeName! })
      }
      for (const [peerName, r] of peerResults) {
        for (const mi of r.members) ports.set(mi.name, { port: mi.port, node: peerName })
      }
      const seen = new Map<number, string>()
      for (const [m, info] of ports) {
        const clash = seen.get(info.port)
        if (clash) {
          res.status(400).json({ error: `a system that spans nodes needs distinct member ports: "${m}" and "${clash}" both listen on ${info.port}` })
          return
        }
        seen.set(info.port, m)
      }

      system.trunkHostPort ??= allocateHostPort(state)
      system.trunkToken ??= Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
      saveState(state)

      const trunkPeers: TrunkConfig['peers'] = {
        [state.nodeName!]: { host: nodeCfg.advertise, port: system.trunkHostPort },
      }
      for (const [peerName, r] of peerResults) {
        trunkPeers[peerName] = { host: hostOfUrl(peers[peerName].url), port: r.trunkPort }
      }
      const cfgFor = (nodeName: string): TrunkConfig => {
        const local: TrunkConfig['local'] = {}
        const remote: TrunkConfig['remote'] = {}
        for (const [m, info] of ports) {
          if (info.node === nodeName) local[m] = { port: info.port }
          else remote[m] = { port: info.port, node: info.node }
        }
        return { token: system.trunkToken!, ingressPort: TRUNK_INGRESS_PORT, local, remote, peers: trunkPeers }
      }

      try {
        await engine.runTrunk(trunkKey(system), writeTrunkScript(system.name), cfgFor(state.nodeName!), systemNet(system), system.trunkHostPort)
      } catch (err) {
        res.status(500).json({ error: `failed to start trunk for "${system.name}": ${(err as Error).message}` })
        return
      }
      for (const [peerName] of peerResults) {
        const peer = peers[peerName]
        try {
          await clientFor(peer.url, peer.token).trunkSync(system.name, cfgFor(peerName))
        } catch (err) {
          res.status(500).json({ error: `node "${peerName}" failed to start its trunk for "${system.name}": ${(err as Error).message}` })
          return
        }
      }
    } else if (system.trunkHostPort != null) {
      // system no longer spans nodes — retire the local trunk
      await engine.removeTrunk(trunkKey(system)).catch(() => { /* best-effort */ })
    }

    system.deployedAt = new Date().toISOString()
    saveState(state)
    res.json({ system, apps: memberRecords })
  }))

  // ── node-to-node: a console pushes a spanning system to this node ──────────

  api.post('/v1/systems/adopt', wrap(async (req, res) => {
    const body = req.body ?? {}
    const name = body.name
    if (typeof name !== 'string' || !name || typeof body.members !== 'object' || body.members === null) {
      throw new HttpError(400, 'body must be { name, origin, members, wires, memberNodes }')
    }
    const members = body.members as Record<string, { source?: unknown }>
    for (const [memberName, cfg] of Object.entries(members)) {
      if (!state.apps[memberName]) {
        await createAppFromSource(String(cfg?.source ?? ''), process.cwd(), memberName)
      }
    }
    const existing = systems[name]
    const record: SystemRecord = {
      name,
      sourceFile: `adopted:${String(body.origin ?? 'unknown')}`,
      members: Object.keys(members),
      wires: (body.wires ?? {}) as Record<string, string>,
      memberNodes: (body.memberNodes ?? {}) as Record<string, string>,
      origin: String(body.origin ?? '') || null,
      trunkHostPort: existing?.trunkHostPort ?? allocateHostPort(state),
      trunkToken: existing?.trunkToken ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      deployedAt: existing?.deployedAt ?? null,
    }
    systems[name] = record
    saveState(state)
    await engine.ensureNetwork(systemNet(record))

    const out: Array<{ name: string; port: number }> = []
    for (const memberName of record.members) {
      const app = state.apps[memberName]
      if (!app) throw new HttpError(500, `adopted member "${memberName}" is not a known app`)
      await deployApp(app)   // errors propagate as 500 {error} via the wrapper
      out.push({ name: memberName, port: app.manifest.port })
    }
    record.deployedAt = new Date().toISOString()
    saveState(state)
    res.json({ trunkPort: record.trunkHostPort, members: out })
  }))

  api.post('/v1/systems/:name/trunk-sync', wrap(async (req, res) => {
    const system = getSystemOr404(nameParam(req))
    const cfg = req.body as TrunkConfig
    if (!cfg || typeof cfg.token !== 'string' || typeof cfg.local !== 'object' || typeof cfg.peers !== 'object') {
      throw new HttpError(400, 'body must be a TrunkConfig { token, ingressPort, local, remote, peers }')
    }
    system.trunkToken = cfg.token
    system.trunkHostPort ??= allocateHostPort(state)
    saveState(state)
    const id = await engine.runTrunk(trunkKey(system), writeTrunkScript(system.name), cfg, systemNet(system), system.trunkHostPort)
    res.json({ trunk: id })
  }))

  api.delete('/v1/systems/:name', wrap(async (req, res) => {
    const system = getSystemOr404(nameParam(req))
    await engine.removeTrunk(trunkKey(system)).catch(() => { /* no trunk / already gone */ })
    // removeNetwork force-disconnects any still-connected member containers
    // per its contract (engine.ts) before removing the network itself.
    await engine.removeNetwork(systemNet(system))
    delete systems[system.name]
    saveState(state)
    res.status(204).end()
  }))

  api.get('/v1/jobs', wrap(async (req, res) => {
    const payload = { jobs: Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
    if ((req.headers.accept ?? '').includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(apiHumanHtml('/v1/jobs', payload))
      return
    }
    res.json(payload)
  }))

  api.post('/v1/jobs', wrap(async (req, res) => {
    const body = req.body ?? {}
    const image = typeof body.image === 'string' && body.image ? body.image : null
    const command: string[] = Array.isArray(body.command) ? body.command.map(String) : []
    const env: Record<string, string> =
      typeof body.env === 'object' && body.env !== null && !Array.isArray(body.env)
        ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {}
    const timeout = body.timeout != null ? String(body.timeout) : JOB_DEFAULT_TIMEOUT
    if (!/^\d+(s|m|h)$/.test(timeout)) {
      throw new HttpError(400, `invalid timeout "${timeout}" — use e.g. "90s", "10m", "1h"`)
    }

    let sourceDir: string | null = null
    let gitUrl: string | null = null
    const sourceInput = typeof body.gitUrl === 'string' && body.gitUrl ? body.gitUrl
      : typeof body.sourceDir === 'string' && body.sourceDir ? body.sourceDir : null
    if (sourceInput) {
      if (!body.gitUrl && !path.isAbsolute(sourceInput)) {
        throw new HttpError(400, 'sourceDir must be an absolute path')
      }
      const resolved = await resolveSource(sourceInput, process.cwd())
      sourceDir = resolved.sourceDir
      gitUrl = resolved.gitUrl
    }
    if (!sourceDir && !image) {
      throw new HttpError(400, 'body must include { sourceDir } or { gitUrl } (a Dockerfile to build) and/or { image } (a stock image; source is mounted at /workspace)')
    }
    if (sourceDir && !image && !fs.existsSync(path.join(sourceDir, 'Dockerfile'))) {
      throw new HttpError(400, `${sourceDir} has no Dockerfile — pass { image } to run the source in a stock image instead`)
    }
    if (!sourceDir && command.length === 0) {
      throw new HttpError(400, 'a bare image job needs a { command } to run')
    }

    const name = sanitizeJobName(
      typeof body.name === 'string' && body.name ? body.name
        : sourceDir ? path.basename(sourceDir)
        : image!.split('/').pop()!.split(':')[0],
    )
    const job: JobRecord = {
      id: newJobId(name),
      name,
      sourceDir,
      gitUrl,
      image,
      command,
      env,
      timeout,
      state: 'queued',
      exitCode: null,
      containerId: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    }
    jobs[job.id] = job
    pruneJobs()
    saveState(state)
    void executeJob(job)
    res.status(201).json({ job })
  }))

  api.get('/v1/jobs/:id', wrap(async (req, res) => {
    res.json({ job: getJobOr404(idParam(req)) })
  }))

  api.get('/v1/jobs/:id/logs', wrap(async (req, res) => {
    const job = getJobOr404(idParam(req))
    const logs = await engine.getJobLogs(job, parseTail(req.query.tail))
    res.json({ logs })
  }))

  api.post('/v1/jobs/:id/cancel', wrap(async (req, res) => {
    const job = getJobOr404(idParam(req))
    if (job.state !== 'queued' && job.state !== 'building' && job.state !== 'running') {
      throw new HttpError(409, `job "${job.id}" already finished (${job.state})`)
    }
    canceledJobs.add(job.id)
    if (job.state === 'running') await engine.stopJob(job)   // finishJob's wait resolves and marks it canceled
    res.json({ job })
  }))

  api.delete('/v1/jobs/:id', wrap(async (req, res) => {
    const job = getJobOr404(idParam(req))
    canceledJobs.add(job.id)
    await engine.removeJob(job)
    canceledJobs.delete(job.id)
    delete jobs[job.id]
    saveState(state)
    res.status(204).end()
  }))

  api.get('/v1/peers', wrap(async (_req, res) => {
    res.json({ peers: Object.values(peers) })
  }))

  api.put('/v1/peers/:name', wrap(async (req, res) => {
    const name = nameParam(req)
    if (!JOB_NAME_RE.test(name)) {
      throw new HttpError(400, 'invalid peer name — lowercase letters, digits, hyphens, 2-31 chars')
    }
    const url = req.body?.url
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      throw new HttpError(400, 'body must be { url: "http://host:port", token? }')
    }
    const token = typeof req.body?.token === 'string' && req.body.token ? req.body.token : undefined
    peers[name] = { name, url: url.replace(/\/+$/, ''), token }
    saveState(state)
    res.json({ peer: peers[name] })
  }))

  api.delete('/v1/peers/:name', wrap(async (req, res) => {
    const name = nameParam(req)
    if (!peers[name]) throw new HttpError(404, `unknown peer "${name}"`)
    delete peers[name]
    saveState(state)
    res.status(204).end()
  }))

  api.put('/v1/node', wrap(async (req, res) => {
    const name = req.body?.name
    if (typeof name !== 'string' || !JOB_NAME_RE.test(name)) {
      throw new HttpError(400, 'body must be { name } — lowercase letters, digits, hyphens, 2-31 chars')
    }
    state.nodeName = name
    saveState(state)
    res.json({ node: name })
  }))

  api.get('/v1/health', wrap(async (req, res) => {
    const payload = { status: 'ok', node: state.nodeName, apps: Object.keys(state.apps).length, proxyPort: PROXY_PORT }
    if ((req.headers.accept ?? '').includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(apiHumanHtml('/v1/health', payload))
      return
    }
    res.json(payload)
  }))

  api.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(dashboardHtml(PROXY_PORT))
  })

  api.get('/favicon.svg', (_req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(faviconSvg)
  })

  // ── skins: user-built dashboard themes ────────────────────────────────────
  // Built-ins live in the page's stylesheet (data-skin attr); custom skins are
  // plain CSS files in ~/.slab/skins/<name>.css, loaded over the base styles.
  const SKINS_DIR = path.join(process.env.SLAB_DIR ?? path.join(os.homedir(), '.slab'), 'skins')
  const SKIN_RE = /^[a-z0-9-]+$/

  api.get('/v1/skins', wrap(async (_req, res) => {
    let custom: string[] = []
    try {
      custom = fs.readdirSync(SKINS_DIR)
        .filter((f) => f.endsWith('.css'))
        .map((f) => f.slice(0, -4))
        .filter((n) => SKIN_RE.test(n))
        .sort()
    } catch { /* no skins dir yet */ }
    res.json({ skins: ['stereo', 'hyperscaler', ...custom.filter((n) => n !== 'stereo' && n !== 'hyperscaler')] })
  }))

  api.get('/skins/:file', wrap(async (req, res) => {
    const file = idParamLike(req.params.file)
    const m = /^([a-z0-9-]+)\.css$/.exec(file)
    if (!m) throw new HttpError(400, 'skin files are <name>.css')
    const full = path.join(SKINS_DIR, `${m[1]}.css`)
    if (!fs.existsSync(full)) throw new HttpError(404, `no skin "${m[1]}" in ${SKINS_DIR}`)
    res.setHeader('Content-Type', 'text/css; charset=utf-8')
    res.send(fs.readFileSync(full, 'utf-8'))
  }))

  // Player: round-robin healthchecks through the ingress — every note is a
  // real request; if you can hear an app, it's answering.
  let playTimer: NodeJS.Timeout | null = null
  let playUntil = 0
  function startPlay(seconds: number): void {
    playUntil = Date.now() + seconds * 1000
    if (playTimer) return
    let idx = 0
    playTimer = setInterval(() => {
      if (Date.now() > playUntil) {
        if (playTimer) clearInterval(playTimer)
        playTimer = null
        return
      }
      // sleeping functions are included on purpose: the request wakes them,
      // so pressing play literally powers up the whole rack
      const targets = Object.values(state.apps).filter(
        (a) => (a.state === 'running' || a.state === 'sleeping') && a.manifest.public !== false && a.hostPort != null
      )
      if (!targets.length) return
      const app = targets[idx % targets.length]
      idx += 1
      const req = require('http').request(
        { host: '127.0.0.1', port: PROXY_PORT, path: '/health', method: 'GET',
          headers: { Host: app.name + '.localhost' }, timeout: 3000 },
        (r: { resume: () => void }) => { r.resume() }
      )
      req.on('error', () => { /* silence is the signal */ })
      req.end()
    }, 340)
  }

  api.post('/v1/play', wrap(async (req, res) => {
    const seconds = Math.min(300, Math.max(5, Number(req.body?.seconds ?? 45)))
    startPlay(seconds)
    res.json({ playing: true, seconds })
  }))

  // Live event stream (SSE) — the dashboard's audio monitor listens here
  const sseClients = new Set<Response>()
  function broadcast(event: Record<string, unknown>): void {
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const client of sseClients) {
      try { client.write(line) } catch { sseClients.delete(client) }
    }
  }

  api.get('/v1/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write('data: {"type":"hello"}\n\n')
    sseClients.add(res)
    req.on('close', () => { sseClients.delete(res) })
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
    broadcast({ type: 'request', app: name })
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

  fs.writeFileSync(path.join(slabDir(), 'daemon.pid'), String(process.pid))

  api.listen(DAEMON_PORT, nodeCfg.bind, () => {
    proxyServer.listen(PROXY_PORT, nodeCfg.bind, () => {
      const appCount = Object.keys(state.apps).length
      console.log(`slab daemon up — node:${state.nodeName} bind:${nodeCfg.bind} api:${DAEMON_PORT} proxy:${PROXY_PORT} apps:${appCount}`)
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

// On startup, make sure every system's network exists and every currently
// running member is (re)joined to it — best-effort, never fails boot.
// Spanning systems use node-scoped network names (see systemNet in main).
async function reconcileSystems(state: ReturnType<typeof loadState>, engine: Engine): Promise<void> {
  for (const system of Object.values(state.systems ?? {})) {
    const spans = Object.values(system.memberNodes ?? {}).some((n) => !!n)
    const net = spans ? `slab-net-${state.nodeName}-${system.name}` : `slab-net-${system.name}`
    try {
      await engine.ensureNetwork(net)
    } catch (err) {
      console.error(`reconcile: failed to ensure network for system ${system.name}: ${(err as Error).message}`)
    }
    for (const memberName of system.members) {
      const app = state.apps[memberName]
      if (!app || app.state !== 'running') continue
      try {
        await engine.connectNetworks(app, [net])
      } catch (err) {
        console.error(`reconcile: failed to connect ${app.name} to system ${system.name}: ${(err as Error).message}`)
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
