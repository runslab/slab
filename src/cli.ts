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

// Commands that touch THIS machine (files, daemon process) — meaningless remotely.
const LOCAL_ONLY = new Set(['upgrade', 'open', 'close', 'token', 'advertise', 'daemon', 'init'])

const program = new Command()
program.name('slab').description('tiny local paas').version('1.0.0')
program.option('-N, --node <name>', 'target a peer node instead of the local daemon (see: slab peer ls)')

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const target = program.opts().node as string | undefined
  if (!target) return
  if (LOCAL_ONLY.has(actionCommand.name())) {
    fail(new Error(`"slab ${actionCommand.name()}" runs on the machine itself — ssh to ${target} for that`))
  }
  try {
    const [{ node }, { peers }] = await Promise.all([client.health(), client.listPeers()])
    if (target === node) return   // targeting ourselves — stay local
    const peer = peers.find((p) => p.name === target)
    if (!peer) {
      const known = [node ? `${node} (local)` : null, ...peers.map((p) => p.name)].filter(Boolean).join(', ')
      throw new Error(`unknown node "${target}" — known nodes: ${known || 'none'}. Register with: slab peer add ${target} <url> --token <t>`)
    }
    api = clientFor(peer.url, peer.token)
  } catch (err) {
    fail(err)
  }
})

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

program
  .command('deploy [source]')
  .description('deploy an app (builds + starts) from a dir, git url, or app name')
  .action(action(async (dirOrName?: string) => {
    const arg = dirOrName ?? process.cwd()
    const asDir = path.resolve(arg)
    let name: string
    if (looksLikeGitUrl(arg) && !isDir(asDir)) {
      const { app } = await api.createApp({ gitUrl: arg }).catch(async (e: Error) => {
        // 409 = already registered; find it by checkout name convention
        if (!/exists/.test(e.message)) throw e
        const m = /app "([^"]+)"/.exec(e.message)
        return api.getApp(m ? m[1] : arg)
      })
      name = app.name
    } else {
      name = isDir(asDir) ? await ensureApp(asDir) : arg
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
  .action(action(async (source: string | undefined, cmd: string[], opts: { image?: string; env: string[]; timeout: string; detach?: boolean; name?: string }) => {
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
  .command('logs <name>')
  .description('print app logs')
  .option('-n, --tail <n>', 'number of lines', '100')
  .action(action(async (name: string, opts: { tail: string }) => {
    const { logs } = await api.logs(name, Number(opts.tail))
    console.log(logs)
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
