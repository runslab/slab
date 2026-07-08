// Thin HTTP client for the slab daemon — shared by the CLI, the MCP server,
// and daemon-to-daemon (peer) calls.
import { AppRecord, DAEMON_PORT, JobRecord, PeerRecord, SystemRecord, TrunkConfig } from './types'

const BASE = process.env.SLAB_DAEMON_URL ?? `http://127.0.0.1:${DAEMON_PORT}`

// Build a client bound to a daemon URL (+ its SLAB_TOKEN for non-loopback
// calls). timeoutMs bounds each request — used for peer fan-out so one dead
// node can't stall a fleet view; omit for normal ops (deploys take minutes).
export function clientFor(base: string, token?: string, timeoutMs?: number) {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    const headers: Record<string, string> = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (token) headers['Authorization'] = `Bearer ${token}`
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      })
    } catch {
      throw new Error(`slab daemon not reachable at ${base} — start it with: slab daemon`)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${text.slice(0, 200)}`
      throw new Error(msg)
    }
    return data as T
  }

  return {
    health: () => req<{ status: string; node?: string; apps: number; proxyPort: number }>('GET', '/v1/health'),
    setNode: (name: string) => req<{ node: string }>('PUT', '/v1/node', { name }),
    listApps: () => req<{ apps: AppRecord[] }>('GET', '/v1/apps'),
    createApp: (source: { sourceDir?: string; gitUrl?: string }) => req<{ app: AppRecord }>('POST', '/v1/apps', source),
    getApp: (name: string) => req<{ app: AppRecord }>('GET', `/v1/apps/${name}`),
    removeApp: (name: string) => req<void>('DELETE', `/v1/apps/${name}`),
    deploy: (name: string) => req<{ app: AppRecord }>('POST', `/v1/apps/${name}/deploy`),
    stop: (name: string) => req<{ app: AppRecord }>('POST', `/v1/apps/${name}/stop`),
    start: (name: string) => req<{ app: AppRecord }>('POST', `/v1/apps/${name}/start`),
    logs: (name: string, tail = 100) => req<{ logs: string }>('GET', `/v1/apps/${name}/logs?tail=${tail}`),
    setSecrets: (name: string, values: Record<string, string>) => req<void>('PUT', `/v1/apps/${name}/secrets`, { values }),
    listSecretKeys: (name: string) => req<{ keys: string[] }>('GET', `/v1/apps/${name}/secrets`),
    expose: (name: string) => req<{ app: AppRecord }>('POST', `/v1/apps/${name}/expose`),
    hide: (name: string) => req<{ app: AppRecord }>('POST', `/v1/apps/${name}/hide`),
    listJobs: () => req<{ jobs: JobRecord[] }>('GET', '/v1/jobs'),
    createJob: (spec: {
      sourceDir?: string; gitUrl?: string; image?: string
      command?: string[]; env?: Record<string, string>; name?: string; timeout?: string
    }) => req<{ job: JobRecord }>('POST', '/v1/jobs', spec),
    getJob: (id: string) => req<{ job: JobRecord }>('GET', `/v1/jobs/${id}`),
    jobLogs: (id: string, tail = 100) => req<{ logs: string }>('GET', `/v1/jobs/${id}/logs?tail=${tail}`),
    cancelJob: (id: string) => req<{ job: JobRecord }>('POST', `/v1/jobs/${id}/cancel`),
    removeJob: (id: string) => req<void>('DELETE', `/v1/jobs/${id}`),
    play: (seconds: number) => req<{ playing: boolean; seconds: number }>('POST', '/v1/play', { seconds }),
    listSystems: () => req<{ systems: SystemRecord[] }>('GET', '/v1/systems'),
    createSystem: (sourceFile: string) => req<{ system: SystemRecord }>('POST', '/v1/systems', { sourceFile }),
    deploySystem: (name: string) => req<{ system: SystemRecord; apps: AppRecord[] }>('POST', `/v1/systems/${name}/deploy`),
    removeSystem: (name: string) => req<void>('DELETE', `/v1/systems/${name}`),
    listPeers: () => req<{ peers: PeerRecord[] }>('GET', '/v1/peers'),
    setPeer: (name: string, url: string, peerToken?: string) =>
      req<{ peer: PeerRecord }>('PUT', `/v1/peers/${name}`, { url, token: peerToken }),
    removePeer: (name: string) => req<void>('DELETE', `/v1/peers/${name}`),
    // node-to-node (used by the daemon itself)
    adoptSystem: (body: {
      name: string; origin: string
      members: Record<string, { source: string }>
      wires: Record<string, string>
      memberNodes: Record<string, string>
    }) => req<{ trunkPort: number; members: Array<{ name: string; port: number }> }>('POST', '/v1/systems/adopt', body),
    trunkSync: (name: string, cfg: TrunkConfig) =>
      req<{ trunk: string }>('POST', `/v1/systems/${name}/trunk-sync`, cfg),
  }
}

export const client = clientFor(BASE)

export function appUrl(app: AppRecord, proxyPort: number): string {
  return `http://${app.name}.localhost:${proxyPort}`
}
