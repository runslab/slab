#!/usr/bin/env node
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execSync, spawn } from 'child_process'
import { Command } from 'commander'
import { client, clientFor, appUrl } from './api-client'
import { loadManifest } from './manifest'
import { looksLikeGitUrl } from './git'
import { slabDir, loadNodeConfigFile, saveNodeConfigFile } from './state'
import { AppRecord, JobRecord, SystemRecord, DAEMON_PORT } from './types'

function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`error: ${msg}`)
  process.exit(1)
}

// Wrap an async command handler so rejected promises print `error: ...` and exit 1.
function action<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (err) {
      fail(err)
    }
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

// Ensure an app record exists for the given source dir, creating it if needed.
// Returns the app name (from slab.toml).
async function ensureApp(sourceDir: string): Promise<string> {
  const manifest = loadManifest(sourceDir)
  try {
    await api.getApp(manifest.name)
  } catch {
    await api.createApp({ sourceDir })
  }
  return manifest.name
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/

function sanitizeName(raw: string): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(name)) name = `app-${name}`
  name = name.slice(0, 31)
  while (name.length < 2) name += '0'
  return NAME_RE.test(name) ? name : 'app'
}

// Every command talks through `api`. It starts as the local daemon's client;
// --node <name> re-points it at a peer (resolved from the local peer registry,
// which carries each peer's URL + token).
let api = client
// Set when --node points at a peer — the ship-image deploy path needs the
// peer's raw url + token to stream a docker-save tarball at it.
let remotePeer: { name: string; url: string; token?: string } | null = null

// Commands that touch THIS machine (files, daemon process) — meaningless remotely.
const LOCAL_ONLY = new Set(['upgrade', 'open', 'close', 'token', 'advertise', 'daemon', 'init'])

const program = new Command()
program.name('slab').description('tiny local paas').version('1.0.0')
program.option('-N, --node <name>', 'target a peer node instead of the local daemon (see: slab peer ls)')

// Self-starting daemon: any command that needs the local daemon boots it
// when it isn't running (detached, logs to ~/.slab/daemon.log). No more
// "start it with: slab daemon" dead ends — critical for codespaces/demos
// where the daemon dies with the sandbox.
const NO_DAEMON_NEEDED = new Set(['daemon', 'init', 'upgrade', 'feedback'])
async function ensureDaemon(): Promise<void> {
  if (process.env.SLAB_DAEMON_URL) return   // explicitly pointed elsewhere — don't self-start
  try { await client.health(); return } catch { /* boot it */ }
  console.error('daemon not running — starting it…')
  const out = fs.openSync(path.join(slabDir(), 'daemon.log'), 'a')
  spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true,
    stdio: ['ignore', out, out],
  }).unref()
  for (let i = 0; i < 40; i++) {
    try { await client.health(); console.error('daemon up.'); return } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  throw new Error(`daemon did not come up — check ${path.join(slabDir(), 'daemon.log')}`)
}

program.hook('preAction', async (_thisCommand, actionCommand) => {
  if (!NO_DAEMON_NEEDED.has(actionCommand.name())) {
    try { await ensureDaemon() } catch (err) { fail(err) }
  }
  const target = program.opts().node as string | undefined
  if (!target) return
  if (LOCAL_ONLY.has(actionCommand.name())) {
    fail(new Error(`"slab ${actionCommand.name()}" runs on the machine itself — ssh to ${target} for that`))
  }
  try {
    if (target === 'any') {
      await scheduleOnLeastBusy(actionCommand)
      return
    }
    const [{ node }, { peers }] = await Promise.all([client.health(), client.listPeers()])
    if (target === node) return   // targeting ourselves — stay local
    const peer = peers.find((p) => p.name === target)
    if (!peer) {
      const known = [node ? `${node} (local)` : null, ...peers.map((p) => p.name)].filter(Boolean).join(', ')
      throw new Error(`unknown node "${target}" — known nodes: ${known || 'none'}. Register with: slab peer add ${target} <url> --token <t>`)
    }
    api = clientFor(peer.url, peer.token)
    remotePeer = { name: peer.name, url: peer.url, token: peer.token }
  } catch (err) {
    fail(err)
  }
})

