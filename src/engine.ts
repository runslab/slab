// slab — docker engine. Implements Engine (types.ts) with dockerode against
// the default local socket.
import Docker from 'dockerode'
import { AppRecord, Engine, JobRecord, TrunkConfig } from './types'
import { TRUNK_INGRESS_PORT } from './trunk'

const TRUNK_IMAGE = 'node:22-alpine'

const PG_CONTAINER_NAME = 'slab-postgres'
const PG_IMAGE = 'postgres:16-alpine'
const PG_VOLUME = 'slab-pgdata'
const PG_PORT = 20432
const PG_USER = 'slab'
const PG_PASSWORD = 'slab'
const PG_READY_TIMEOUT_MS = 30_000

// ── Small helpers ─────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Docker returns 304 when an operation is a no-op (e.g. stopping an already
// stopped container) and 404 when the target doesn't exist. Both are fine to
// swallow for our idempotent stop/start/remove operations.
function isIgnorable(err: unknown): boolean {
  const code = (err as { statusCode?: number } | null)?.statusCode
  return code === 304 || code === 404
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Docker multiplexes stdout/stderr into frames: 1 byte stream type, 3 bytes
// padding, 4 bytes big-endian payload length, then the payload. Strip the
// headers and concatenate the payloads into plain text.
function demuxLogs(buf: Buffer): string {
  const parts: string[] = []
  let offset = 0
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > buf.length) break
    parts.push(buf.subarray(start, end).toString('utf-8'))
    offset = end
  }
  if (parts.length === 0 && buf.length > 0) return buf.toString('utf-8')
  return parts.join('')
}

// ── Engine ────────────────────────────────────────────────────────────────

