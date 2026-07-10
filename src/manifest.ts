import fs from 'fs'
import path from 'path'
import { parse } from 'smol-toml'
import { Manifest } from './types'

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/

export function loadManifest(sourceDir: string): Manifest {
  const file = path.join(sourceDir, 'slab.toml')
  if (!fs.existsSync(file)) {
    return inferManifest(sourceDir)
  }
  const raw = parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>

  const name = String(raw.name ?? '')
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid app name "${name}" — lowercase letters, digits, hyphens, 2-31 chars`)
  }
  const type = raw.type === 'function' ? 'function' : 'service'
  const port = Number(raw.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${raw.port}" in slab.toml`)
  }
  const image = raw.image != null ? String(raw.image) : undefined
  let dockerfile = raw.dockerfile != null ? String(raw.dockerfile) : undefined
  if (!image) {
    if (dockerfile) {
      if (!fs.existsSync(path.join(sourceDir, dockerfile))) {
        throw new Error(`slab.toml points at dockerfile "${dockerfile}" but ${sourceDir}/${dockerfile} does not exist`)
      }
    } else {
      const found = findDockerfile(sourceDir)
      if (!found) throw new Error(`${sourceDir} has neither an "image" in slab.toml nor a Dockerfile`)
      const rel = path.relative(sourceDir, found)
      dockerfile = rel === 'Dockerfile' ? undefined : rel
    }
  }

  return {
    name,
    type,
    target: raw.target != null ? String(raw.target) : undefined,
    port,
    public: raw.public !== false,
    image,
    dockerfile,
    postgres: raw.postgres === true,
    secrets: Array.isArray(raw.secrets) ? raw.secrets.map(String) : [],
    volumes: Array.isArray(raw.volumes) ? raw.volumes.map(v => parseVolume(String(v))) : [],
    idle_timeout: raw.idle_timeout != null ? String(raw.idle_timeout) : '5m',
    env: typeof raw.env === 'object' && raw.env !== null
      ? Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {},
  }
}

// "pgdata:/var/lib/postgresql/data" — named volumes only, no host-path binds
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

function parseVolume(entry: string): string {
  const i = entry.indexOf(':')
  const name = i === -1 ? '' : entry.slice(0, i)
  const target = i === -1 ? '' : entry.slice(i + 1)
  if (!VOLUME_NAME_RE.test(name) || !target.startsWith('/')) {
    throw new Error(`Invalid volume "${entry}" — expected "name:/container/path" (named volumes only, no host paths)`)
  }
  return entry
}

function sanitizeName(raw: string): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(name)) name = `app-${name}`
  name = name.slice(0, 31)
  while (name.length < 2) name += '0'
  return NAME_RE.test(name) ? name : 'app'
}

// No slab.toml? Any repo with a Dockerfile can still run: name from the
// directory (for git sources that's the repo name), type service, port from
// the Dockerfile's first EXPOSE (default 3000). PORT is injected so apps
// that read it listen where slab expects. The Dockerfile doesn't have to be
// at the root — findDockerfile searches (memos keeps it in scripts/, plenty
// of repos use docker/); the build context is always the repo root, which is
// the convention subdirectory Dockerfiles are written for.
const DOCKERFILE_SEARCH_DEPTH = 3
const IGNORED_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build_output'])

export function findDockerfile(sourceDir: string): string | null {
  const candidates: string[] = []
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isFile() && /^Dockerfile/.test(e.name)) candidates.push(path.join(dir, e.name))
      else if (e.isDirectory() && depth < DOCKERFILE_SEARCH_DEPTH && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), depth + 1)
      }
    }
  }
  walk(sourceDir, 0)
  if (candidates.length === 0) return null
  // exact "Dockerfile" beats variants (Dockerfile.dev …); shallower beats deeper
  const exact = candidates.filter((c) => path.basename(c) === 'Dockerfile')
  const pool = exact.length > 0 ? exact : candidates
  pool.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
  if (exact.length !== 1 && pool.length > 1) {
    const shallowest = pool[0].split(path.sep).length
    const tied = pool.filter((c) => c.split(path.sep).length === shallowest)
    if (tied.length > 1) {
      const rels = tied.map((c) => path.relative(sourceDir, c)).join(', ')
      throw new Error(`Found several Dockerfiles (${rels}) — add a slab.toml to choose, or keep one`)
    }
  }
  return pool[0]
}