// --node any: pick the node with the fewest active jobs. Only for `slab run`,
// and only git-sourced jobs can roam (a local dir doesn't exist on peers) —
// dir-sourced jobs stay local with a note.
const JOB_ACTIVE = new Set(['queued', 'building', 'running'])
async function scheduleOnLeastBusy(actionCommand: { name(): string; args: string[] }): Promise<void> {
  if (actionCommand.name() !== 'run') {
    throw new Error('--node any only applies to "slab run" — name a node for other commands')
  }
  const src = actionCommand.args[0]
  const roams = !!src && looksLikeGitUrl(src) && !isDir(path.resolve(src))
  const { node: localName } = await client.health()
  if (!roams) {
    console.error(`scheduling on ${localName} — directory sources can't roam (use a git url to fan out)`)
    return
  }
  const { peers } = await client.listPeers()
  const candidates = [
    { name: localName ?? 'local', c: client },
    ...peers.map((p) => ({ name: p.name, c: clientFor(p.url, p.token, 4000) })),
  ]
  const loads = await Promise.all(candidates.map(async (cand) => {
    try {
      const { jobs } = await cand.c.listJobs()
      return { ...cand, active: jobs.filter((j) => JOB_ACTIVE.has(j.state)).length }
    } catch {
      return { ...cand, active: Infinity }   // unreachable — never picked
    }
  }))
  const winner = loads.reduce((best, x) => (x.active < best.active ? x : best), loads[0])
  if (!Number.isFinite(winner.active)) throw new Error('no reachable node to schedule on')
  console.error(`scheduling on ${winner.name} (${winner.active} active job${winner.active === 1 ? '' : 's'})`)
  api = winner.c
}

program
  .command('create [source]')
  .description('create an app from a source dir or git url')
  .action(action(async (source?: string) => {
    const arg = source ?? process.cwd()
    const { app } = looksLikeGitUrl(arg) && !isDir(path.resolve(arg))
      ? await api.createApp({ gitUrl: arg })
      : await api.createApp({ sourceDir: path.resolve(arg) })
    const { proxyPort } = await api.health()
    console.log(`created ${app.name} (${app.manifest.type}) -> ${appUrl(app, proxyPort)}`)
  }))

// Ship a local docker image to a peer daemon: docker save | PUT /v1/images.
function shipImage(image: string, peer: { url: string; token?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const save = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'inherit'] })
    const u = new URL(peer.url + '/v1/images')
    const httpMod = u.protocol === 'https:' ? require('https') : require('http')
    const req = httpMod.request({
      method: 'PUT', hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { 'content-type': 'application/x-tar', ...(peer.token ? { authorization: `Bearer ${peer.token}` } : {}) },
    }, (res: { statusCode?: number; resume: () => void }) => {
      res.resume()
      if ((res.statusCode ?? 500) < 300) resolve()
      else reject(new Error(`image ship failed: peer answered ${res.statusCode}`))
    })
    req.on('error', reject)
    save.stdout.pipe(req)
    save.on('exit', (code) => { if (code !== 0) { req.destroy(); reject(new Error(`docker save exited ${code}`)) } })
  })
}