export function createEngine(): Engine {
  const docker = new Docker()

  async function findContainerByLabel(label: string): Promise<Docker.ContainerInfo | null> {
    const containers = await docker.listContainers({ all: true, filters: { label: [label] } })
    return containers[0] ?? null
  }

  // Prefer the stored containerId (fast path); fall back to a label lookup
  // if it's stale (e.g. the container was recreated out of band).
  async function resolveContainer(app: AppRecord): Promise<Docker.Container | null> {
    if (app.containerId) {
      const c = docker.getContainer(app.containerId)
      try {
        await c.inspect()
        return c
      } catch {
        // stale id — fall through to label lookup
      }
    }
    const info = await findContainerByLabel(`slab.app=${app.name}`)
    return info ? docker.getContainer(info.Id) : null
  }

  async function imageExists(tagOrName: string): Promise<boolean> {
    try {
      await docker.getImage(tagOrName).inspect()
      return true
    } catch {
      return false
    }
  }

  async function pullImage(image: string, platform?: string): Promise<void> {
    let stream: NodeJS.ReadableStream
    try {
      stream = await docker.pull(image, platform ? { platform } : undefined)
    } catch (err) {
      throw new Error(`docker pull failed for ${image}: ${errMsg(err)}`)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(docker as any).modem.followProgress(
          stream,
          (err: unknown, events: Array<{ error?: string; errorDetail?: { message?: string } }>) => {
            if (err) return reject(new Error(`docker pull failed for ${image}: ${errMsg(err)}`))
            const failure = events?.find((e) => e && (e.error || e.errorDetail))
            if (failure) {
              return reject(new Error(`docker pull failed for ${image}: ${failure.error ?? failure.errorDetail?.message}`))
            }
            resolve()
          },
        )
      })
    } catch (err) {
      // Old images often ship amd64-only; Apple silicon runs them via Rosetta
      // if we ask for the platform explicitly. One retry, then give up.
      const msg = errMsg(err)
      if (!platform && /manifest|platform|arm64|no match/i.test(msg)) {
        await pullImage(image, 'linux/amd64')
        return
      }
      throw err
    }
  }

  async function buildImage(app: AppRecord): Promise<string> {
    if (app.manifest.image) {
      await pullImage(app.manifest.image)
      return app.manifest.image
    }

    const tag = `slab/${app.name}:${app.version}`
    let stream: NodeJS.ReadableStream
    try {
      stream = await docker.buildImage({ context: app.sourceDir, src: ['.'] }, { t: tag })
    } catch (err) {
      throw new Error(`docker build failed for ${app.name}: ${errMsg(err)}`)
    }

    let lastLine = ''
    let buildError: string | null = null
    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(docker as any).modem.followProgress(
        stream,
        (err: unknown, events: Array<{ stream?: string; error?: string; errorDetail?: { message?: string } }>) => {
          if (err) return reject(new Error(`docker build failed for ${app.name}: ${errMsg(err)}`))
          const failure = events?.find((e) => e && (e.error || e.errorDetail))
          if (failure) buildError = failure.error ?? failure.errorDetail?.message ?? 'unknown build error'
          resolve()
        },
        (event: { stream?: string; error?: string }) => {
          if (event.stream && event.stream.trim()) lastLine = event.stream.trim()
          if (event.error) buildError = event.error
        },
      )
    })

    if (buildError) {
      throw new Error(`docker build failed for ${app.name}: ${buildError} (last log: ${lastLine || 'n/a'})`)
    }
    return tag
  }

  // Remove every container labeled for this app — there should only ever be
  // one, but a crashed prior deploy could have left extras behind.
  async function removeExistingContainers(name: string): Promise<void> {
    const containers = await docker.listContainers({ all: true, filters: { label: [`slab.app=${name}`] } })
    for (const info of containers) {
      const c = docker.getContainer(info.Id)
      if (info.State === 'running') {
        await c.stop({ t: 5 }).catch((err) => {
          if (!isIgnorable(err)) throw new Error(`failed to stop existing container for ${name}: ${errMsg(err)}`)
        })
      }
      await c.remove({ force: true }).catch((err) => {
        if (!isIgnorable(err)) throw new Error(`failed to remove existing container for ${name}: ${errMsg(err)}`)
      })
    }
  }

  async function runContainer(
    app: AppRecord,
    imageTag: string,
    env: Record<string, string>,
    opts?: { publish?: boolean; networks?: string[] },
  ): Promise<string> {
    const publish = opts?.publish ?? true

    if (publish && app.hostPort == null) {
      throw new Error(`app ${app.name} has no hostPort allocated`)
    }

    await removeExistingContainers(app.name)

    const portKey = `${app.manifest.port}/tcp`
    let container: Docker.Container
    try {
      container = await docker.createContainer({
        name: `slab-${app.name}`,
        Image: imageTag,
        Labels: { 'slab.app': app.name },
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: publish ? { [portKey]: {} } : undefined,
        HostConfig: {
          PortBindings: publish
            ? { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(app.hostPort) }] }
            : undefined,
          RestartPolicy: { Name: app.manifest.type === 'service' ? 'unless-stopped' : 'no' },
        },
      })
    } catch (err) {
      throw new Error(`failed to create container for ${app.name}: ${errMsg(err)}`)
    }

    try {
      await container.start()
    } catch (err) {
      await container.remove({ force: true }).catch(() => { /* best-effort cleanup */ })
      throw new Error(`failed to start container for ${app.name}: ${errMsg(err)}`)
    }

    if (opts?.networks && opts.networks.length > 0) {
      await connectNetworks(app, opts.networks)
    }

    return container.id
  }

  // ── system network layer ────────────────────────────────────────────────

  function isNetworkConflict(err: unknown): boolean {
    const code = (err as { statusCode?: number } | null)?.statusCode
    const message = errMsg(err)
    return code === 409 || /already exists/i.test(message)
  }

  async function ensureNetwork(name: string): Promise<void> {
    try {
      await docker.createNetwork({ Name: name, Driver: 'bridge', Labels: { 'slab.system': name } })
    } catch (err) {
      if (!isNetworkConflict(err) && !isIgnorable(err)) {
        throw new Error(`failed to create network ${name}: ${errMsg(err)}`)
      }
    }
  }

  async function removeNetwork(name: string): Promise<void> {
    const network = docker.getNetwork(name)
    try {
      await network.remove()
      return
    } catch (err) {
      if (isIgnorable(err)) return
      // Fall through: likely "has active endpoints" — disconnect members and retry.
    }

    try {
      const info = await network.inspect()
      const containerIds = Object.keys(info.Containers ?? {})
      for (const id of containerIds) {
        await network.disconnect({ Container: id, Force: true }).catch((err) => {
          if (!isIgnorable(err)) throw new Error(`failed to disconnect ${id} from network ${name}: ${errMsg(err)}`)
        })
      }
    } catch (err) {
      if (isIgnorable(err)) return
      throw new Error(`failed to inspect network ${name} for removal: ${errMsg(err)}`)
    }

    try {
      await network.remove()
    } catch (err) {
      if (!isIgnorable(err)) throw new Error(`failed to remove network ${name}: ${errMsg(err)}`)
    }
  }

  async function connectNetworks(app: AppRecord, networks: string[]): Promise<void> {
    const c = await resolveContainer(app)
    if (!c) throw new Error(`no container found for app ${app.name}`)
    const id = c.id

    for (const name of networks) {
      try {
        await docker.getNetwork(name).connect({ Container: id, EndpointConfig: { Aliases: [app.name] } })
      } catch (err) {
        if (isNetworkConflict(err)) continue
        throw new Error(`failed to connect ${app.name} to network ${name}: ${errMsg(err)}`)
      }
    }
  }

  // ── job layer ───────────────────────────────────────────────────────────

  async function buildJobImage(job: JobRecord): Promise<string> {
    if (job.image) {
      if (!(await imageExists(job.image))) await pullImage(job.image)
      return job.image
    }
    if (!job.sourceDir) throw new Error(`job ${job.id} has neither an image nor a source directory`)
    const suffix = job.id.slice(job.name.length + 1) || 'latest'
    const tag = `slab-job/${job.name}:${suffix}`
    let stream: NodeJS.ReadableStream
    try {
      stream = await docker.buildImage({ context: job.sourceDir, src: ['.'] }, { t: tag })
    } catch (err) {
      throw new Error(`docker build failed for job ${job.id}: ${errMsg(err)}`)
    }
    let lastLine = ''
    let buildError: string | null = null
    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(docker as any).modem.followProgress(
        stream,
        (err: unknown, events: Array<{ error?: string; errorDetail?: { message?: string } }>) => {
          if (err) return reject(new Error(`docker build failed for job ${job.id}: ${errMsg(err)}`))
          const failure = events?.find((e) => e && (e.error || e.errorDetail))
          if (failure) buildError = failure.error ?? failure.errorDetail?.message ?? 'unknown build error'
          resolve()
        },
        (event: { stream?: string; error?: string }) => {
          if (event.stream && event.stream.trim()) lastLine = event.stream.trim()
          if (event.error) buildError = event.error
        },
      )
    })
    if (buildError) {
      throw new Error(`docker build failed for job ${job.id}: ${buildError} (last log: ${lastLine || 'n/a'})`)
    }
    return tag
  }

  async function resolveJobContainer(job: JobRecord): Promise<Docker.Container | null> {
    if (job.containerId) {
      const c = docker.getContainer(job.containerId)
      try {
        await c.inspect()
        return c
      } catch {
        // stale id — fall through to label lookup
      }
    }
    const info = await findContainerByLabel(`slab.job=${job.id}`)
    return info ? docker.getContainer(info.Id) : null
  }

  async function runJob(job: JobRecord, imageTag: string): Promise<string> {
    // A crashed prior daemon could have left a container for this id behind
    const stale = await findContainerByLabel(`slab.job=${job.id}`)
    if (stale) await docker.getContainer(stale.Id).remove({ force: true }).catch(() => { /* best-effort */ })

    const mount = job.image && job.sourceDir ? job.sourceDir : null
    let container: Docker.Container
    try {
      container = await docker.createContainer({
        name: `slab-job-${job.id}`,
        Image: imageTag,
        Labels: { 'slab.job': job.id },
        Env: Object.entries(job.env).map(([k, v]) => `${k}=${v}`),
        Cmd: job.command.length ? job.command : undefined,
        WorkingDir: mount ? '/workspace' : undefined,
        HostConfig: {
          Binds: mount ? [`${mount}:/workspace`] : undefined,
          RestartPolicy: { Name: 'no' },
        },
      })
    } catch (err) {
      throw new Error(`failed to create container for job ${job.id}: ${errMsg(err)}`)
    }
    try {
      await container.start()
    } catch (err) {
      await container.remove({ force: true }).catch(() => { /* best-effort cleanup */ })
      throw new Error(`failed to start job ${job.id}: ${errMsg(err)}`)
    }
    return container.id
  }

  async function waitJob(containerId: string): Promise<number> {
    const c = docker.getContainer(containerId)
    try {
      const res = (await c.wait()) as { StatusCode?: number }
      return res?.StatusCode ?? -1
    } catch (err) {
      // container already gone -> read the exit code from inspect if possible
      try {
        const info = await c.inspect()
        return info.State?.ExitCode ?? -1
      } catch {
        throw new Error(`failed to wait for job container ${containerId.slice(0, 12)}: ${errMsg(err)}`)
      }
    }
  }

  async function getJobLogs(job: JobRecord, tail: number): Promise<string> {
    const c = await resolveJobContainer(job)
    if (!c) return ''
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: false })
    return demuxLogs(buf)
  }

  async function stopJob(job: JobRecord): Promise<void> {
    const c = await resolveJobContainer(job)
    if (!c) return
    try {
      await c.stop({ t: 5 })
    } catch (err) {
      if (!isIgnorable(err)) throw new Error(`failed to stop job ${job.id}: ${errMsg(err)}`)
    }
  }

  async function removeJob(job: JobRecord): Promise<void> {
    const c = await resolveJobContainer(job)
    if (!c) return
    try {
      await c.remove({ force: true })
    } catch (err) {
      if (!isIgnorable(err)) throw new Error(`failed to remove job container for ${job.id}: ${errMsg(err)}`)
    }
  }

  // ── trunk layer ─────────────────────────────────────────────────────────

  async function removeTrunk(systemName: string): Promise<void> {
    const containers = await docker.listContainers({ all: true, filters: { label: [`slab.trunk=${systemName}`] } })
    for (const info of containers) {
      await docker.getContainer(info.Id).remove({ force: true }).catch((err) => {
        if (!isIgnorable(err)) throw new Error(`failed to remove trunk for ${systemName}: ${errMsg(err)}`)
      })
    }
  }

  async function runTrunk(
    systemName: string,
    scriptPath: string,
    cfg: TrunkConfig,
    network: string,
    hostPort: number,
  ): Promise<string> {
    await removeTrunk(systemName)
    if (!(await imageExists(TRUNK_IMAGE))) await pullImage(TRUNK_IMAGE)

    // Inside a container, 127.0.0.1 is the container itself — a peer trunk
    // published on the host loopback (same-machine cluster) is reached via
    // host.docker.internal instead.
    const peers = Object.fromEntries(Object.entries(cfg.peers).map(([node, p]) => [
      node,
      { ...p, host: p.host === '127.0.0.1' || p.host === 'localhost' ? 'host.docker.internal' : p.host },
    ]))
    const containerCfg: TrunkConfig = { ...cfg, peers, ingressPort: TRUNK_INGRESS_PORT }

    const portKey = `${TRUNK_INGRESS_PORT}/tcp`
    let container: Docker.Container
    try {
      container = await docker.createContainer({
        name: `slab-trunk-${systemName}`,
        Image: TRUNK_IMAGE,
        Labels: { 'slab.trunk': systemName },
        Cmd: ['node', '/trunk.js'],
        Env: [`TRUNK_CONFIG=${JSON.stringify(containerCfg)}`],
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
          Binds: [`${scriptPath}:/trunk.js:ro`],
          PortBindings: { [portKey]: [{ HostIp: '0.0.0.0', HostPort: String(hostPort) }] },
          RestartPolicy: { Name: 'unless-stopped' },
          ExtraHosts: ['host.docker.internal:host-gateway'],
        },
      })
    } catch (err) {
      throw new Error(`failed to create trunk for ${systemName}: ${errMsg(err)}`)
    }
    try {
      await container.start()
    } catch (err) {
      await container.remove({ force: true }).catch(() => { /* best-effort cleanup */ })
      throw new Error(`failed to start trunk for ${systemName}: ${errMsg(err)}`)
    }

    // Join the system network wearing every remote member's name.
    const aliases = Object.keys(cfg.remote)
    try {
      await docker.getNetwork(network).connect({ Container: container.id, EndpointConfig: { Aliases: aliases } })
    } catch (err) {
      if (!isNetworkConflict(err)) {
        throw new Error(`failed to join trunk to ${network}: ${errMsg(err)}`)
      }
    }
    return container.id
  }

  async function stopContainer(app: AppRecord): Promise<void> {
    const c = await resolveContainer(app)
    if (!c) return
    try {
      await c.stop({ t: 5 })
    } catch (err) {
      if (!isIgnorable(err)) throw new Error(`failed to stop container for ${app.name}: ${errMsg(err)}`)
    }
  }

  async function startContainer(app: AppRecord): Promise<void> {
    const c = await resolveContainer(app)
    if (!c) throw new Error(`no container found for app ${app.name}`)
    try {
      await c.start()
    } catch (err) {
      if (!isIgnorable(err)) throw new Error(`failed to start container for ${app.name}: ${errMsg(err)}`)
    }
  }

  async function removeContainer(app: AppRecord): Promise<void> {
    const c = await resolveContainer(app)
    if (!c) return
    try {
      await c.stop({ t: 5 })
    } catch (err) {
      if (!isIgnorable(err)) throw new Error(`failed to stop container for ${app.name}: ${errMsg(err)}`)
    }
    try {
      await c.remove({ force: true })
    } catch (err) {
      if (!isIgnorable(err)) throw new Error(`failed to remove container for ${app.name}: ${errMsg(err)}`)
    }
  }

  async function getLogs(app: AppRecord, tail: number): Promise<string> {
    const c = await resolveContainer(app)
    if (!c) return ''
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: true })
    return demuxLogs(buf)
  }

  async function isRunning(app: AppRecord): Promise<boolean> {
    const info = await findContainerByLabel(`slab.app=${app.name}`)
    return info?.State === 'running'
  }

  // Run a command inside a container via exec and collect its demuxed output.
  async function execIn(container: Docker.Container, cmd: string[]): Promise<{ exitCode: number; output: string }> {
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({})
    const chunks: Buffer[] = []
    const output = await new Promise<string>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(demuxLogs(Buffer.concat(chunks))))
      stream.on('error', reject)
    })
    const info = await exec.inspect()
    return { exitCode: info.ExitCode ?? -1, output }
  }

  async function ensurePostgresContainer(): Promise<void> {
    const info = await findContainerByLabel('slab.system=postgres')
    if (!info) {
      if (!(await imageExists(PG_IMAGE))) await pullImage(PG_IMAGE)
      let container: Docker.Container
      try {
        container = await docker.createContainer({
          name: PG_CONTAINER_NAME,
          Image: PG_IMAGE,
          Labels: { 'slab.system': 'postgres' },
          Env: [`POSTGRES_PASSWORD=${PG_PASSWORD}`, `POSTGRES_USER=${PG_USER}`],
          ExposedPorts: { '5432/tcp': {} },
          HostConfig: {
            Binds: [`${PG_VOLUME}:/var/lib/postgresql/data`],
            PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(PG_PORT) }] },
            RestartPolicy: { Name: 'unless-stopped' },
          },
        })
      } catch (err) {
        throw new Error(`failed to create ${PG_CONTAINER_NAME}: ${errMsg(err)}`)
      }
      try {
        await container.start()
      } catch (err) {
        await container.remove({ force: true }).catch(() => { /* best-effort cleanup */ })
        throw new Error(`failed to start ${PG_CONTAINER_NAME}: ${errMsg(err)}`)
      }
      return
    }
    if (info.State !== 'running') {
      try {
        await docker.getContainer(info.Id).start()
      } catch (err) {
        if (!isIgnorable(err)) throw new Error(`failed to start ${PG_CONTAINER_NAME}: ${errMsg(err)}`)
      }
    }
  }

  async function waitForPostgresReady(): Promise<void> {
    const container = docker.getContainer(PG_CONTAINER_NAME)
    const deadline = Date.now() + PG_READY_TIMEOUT_MS
    let lastOutput = ''
    while (Date.now() < deadline) {
      try {
        const { exitCode, output } = await execIn(container, ['pg_isready', '-U', PG_USER])
        if (exitCode === 0) return
        lastOutput = output
      } catch (err) {
        lastOutput = errMsg(err)
      }
      await sleep(500)
    }
    throw new Error(`postgres did not become ready within ${PG_READY_TIMEOUT_MS / 1000}s: ${lastOutput || 'n/a'}`)
  }

  async function ensureDatabase(dbName: string): Promise<void> {
    const container = docker.getContainer(PG_CONTAINER_NAME)
    const check = await execIn(container, ['psql', '-U', PG_USER, '-tAc', `SELECT 1 FROM pg_database WHERE datname='${dbName}'`])
    if (check.output.trim() === '1') return

    const create = await execIn(container, ['psql', '-U', PG_USER, '-c', `CREATE DATABASE ${dbName}`])
    if (create.exitCode !== 0 && !/already exists/i.test(create.output)) {
      throw new Error(`failed to create database ${dbName}: ${create.output.trim() || 'unknown error'}`)
    }
  }

  async function ensurePostgres(appName: string): Promise<string> {
    await ensurePostgresContainer()
    await waitForPostgresReady()
    const dbName = `slab_${appName.replace(/-/g, '_')}`
    await ensureDatabase(dbName)
    return `postgresql://${PG_USER}:${PG_PASSWORD}@host.docker.internal:${PG_PORT}/${dbName}`
  }

  return {
    buildImage,
    runContainer,
    stopContainer,
    startContainer,
    removeContainer,
    getLogs,
    isRunning,
    ensurePostgres,
    ensureNetwork,
    removeNetwork,
    connectNetworks,
    buildJobImage,
    runJob,
    waitJob,
    getJobLogs,
    stopJob,
    removeJob,
    runTrunk,
    removeTrunk,
  }
}