function inferManifest(sourceDir: string): Manifest {
  const dockerfile = findDockerfile(sourceDir)
  if (!dockerfile) {
    throw new Error(`No slab.toml found in ${sourceDir} — and no Dockerfile to infer an app from. Add a slab.toml (slab init) or a Dockerfile.`)
  }
  const expose = /^\s*EXPOSE\s+(\d+)/im.exec(fs.readFileSync(dockerfile, 'utf-8'))
  const port = expose ? Number(expose[1]) : 3000
  const rel = path.relative(sourceDir, dockerfile)
  return {
    name: sanitizeName(path.basename(sourceDir)),
    type: 'service',
    port,
    public: true,
    image: undefined,
    dockerfile: rel === 'Dockerfile' ? undefined : rel,
    postgres: false,
    secrets: [],
    idle_timeout: '5m',
    env: { PORT: String(port) },
  }
}

// "5m" | "30s" | "1h" -> milliseconds
export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s.trim())
  if (!m) return 5 * 60 * 1000
  const n = Number(m[1])
  return m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000
}

// ── system.toml ───────────────────────────────────────────────────────────────
import { SystemManifest } from './types'

export function loadSystemManifest(file: string): SystemManifest {
  if (!fs.existsSync(file)) throw new Error(`No system manifest at ${file}`)
  const raw = parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
  return parseSystemManifest(raw)
}

// Shared by file loads and the inline-manifest API (POST /v1/systems with
// { manifest } — how the dashboard and agents create systems without files).
export function parseSystemManifest(raw: Record<string, unknown>): SystemManifest {
  const name = String(raw.name ?? '')
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid system name "${name}" — lowercase letters, digits, hyphens, 2-31 chars`)
  }
  const rawApps = (raw.apps ?? {}) as Record<string, { source?: unknown; node?: unknown }>
  const members: SystemManifest['members'] = {}
  for (const [app, cfg] of Object.entries(rawApps)) {
    if (!NAME_RE.test(app)) throw new Error(`Invalid member app name "${app}"`)
    const source = String(cfg?.source ?? '')
    if (!source) throw new Error(`Member "${app}" is missing source`)
    const node = cfg?.node != null ? String(cfg.node) : undefined
    if (node !== undefined && !NAME_RE.test(node)) throw new Error(`Member "${app}" has invalid node "${node}"`)
    members[app] = node ? { source, node } : { source }
  }
  if (Object.keys(members).length === 0) throw new Error('System has no [apps.<name>] members')
  const rawWires = (raw.wires ?? {}) as Record<string, unknown>
  const wires: Record<string, string> = {}
  // TOML nuance: unquoted `app.KEY = v` parses as a nested table, quoted
  // `"app.KEY" = v` as a flat dotted key. Accept both shapes.
  const flat: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(rawWires)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [sub, sv] of Object.entries(v as Record<string, unknown>)) flat.push([`${k}.${sub}`, sv])
    } else {
      flat.push([k, v])
    }
  }
  for (const [k, v] of flat) {
    const m = /^([a-z][a-z0-9-]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(k)
    if (!m) throw new Error(`Invalid wire key "${k}" — expected <app>.<ENV_KEY>`)
    if (!members[m[1]]) throw new Error(`Wire "${k}" targets "${m[1]}", which is not a member`)
    wires[k] = String(v)
  }
  return { name, members, wires }
}

// Render a manifest back to TOML — inline-created systems get a real file
// under ~/.slab/systems/ so the CLI/file/git workflows stay symmetrical.
export function systemManifestToToml(m: SystemManifest): string {
  const lines: string[] = [`name = ${JSON.stringify(m.name)}`, '']
  for (const [app, cfg] of Object.entries(m.members)) {
    lines.push(`[apps.${app}]`)
    lines.push(`source = ${JSON.stringify(cfg.source)}`)
    if (cfg.node) lines.push(`node = ${JSON.stringify(cfg.node)}`)
    lines.push('')
  }
  if (Object.keys(m.wires).length) {
    lines.push('[wires]')
    for (const [k, v] of Object.entries(m.wires)) {
      lines.push(`${JSON.stringify(k)} = ${JSON.stringify(v)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