program
  .command('deploy [source]')
  .description('deploy an app (builds + starts) from a dir, git url, or app name')
  .option('--target <name>', 'run the app on a provider instead of local docker (e.g. aws); applies when the app is first created')
  .action(action(async (dirOrName: string | undefined, opts: { target?: string }) => {
    const arg = dirOrName ?? process.cwd()
    const asDir = path.resolve(arg)

    // Local dir + remote node: build HERE, ship the IMAGE, run THERE.
    // The peer never needs the source, git access, or a build toolchain.
    if (remotePeer && isDir(asDir)) {
      const manifest = loadManifest(asDir)
      let image = manifest.image
      if (!image) {
        image = `slab/${manifest.name}:shipped`
        console.log(`building ${image} locally…`)
        execSync(
          `docker build -t ${JSON.stringify(image)} -f ${JSON.stringify(path.join(asDir, manifest.dockerfile ?? 'Dockerfile'))} ${JSON.stringify(asDir)}`,
          { stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: '1' } },
        )
        console.log(`shipping ${image} -> ${remotePeer.name}…`)
        await shipImage(image, remotePeer)
      }
      const { node: origin } = await client.health().catch(() => ({ node: undefined as string | undefined }))
      await api.createApp({ manifest: { ...manifest, image }, origin: origin ?? 'remote' })
        .catch((e: Error) => { if (!/exists/.test(e.message)) throw e })
      const { app } = await api.deploy(manifest.name)
      const { proxyPort } = await api.health()
      if (app.state === 'running') {
        console.log(`deployed ${app.name} on ${remotePeer.name} -> http://${app.name}.localhost:${proxyPort} (v${app.version}, image shipped from here)`)
      } else {
        console.log(`${app.name}: ${app.state}${app.error ? ` — ${app.error}` : ''}`)
      }
      return
    }

    let name: string
    if (looksLikeGitUrl(arg) && !isDir(asDir)) {
      const { app } = await api.createApp({ gitUrl: arg, target: opts.target }).catch(async (e: Error) => {
        // 409 = already registered; find it by checkout name convention
        if (!/exists/.test(e.message)) throw e
        const m = /app "([^"]+)"/.exec(e.message)
        return api.getApp(m ? m[1] : arg)
      })
      name = app.name
    } else if (isDir(asDir)) {
      const manifest = loadManifest(asDir)
      try {
        await api.getApp(manifest.name)
      } catch {
        await api.createApp({ sourceDir: asDir, target: opts.target })
      }
      name = manifest.name
    } else {
      name = arg
    }
    // --target only applies at creation — refuse silently deploying elsewhere
    if (opts.target) {
      const { app } = await api.getApp(name)
      const current = app.target ?? 'docker'
      if (current !== opts.target) {
        throw new Error(`"${name}" already exists with target "${current}" — remove it first (slab rm ${name}) or set target = "${opts.target}" in its slab.toml`)
      }
    }
    const { app } = await api.deploy(name)
    if (app.state === 'running') {
      const { proxyPort } = await api.health()
      console.log(`deployed ${app.name} -> ${appUrl(app, proxyPort)} (v${app.version})`)
    } else {
      console.log(`${app.name}: ${app.state}${app.error ? ` — ${app.error}` : ''}`)
    }
  }))

program
  .command('up <file>')
  .description('deploy a system (a group of apps wired together) from a system.toml')
  .action(action(async (file: string) => {
    const asPath = path.resolve(file)
    const sourceFile = isDir(asPath) ? path.join(asPath, 'system.toml') : asPath
    const { system } = await api.createSystem(sourceFile)
    const { system: deployed, apps } = await api.deploySystem(system.name)
    const { proxyPort } = await api.health()
    const byName = new Map(apps.map((app) => [app.name, app]))
    const memberNodes = deployed.memberNodes ?? {}
    for (const name of deployed.members) {
      const app = byName.get(name)
      const loc = memberNodes[name] ? `@ ${memberNodes[name]} (via trunk)`
        : app && app.manifest.public !== false ? appUrl(app, proxyPort) : 'private'
      console.log(`  ${name} -> ${loc}`)
    }
    console.log(`system ${deployed.name} up (${deployed.members.length} apps)`)
  }))

