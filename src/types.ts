// slab — core contracts. Every other module codes against this file.

export type AppType = 'service' | 'function'
export type AppState = 'created' | 'building' | 'running' | 'sleeping' | 'stopped' | 'error'

// Parsed from slab.toml in the app's source directory
export interface Manifest {
  name: string
  type: AppType
  port: number              // port the app listens on INSIDE the container
  image?: string            // prebuilt image (e.g. "nginx:alpine") — pull & run, no build.
                            // Omit to build from the Dockerfile in the source dir.
  postgres?: boolean        // true -> slab provisions a DB and injects DATABASE_URL
  secrets?: string[]        // env var names the app expects (values set via `slab secret set`)
  idle_timeout?: string     // functions only, e.g. "5m" (default "5m")
  env?: Record<string, string>  // static, non-secret env vars
}

// Persisted in ~/.slab/state.json
export interface AppRecord {
  name: string
  sourceDir: string         // absolute path to the app source (contains Dockerfile + slab.toml)
  gitUrl: string | null     // when set, sourceDir is a slab-managed checkout; pulled on each deploy
  manifest: Manifest
  hostPort: number | null   // allocated host port (20000+), null until first deploy
  containerId: string | null
  imageTag: string | null   // slab/<name>:<version>
  version: number           // increments per deploy
  state: AppState
  lastRequestAt: string | null  // ISO — updated by proxy, used by idle reaper
  createdAt: string
  deployedAt: string | null
  error: string | null      // last error message when state === 'error'
  exposed: boolean          // user asked for a public tunnel (re-opened on daemon boot)
  publicUrl: string | null  // current trycloudflare.com URL (changes per tunnel session)
}

export interface SlabState {
  apps: Record<string, AppRecord>
  nextHostPort: number      // starts at 20000
}

// ── Daemon HTTP API (localhost:7766) ──────────────────────────────────────────
// All request/response bodies are JSON. Errors: { error: string } with 4xx/5xx.
//
//   GET    /v1/apps                      -> { apps: AppRecord[] }
//   POST   /v1/apps                      -> body { sourceDir } OR { gitUrl } ; git sources are
//                                           cloned to ~/.slab/repos and pulled on each deploy.
//                                           Reads slab.toml, creates record -> { app: AppRecord }
//   GET    /v1/apps/:name                -> { app: AppRecord }
//   DELETE /v1/apps/:name                -> stops container, removes record -> 204
//   POST   /v1/apps/:name/deploy        -> build + (re)start container -> { app: AppRecord }
//   POST   /v1/apps/:name/stop          -> stop container -> { app: AppRecord }
//   POST   /v1/apps/:name/start         -> start existing container -> { app: AppRecord }
//   GET    /v1/apps/:name/logs?tail=100 -> { logs: string }
//   PUT    /v1/apps/:name/secrets       -> body { values: Record<string,string> } (merge) -> 204
//   GET    /v1/apps/:name/secrets       -> { keys: string[] }  (names only, never values)
//   POST   /v1/apps/:name/expose        -> open Cloudflare quick tunnel -> { app } (publicUrl set)
//   POST   /v1/apps/:name/hide          -> close tunnel -> { app }
//   GET    /v1/health                   -> { status: 'ok', apps: number, proxyPort: number }
//
// The ingress proxy listens on PROXY_PORT (default 8080) and routes by Host
// header: <app>.localhost -> app's hostPort. For sleeping functions it starts
// the container first (wake-on-request), then forwards.

export const DAEMON_PORT = 7766
export const PROXY_PORT = 8080
export const HOST_PORT_BASE = 20000

// ── Engine interface (implemented in engine.ts with dockerode) ───────────────
export interface Engine {
  // If manifest.image is set: docker pull it and return it as the tag.
  // Otherwise: docker build the app's sourceDir, tag slab/<name>:<version>.
  buildImage(app: AppRecord): Promise<string>
  // Start a container for the app: labels {'slab.app': name}, port mapping
  // hostPort->manifest.port, env = secrets + static env + DATABASE_URL (if postgres).
  // Stops/removes any previous container for this app first. Returns containerId.
  runContainer(app: AppRecord, imageTag: string, env: Record<string, string>): Promise<string>
  stopContainer(app: AppRecord): Promise<void>       // stop, keep container (functions sleep this way)
  startContainer(app: AppRecord): Promise<void>      // docker start existing container
  removeContainer(app: AppRecord): Promise<void>     // stop + rm
  getLogs(app: AppRecord, tail: number): Promise<string>
  // True if the app's container is currently running (queried live from docker by label)
  isRunning(app: AppRecord): Promise<boolean>
  // Ensure the shared postgres container (slab-postgres, postgres:16-alpine,
  // volume slab-pgdata, host port 20432) is up, and that a database named
  // slab_<app> exists. Returns the DATABASE_URL to inject.
  ensurePostgres(appName: string): Promise<string>
}
