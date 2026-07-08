import fs from 'fs'
import path from 'path'
import os from 'os'
import { SlabState, AppRecord, HOST_PORT_BASE } from './types'

const SLAB_DIR = process.env.SLAB_DIR ?? path.join(os.homedir(), '.slab')

export function slabDir(): string {
  return SLAB_DIR
}

// ── Node config: persisted network identity (~/.slab/node.json, chmod 600).
// Written by `slab node open/close/token`; env vars override at boot so
// one-off runs stay possible. ─────────────────────────────────────────────
export interface NodeConfig {
  bind?: string        // '127.0.0.1' (default) or '0.0.0.0' (cluster/open)
  advertise?: string   // address other nodes dial for trunks
  token?: string       // SLAB_TOKEN for non-loopback callers
}

const NODE_CONFIG_FILE = path.join(SLAB_DIR, 'node.json')

export function loadNodeConfigFile(): NodeConfig {
  try {
    return JSON.parse(fs.readFileSync(NODE_CONFIG_FILE, 'utf-8')) as NodeConfig
  } catch {
    return {}
  }
}

export function saveNodeConfigFile(cfg: NodeConfig): void {
  ensureDirs()
  fs.writeFileSync(NODE_CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

// Effective config: env wins, then node.json, then defaults.
export function effectiveNodeConfig(): Required<Pick<NodeConfig, 'bind' | 'advertise'>> & { token?: string } {
  const file = loadNodeConfigFile()
  return {
    bind: process.env.SLAB_BIND ?? file.bind ?? '127.0.0.1',
    advertise: process.env.SLAB_ADVERTISE ?? file.advertise ?? '127.0.0.1',
    token: process.env.SLAB_TOKEN ?? file.token,
  }
}
const STATE_FILE = path.join(SLAB_DIR, 'state.json')
const SECRETS_DIR = path.join(SLAB_DIR, 'secrets')

function ensureDirs() {
  fs.mkdirSync(SLAB_DIR, { recursive: true })
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 })
}

export function loadState(): SlabState {
  ensureDirs()
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as SlabState
  } catch {
    return { apps: {}, nextHostPort: HOST_PORT_BASE }
  }
}

export function saveState(state: SlabState): void {
  ensureDirs()
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

export function allocateHostPort(state: SlabState): number {
  const port = state.nextHostPort
  state.nextHostPort += 1
  return port
}

export function getApp(state: SlabState, name: string): AppRecord | null {
  return state.apps[name] ?? null
}

// ── Secrets: one JSON file per app, chmod 600. Plaintext for v0 (local, single
// user); encryption is a fast follow before any multi-machine story. ─────────

function secretsFile(appName: string): string {
  return path.join(SECRETS_DIR, `${appName}.json`)
}

export function getSecrets(appName: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(appName), 'utf-8'))
  } catch {
    return {}
  }
}

export function setSecrets(appName: string, values: Record<string, string>): void {
  ensureDirs()
  const merged = { ...getSecrets(appName), ...values }
  fs.writeFileSync(secretsFile(appName), JSON.stringify(merged, null, 2), { mode: 0o600 })
}

export function deleteSecrets(appName: string): void {
  try { fs.unlinkSync(secretsFile(appName)) } catch { /* ignore */ }
}