function jobRuntime(job: JobRecord): string {
  if (!job.startedAt) return '-'
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()
  const sec = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60 ? String(sec % 60) + 's' : ''}`
}

const JOB_DONE = new Set(['succeeded', 'failed', 'canceled'])

program
  .command('run [source] [cmd...]')
  .description('run a job to completion: slab run . -- npm test (build the Dockerfile, or --image for a stock toolchain with the source mounted at /workspace)')
  .option('-i, --image <image>', 'run in a stock image instead of building; source is mounted at /workspace')
  .option('-e, --env <KEY=VALUE>', 'env var for the job (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('-t, --timeout <duration>', 'kill the job after this long (e.g. 90s, 10m, 1h)', '30m')
  .option('-d, --detach', 'start the job and return immediately (follow with: slab job logs <id>)')
  .option('--name <name>', 'job name (default: source dir basename)')
  .option('-s, --system <name>', 'join a system network — the job reaches members (incl. private) by name (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .action(action(async (source: string | undefined, cmd: string[], opts: { image?: string; env: string[]; timeout: string; detach?: boolean; name?: string; system: string[] }) => {
    // `slab run -- npm test` puts "npm" in [source]; if the arg is neither a
    // directory nor a git url, treat it as the first command word (cwd source).
    let src = source ?? process.cwd()
    if (source && !isDir(path.resolve(source)) && !looksLikeGitUrl(source)) {
      cmd = [source, ...cmd]
      src = process.cwd()
    }
    const env: Record<string, string> = {}
    for (const pair of opts.env) {
      const i = pair.indexOf('=')
      if (i <= 0) throw new Error(`malformed KEY=VALUE pair: "${pair}"`)
      env[pair.slice(0, i)] = pair.slice(i + 1)
    }
    const spec = {
      ...(looksLikeGitUrl(src) && !isDir(path.resolve(src)) ? { gitUrl: src } : { sourceDir: path.resolve(src) }),
      ...(opts.image ? { image: opts.image } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.system.length ? { systems: opts.system } : {}),
      command: cmd,
      env,
      timeout: opts.timeout,
    }
    let { job } = await api.createJob(spec)
    console.log(`job ${job.id} — ${job.image ?? 'dockerfile build'}${cmd.length ? ' — ' + cmd.join(' ') : ''}`)
    if (opts.detach) return

    process.on('SIGINT', async () => {
      console.error(`\ncanceling ${job.id}…`)
      await api.cancelJob(job.id).catch(() => { /* may already be done */ })
      process.exit(130)
    })
    let lastState = job.state
    while (!JOB_DONE.has(job.state)) {
      await new Promise((r) => setTimeout(r, 1000))
      job = (await api.getJob(job.id)).job
      if (job.state !== lastState) {
        console.log(`  ${job.state}`)
        lastState = job.state
      }
    }
    const { logs } = await api.jobLogs(job.id, 1000)
    if (logs.trim()) console.log('\n' + logs.trimEnd())
    if (job.state === 'succeeded') {
      console.log(`\n${job.id} succeeded in ${jobRuntime(job)}`)
    } else {
      console.error(`\n${job.id} ${job.state}${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}${job.error ? ` — ${job.error}` : ''}`)
    }
    process.exit(job.exitCode ?? (job.state === 'succeeded' ? 0 : 1))
  }))

program
  .command('jobs')
  .description('list jobs (newest first)')
  .action(action(async () => {
    const { jobs } = await api.listJobs()
    const header = ['ID', 'STATE', 'EXIT', 'RUNTIME', 'COMMAND', 'CREATED']
    const cols = jobs.map((j) => [
      j.id,
      j.state,
      j.exitCode == null ? '-' : String(j.exitCode),
      jobRuntime(j),
      (j.command.join(' ') || '(image default)').slice(0, 40),
      relativeTime(j.createdAt),
    ])
    const widths = header.map((h, i) => Math.max(h.length, ...cols.map((r) => r[i].length), 0))
    const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i] + 2)).join('').trimEnd()
    console.log(line(header))
    for (const r of cols) console.log(line(r))
  }))

const job = program.command('job').description('manage jobs')

job
  .command('logs <id>')
  .description('print job logs')
  .option('-n, --tail <n>', 'number of lines', '100')
  .action(action(async (id: string, opts: { tail: string }) => {
    const { logs } = await api.jobLogs(id, Number(opts.tail))
    console.log(logs)
  }))

job
  .command('cancel <id>')
  .description('cancel a queued/running job')
  .action(action(async (id: string) => {
    await api.cancelJob(id)
    console.log(`canceling ${id}`)
  }))

job
  .command('rm <id>')
  .description('remove a job (container + record)')
  .action(action(async (id: string) => {
    await api.removeJob(id)
    console.log(`removed ${id}`)
  }))

program
  .command('list')
  .description('list apps')
  .action(action(async () => {
    const [{ apps }, { proxyPort }] = await Promise.all([api.listApps(), api.health()])
    const rows = Object.values(apps) as AppRecord[]
    const header = ['NAME', 'TYPE', 'STATE', 'URL', 'LAST DEPLOY']
    const cols = rows.map((app) => [
      app.name,
      app.manifest.type,
      app.state,
      appUrl(app, proxyPort),
      relativeTime(app.deployedAt),
    ])
    const widths = header.map((h, i) => Math.max(h.length, ...cols.map((r) => r[i].length), 0))
    const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i] + 2)).join('').trimEnd()
    console.log(line(header))
    for (const r of cols) console.log(line(r))
  }))

program
  .command('systems')
  .description('list systems')
  .action(action(async () => {
    const { systems } = await api.listSystems()
    const rows = systems as SystemRecord[]
    const header = ['NAME', 'MEMBERS', 'WIRES', 'DEPLOYED']
    const cols = rows.map((sys) => [
      sys.name,
      sys.members.join(','),
      String(Object.keys(sys.wires).length),
      relativeTime(sys.deployedAt),
    ])
    const widths = header.map((h, i) => Math.max(h.length, ...cols.map((r) => r[i].length), 0))
    const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i] + 2)).join('').trimEnd()
    console.log(line(header))
    for (const r of cols) console.log(line(r))
  }))

program
  .command('logs [name]')
  .description('print app logs (or the daemon\'s own with --daemon); -f to follow')
  .option('-n, --tail <n>', 'number of lines', '100')
  .option('-f, --follow', 'stream new lines until interrupted')
  .option('--daemon', "the daemon's own log instead of an app's")
  .action(action(async (name: string | undefined, opts: { tail: string; follow?: boolean; daemon?: boolean }) => {
    const base = remotePeer ? remotePeer.url : `http://127.0.0.1:${DAEMON_PORT}`
    const token = remotePeer?.token
    const path = opts.daemon
      ? `/v1/logs?tail=${Number(opts.tail)}${opts.follow ? '&follow=1' : ''}`
      : (() => { if (!name) throw new Error('which app? (or use --daemon)'); return `/v1/apps/${name}/logs?tail=${Number(opts.tail)}${opts.follow ? '&follow=1' : ''}` })()
    if (!opts.follow && !opts.daemon && name) {
      const { logs } = await api.logs(name, Number(opts.tail))
      console.log(logs)
      return
    }
    // stream the plain-text response straight to stdout
    const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : undefined })
    if (!res.ok || !res.body) throw new Error(`logs failed: ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      process.stdout.write(dec.decode(value, { stream: true }))
    }
  }))

program
  .command('stop <name>')
  .description('stop an app')
  .action(action(async (name: string) => {
    await api.stop(name)
    console.log(`stopped ${name}`)
  }))

program
  .command('start <name>')
  .description('start an app')
  .action(action(async (name: string) => {
    await api.start(name)
    console.log(`started ${name}`)
  }))

program
  .command('rm <name>')
  .description('remove an app')
  .action(action(async (name: string) => {
    await api.removeApp(name)
    console.log(`removed ${name}`)
  }))

const secret = program.command('secret').description('manage app secrets')

secret
  .command('set <name> <pairs...>')
  .description('set one or more KEY=VALUE secrets')
  .action(action(async (name: string, pairs: string[]) => {
    const values: Record<string, string> = {}
    for (const pair of pairs) {
      const i = pair.indexOf('=')
      if (i <= 0) throw new Error(`malformed KEY=VALUE pair: "${pair}"`)
      const key = pair.slice(0, i)
      const value = pair.slice(i + 1)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid secret key: "${key}"`)
      values[key] = value
    }
    if (Object.keys(values).length === 0) throw new Error('no KEY=VALUE pairs given')
    await api.setSecrets(name, values)
    console.log(`set ${Object.keys(values).join(', ')} for ${name}`)
  }))

