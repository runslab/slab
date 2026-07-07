#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { Command } from 'commander'
import { client, appUrl } from './api-client'
import { loadManifest } from './manifest'
import { looksLikeGitUrl } from './git'
import { AppRecord } from './types'

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
    await client.getApp(manifest.name)
  } catch {
    await client.createApp({ sourceDir })
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

const program = new Command()
program.name('slab').description('tiny local paas').version('1.0.0')

program
  .command('create [source]')
  .description('create an app from a source dir or git url')
  .action(action(async (source?: string) => {
    const arg = source ?? process.cwd()
    const { app } = looksLikeGitUrl(arg) && !isDir(path.resolve(arg))
      ? await client.createApp({ gitUrl: arg })
      : await client.createApp({ sourceDir: path.resolve(arg) })
    const { proxyPort } = await client.health()
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
      const { app } = await client.createApp({ gitUrl: arg }).catch(async (e: Error) => {
        // 409 = already registered; find it by checkout name convention
        if (!/exists/.test(e.message)) throw e
        const m = /app "([^"]+)"/.exec(e.message)
        return client.getApp(m ? m[1] : arg)
      })
      name = app.name
    } else {
      name = isDir(asDir) ? await ensureApp(asDir) : arg
    }
    const { app } = await client.deploy(name)
    if (app.state === 'running') {
      const { proxyPort } = await client.health()
      console.log(`deployed ${app.name} -> ${appUrl(app, proxyPort)} (v${app.version})`)
    } else {
      console.log(`${app.name}: ${app.state}${app.error ? ` — ${app.error}` : ''}`)
    }
  }))

program
  .command('list')
  .description('list apps')
  .action(action(async () => {
    const [{ apps }, { proxyPort }] = await Promise.all([client.listApps(), client.health()])
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
  .command('logs <name>')
  .description('print app logs')
  .option('-n, --tail <n>', 'number of lines', '100')
  .action(action(async (name: string, opts: { tail: string }) => {
    const { logs } = await client.logs(name, Number(opts.tail))
    console.log(logs)
  }))

program
  .command('stop <name>')
  .description('stop an app')
  .action(action(async (name: string) => {
    await client.stop(name)
    console.log(`stopped ${name}`)
  }))

program
  .command('start <name>')
  .description('start an app')
  .action(action(async (name: string) => {
    await client.start(name)
    console.log(`started ${name}`)
  }))

program
  .command('rm <name>')
  .description('remove an app')
  .action(action(async (name: string) => {
    await client.removeApp(name)
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
    await client.setSecrets(name, values)
    console.log(`set ${Object.keys(values).join(', ')} for ${name}`)
  }))

secret
  .command('ls <name>')
  .description('list secret keys')
  .action(action(async (name: string) => {
    const { keys } = await client.listSecretKeys(name)
    for (const k of keys) console.log(k)
  }))

program
  .command('url <name>')
  .description('print an app url')
  .action(action(async (name: string) => {
    const [{ app }, { proxyPort }] = await Promise.all([client.getApp(name), client.health()])
    console.log(appUrl(app, proxyPort))
    if (app.publicUrl) console.log(app.publicUrl)
  }))

program
  .command('expose <name>')
  .description('open a public https url (cloudflare quick tunnel)')
  .action(action(async (name: string) => {
    const { app } = await client.expose(name)
    console.log(`exposed ${app.name} -> ${app.publicUrl}`)
  }))

program
  .command('hide <name>')
  .description('close the public url')
  .action(action(async (name: string) => {
    await client.hide(name)
    console.log(`hidden ${name}`)
  }))

program
  .command('status')
  .description('daemon status')
  .action(action(async () => {
    const { status, apps, proxyPort } = await client.health()
    console.log(`daemon: ${status} — ${apps} app${apps === 1 ? '' : 's'}, proxy :${proxyPort}`)
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