secret
  .command('ls <name>')
  .description('list secret keys')
  .action(action(async (name: string) => {
    const { keys } = await api.listSecretKeys(name)
    for (const k of keys) console.log(k)
  }))

program
  .command('url <name>')
  .description('print an app url')
  .action(action(async (name: string) => {
    const [{ app }, { proxyPort }] = await Promise.all([api.getApp(name), api.health()])
    console.log(appUrl(app, proxyPort))
    if (app.publicUrl) console.log(app.publicUrl)
  }))

program
  .command('expose <name>')
  .description('open a public https url (cloudflare quick tunnel)')
  .action(action(async (name: string) => {
    const { app } = await api.expose(name)
    console.log(`exposed ${app.name} -> ${app.publicUrl}`)
  }))

program
  .command('hide <name>')
  .description('close the public url')
  .action(action(async (name: string) => {
    await api.hide(name)
    console.log(`hidden ${name}`)
  }))

const system = program.command('system').description('manage systems')

system
  .command('rm <name>')
  .description('detach a system (removes the network + record, keeps member apps)')
  .action(action(async (name: string) => {
    await api.removeSystem(name)
    console.log(`detached system ${name} (apps kept)`)
  }))

program
  .command('play [seconds]')
  .description('play the rack: rhythmic healthchecks across running apps (hear them on the dashboard)')
  .action(action(async (seconds?: string) => {
    await api.play(Number(seconds ?? 45))
    console.log('playing — open the dashboard and turn the listen knob')
  }))

program
  .command('status')
  .description('daemon status')
  .action(action(async () => {
    const { status, node, apps, proxyPort } = await api.health()
    console.log(`daemon: ${status}${node ? ` — node "${node}"` : ''} — ${apps} app${apps === 1 ? '' : 's'}, proxy :${proxyPort}`)
  }))

const peerCmd = program.command('peer').description('manage cluster peers (other slab daemons)')

peerCmd
  .command('add <name> <url>')
  .description('register a peer daemon, e.g. slab peer add garage http://garage:7766')
  .option('--token <token>', "the peer's SLAB_TOKEN (needed for non-loopback peers)")
  .action(action(async (name: string, url: string, opts: { token?: string }) => {
    const { peer } = await api.setPeer(name, url, opts.token)
    console.log(`peer ${peer.name} -> ${peer.url}${peer.token ? ' (token set)' : ''}`)
  }))

peerCmd
  .command('ls')
  .description('list peers')
  .action(action(async () => {
    const { peers } = await api.listPeers()
    if (!peers.length) { console.log('no peers — add one: slab peer add <name> <url>'); return }
    for (const p of peers) console.log(`${p.name}\t${p.url}${p.token ? '\t(token)' : ''}`)
  }))

peerCmd
  .command('rm <name>')
  .description('unregister a peer (does not touch the peer daemon)')
  .action(action(async (name: string) => {
    await api.removePeer(name)
    console.log(`removed peer ${name}`)
  }))

// Restart the daemon this CLI belongs to: kill by pidfile (fallback: pkill),
// relaunch dist/daemon.js detached with output to ~/.slab/daemon.log, wait
// for health. Env (SLAB_DIR/SLAB_PORT/...) is inherited by the new daemon.
async function restartDaemon(): Promise<void> {
  const pidFile = path.join(slabDir(), 'daemon.pid')
  let killed = false
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim())
    if (pid > 1) { process.kill(pid); killed = true }
  } catch { /* no pidfile or already dead */ }
  if (!killed) {
    try { execSync("pkill -f 'dist/daemon.js'") } catch { /* none running */ }
  }
  await new Promise((r) => setTimeout(r, 800))
  const out = fs.openSync(path.join(slabDir(), 'daemon.log'), 'a')
  spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true,
    stdio: ['ignore', out, out],
  }).unref()
  for (let i = 0; i < 40; i++) {
    // always the LOCAL daemon — restart never applies to a --node target
    try { await client.health(); return } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  throw new Error(`daemon did not come back — check ${path.join(slabDir(), 'daemon.log')}`)
}

program
  .command('upgrade')
  .description('update slab in place: git pull, rebuild, restart the daemon (config survives)')
  .action(action(async () => {
    const root = path.resolve(__dirname, '..')
    if (!fs.existsSync(path.join(root, '.git'))) {
      throw new Error(`${root} is not a git checkout — re-run the installer instead`)
    }
    const run = (cmd: string) => execSync(cmd, { cwd: root, stdio: 'inherit' })
    console.log(`upgrading ${root}…`)
    run('git pull --ff-only')
    run('npm ci --silent --no-fund --no-audit')
    run('npm run build --silent')
    console.log('restarting daemon…')
    await restartDaemon()
    const sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
    const { node, apps } = await api.health()
    console.log(`upgraded to ${sha} — node "${node}" back up with ${apps} apps`)
  }))

const nodeCmd = program.command('node').description("this daemon's identity + network posture")

nodeCmd
  .command('name [name]', { isDefault: true })
  .description("print or set this node's name")
  .action(action(async (name?: string) => {
    if (name) {
      const { node } = await api.setNode(name)
      console.log(`node is now "${node}"`)
    } else {
      const { node } = await api.health()
      console.log(node ?? '(unnamed — set one with: slab node name <name>)')
    }
  }))

nodeCmd
  .command('open')
  .description('open this node to the network: bind 0.0.0.0 + auth token (persisted; restarts the daemon)')
  .option('--token <token>', 'use a specific token instead of keeping/generating one')
  .option('--rotate-token', 'generate a fresh token')
  .option('--advertise <host>', 'address other nodes dial for trunks (tailnet name or LAN IP)')
  .action(action(async (opts: { token?: string; rotateToken?: boolean; advertise?: string }) => {
    const cfg = loadNodeConfigFile()
    cfg.bind = '0.0.0.0'
    if (opts.token) cfg.token = opts.token
    else if (opts.rotateToken || !cfg.token) cfg.token = crypto.randomBytes(16).toString('hex')
    if (opts.advertise) cfg.advertise = opts.advertise
    saveNodeConfigFile(cfg)
    await restartDaemon()
    const host = os.hostname()
    console.log(`node open on the network (bind 0.0.0.0)`)
    console.log(`  dashboard: http://${host}:${DAEMON_PORT}/?token=${cfg.token}`)
    console.log(`  peer it:   slab peer add <name> http://${host}:${DAEMON_PORT} --token ${cfg.token}`)
    if (cfg.advertise) console.log(`  advertise: ${cfg.advertise}`)
  }))

nodeCmd
  .command('close')
  .description('back to loopback-only (persisted; restarts the daemon)')
  .action(action(async () => {
    const cfg = loadNodeConfigFile()
    cfg.bind = '127.0.0.1'
    saveNodeConfigFile(cfg)
    await restartDaemon()
    console.log('node closed — loopback only')
  }))

nodeCmd
  .command('token')
  .description('print the auth token (--rotate for a fresh one; restarts the daemon)')
  .option('--rotate', 'generate a fresh token')
  .action(action(async (opts: { rotate?: boolean }) => {
    const cfg = loadNodeConfigFile()
    if (opts.rotate) {
      cfg.token = crypto.randomBytes(16).toString('hex')
      saveNodeConfigFile(cfg)
      await restartDaemon()
      console.log(`rotated — new token: ${cfg.token}`)
      console.log('update peers that point here: slab peer add <name> <url> --token <new>')
    } else {
      console.log(cfg.token ?? '(no token set — slab node open creates one)')
    }
  }))

nodeCmd
  .command('advertise <host>')
  .description('set the address other nodes dial for trunks (persisted; restarts the daemon)')
  .action(action(async (host: string) => {
    const cfg = loadNodeConfigFile()
    cfg.advertise = host
    saveNodeConfigFile(cfg)
    await restartDaemon()
    console.log(`advertise -> ${host}`)
  }))

program
  .command('daemon')
  .description('run the slab daemon in-process')
  .action(action(async () => {
    await import('./daemon.js')
  }))

program
  .command('feedback [words...]')
  .description('30 seconds, means a lot — opens a prefilled github issue')
  .action(action(async (words: string[]) => {
    const title = words.join(' ').slice(0, 120)
    let version = 'unknown'
    try { version = execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '..') }).toString().trim() } catch { /* not a git install */ }
    const body = [
      title ? '' : '<!-- what happened, what you expected -->',
      '',
      '---',
      `slab ${version} · ${os.platform()}/${os.arch()} · node ${process.version}`,
    ].join('\n')
    const url = `https://github.com/runslab/slab/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
    const opener = os.platform() === 'darwin' ? 'open' : 'xdg-open'
    try { execSync(`${opener} ${JSON.stringify(url)}`, { stdio: 'ignore' }) } catch { /* headless — the url below still works */ }
    console.log('opening a prefilled issue — or paste this url:')
    console.log(url)
  }))

program
  .command('init')
  .description('scaffold a slab.toml in the current directory')
  .action(action(async () => {
    const dir = process.cwd()
    const file = path.join(dir, 'slab.toml')
    if (fs.existsSync(file)) throw new Error(`slab.toml already exists in ${dir}`)
    const name = sanitizeName(path.basename(dir))
    const toml = `name = "${name}"\ntype = "service"\nport = 3000\n`
    fs.writeFileSync(file, toml)
    console.log(`wrote ${file}`)
    console.log('edit: name, type (service|function), port, and add a Dockerfile (or set image = "...")')
  }))

program.parseAsync(process.argv).catch(fail)
