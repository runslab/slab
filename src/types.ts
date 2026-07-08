// slab — core contracts. Every other module codes against this file.

export type AppType = 'service' | 'function'
export type AppState = 'created' | 'building' | 'running' | 'sleeping' | 'stopped' | 'error'

// Parsed from slab.toml in the app's source directory
export interface Manifest {
  name: string
  type: AppType
  port: number              // port the app listens on INSIDE the container
  public?: boolean          // default true. false -> no host port, no ingress:
                            // reachable ONLY by system-mates (docs/design/systems.md)
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
  systems?: Record<string, SystemRecord>   // optional for state-file back-compat
  jobs?: Record<string, JobRecord>         // optional for state-file back-compat
  nodeName?: string         // this daemon's identity (defaults to the hostname);
                            // groundwork for multi-node: many named slabs, one view
  peers?: Record<string, PeerRecord>   // other slab daemons (optional for back-compat)
  nextHostPort: number      // starts at 20000
}

// ── Trunks: the slab network layer between nodes (docs/design/trunks.md) ─────
// A system that spans nodes gets ONE trunk container per involved node:
// joined to that node's slab-net-<system> bridge with a DNS alias for every
// REMOTE member, so http://<member>:<port> keeps working unchanged. The trunk
// tunnels the TCP stream (one-line token+member preamble) to the target
// node's trunk, which hands it to the real container. Members never know.
export interface TrunkConfig {
  token: string                                        // preamble shared secret
  ingressPort: number                                  // in-container listener for inbound tunnels
  local: Record<string, { port: number }>              // members on this node
  remote: Record<string, { port: number; node: string }>  // members elsewhere (alias + egress listener each)
  peers: Record<string, { host: string; port: number }>   // node -> trunk ingress host:port
}

// ── Jobs: run-to-completion workloads (`slab run`) ────────────────────────────
// A job is the third thing slab runs beside services and functions: build (or
// pull) an image, run one command, capture the exit code, keep the logs. No
// ports, no ingress, no restart policy. Two source modes:
//   - Dockerfile mode: sourceDir has a Dockerfile — build it, run `command`
//     (or the image's default CMD when command is empty).
//   - image mode: `image` is set — pull it and bind-mount sourceDir at
//     /workspace (the sandbox / coding-agent story: stock toolchain image,
//     your working tree mounted in).
export type JobState = 'queued' | 'building' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface JobRecord {
  id: string                 // <name>-<base36 suffix>, unique across job history
  name: string               // derived from source dir basename unless overridden
  sourceDir: string | null   // absolute path (null only when image mode runs bare)
  gitUrl: string | null      // when set, sourceDir is a slab-managed checkout
  image: string | null       // stock image to run (image mode); null = Dockerfile mode
  command: string[]          // container command; [] = image default CMD
  env: Record<string, string>
  timeout: string            // duration ("30s" | "5m" | "1h"); enforced by the daemon
  state: JobState
  exitCode: number | null    // set when the container exits
  containerId: string | null
  error: string | null       // build failure / timeout / interruption message
  createdAt: string
  startedAt: string | null   // container start (after build)
  finishedAt: string | null
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
//   GET    /v1/health                   -> { status: 'ok', node: string, apps: number, proxyPort: number }
//   PUT    /v1/node                     -> body { name } ; rename this daemon node -> { node }
//
//   GET    /v1/fleet                    -> { nodes: [{ name, self, reachable, url, proxyPort,
//                                           apps, systems, error }] } — this node + every peer
//                                           (bounded fan-out; dead peers degrade, never fail)
//   GET    /v1/peers                    -> { peers: PeerRecord[] }
//   PUT    /v1/peers/:name              -> body { url, token? } ; register/update a peer -> { peer }
//   DELETE /v1/peers/:name              -> 204
//   POST   /v1/systems/adopt            -> (node-to-node) body { name, origin, members, wires,
//                                           memberNodes } ; peer creates+deploys ITS members,
//                                           allocates a trunk port -> { trunkPort, members }
//   POST   /v1/systems/:name/trunk-sync -> (node-to-node) body TrunkConfig ; (re)start this
//                                           node's trunk container -> { trunk: containerId }
//
//   GET    /v1/jobs                     -> { jobs: JobRecord[] } (newest first)
//   POST   /v1/jobs                     -> body { sourceDir? | gitUrl?, image?, command?: string[],
//                                           env?, name?, timeout? } ; starts the job async -> 201 { job }
//   GET    /v1/jobs/:id                 -> { job }
//   GET    /v1/jobs/:id/logs?tail=100   -> { logs }
//   POST   /v1/jobs/:id/cancel          -> stop the container -> { job } (state: canceled)
//   DELETE /v1/jobs/:id                 -> remove container + record -> 204
//
// The ingress proxy listens on PROXY_PORT (default 8080) and routes by Host
// header: <app>.localhost -> app's hostPort. For sleeping functions it starts
// the container first (wake-on-request), then forwards.

// Env-configurable so several daemons ("nodes") can coexist — even on one
// machine (pair with SLAB_DIR for separate state). Defaults match v0.
// Bind/advertise/token live in ~/.slab/node.json (managed by `slab node
// open|close|token`, env-overridable) — see NodeConfig in state.ts.
export const DAEMON_PORT = Number(process.env.SLAB_PORT ?? 7766)
export const PROXY_PORT = Number(process.env.SLAB_PROXY_PORT ?? 8080)
export const HOST_PORT_BASE = 20000

// ── Engine interface (implemented in engine.ts with dockerode) ───────────────
export interface Engine {
  // If manifest.image is set: docker pull it and return it as the tag.
  // Otherwise: docker build the app's sourceDir, tag slab/<name>:<version>.
  buildImage(app: AppRecord): Promise<string>
  // Start a container for the app: labels {'slab.app': name}, env injected.
  // opts.publish=false -> NO port binding (private member, network-only).
  // opts.networks: slab system networks to join (alias = app name), joined
  // after start. Stops/removes any previous container first. Returns id.
  runContainer(app: AppRecord, imageTag: string, env: Record<string, string>, opts?: { publish?: boolean; networks?: string[] }): Promise<string>
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
  // ── system network layer ──
  ensureNetwork(name: string): Promise<void>                     // create if missing (slab-net-<system>)
  removeNetwork(name: string): Promise<void>                     // tolerate missing/in-use errors by throwing clear messages
  connectNetworks(app: AppRecord, networks: string[]): Promise<void>  // connect container to each with alias = app.name; tolerate already-connected
  // ── job layer ──
  // image mode: pull job.image. Dockerfile mode: build sourceDir, tag slab-job/<name>:<id-suffix>.
  buildJobImage(job: JobRecord): Promise<string>
  // Create + start the job container: label {'slab.job': id}, no ports, no
  // restart policy; image mode bind-mounts sourceDir at /workspace (rw) and
  // sets it as the workdir. Returns container id.
  runJob(job: JobRecord, imageTag: string): Promise<string>
  waitJob(containerId: string): Promise<number>   // docker wait -> exit code
  getJobLogs(job: JobRecord, tail: number): Promise<string>
  stopJob(job: JobRecord): Promise<void>          // stop, keep container (logs stay readable)
  removeJob(job: JobRecord): Promise<void>        // stop + rm the job container
  // ── trunk layer ──
  // Run (replacing any previous) the system's trunk container: node:22-alpine,
  // mounted script, TRUNK_CONFIG env, ingress published on hostPort (all
  // interfaces — the preamble token is the auth), joined to `network` with
  // aliases = the remote member names. 127.0.0.1 peer hosts are rewritten to
  // host.docker.internal so same-machine clusters work.
  runTrunk(systemName: string, scriptPath: string, cfg: TrunkConfig, network: string, hostPort: number): Promise<string>
  removeTrunk(systemName: string): Promise<void>
}

// ── Systems: wiring + isolation (docs/design/systems.md) ─────────────────────
// A system groups apps: one Docker network per system (members reach each
// other at http://<app-name>:<container-port> via Docker DNS), plus [wires]
// env bindings. Membership is many-to-many: an app deploys once and joins
// every system it belongs to.

export interface SystemManifest {
  name: string                        // same NAME_RE rules as apps
  // app name -> source + optional placement: node = "<peer-name>" puts the
  // member on that peer daemon; a trunk stitches the system across nodes.
  members: Record<string, { source: string; node?: string }>
  wires: Record<string, string>       // "<app>.<ENV_KEY>" -> value (usually http://<member>:<port>/..)
}

export interface SystemRecord {
  name: string
  sourceFile: string                  // absolute path to the system.toml ('adopted:<origin>' on peers)
  members: string[]                   // app names LOCAL to this node
  wires: Record<string, string>
  memberNodes?: Record<string, string>  // member -> peer name; absent/'' = local. Includes ALL members.
  origin?: string | null              // node that owns the manifest (set on adopted records)
  trunkHostPort?: number | null       // host port this node's trunk ingress is published on
  trunkToken?: string | null          // shared secret in the trunk preamble
  createdAt: string
  deployedAt: string | null
}

// A peer is another slab daemon this node can reach (the cluster registry).
export interface PeerRecord {
  name: string                        // the peer's node name
  url: string                         // e.g. http://garage:7766 (tailnet name/IP)
  token?: string                      // its SLAB_TOKEN, when set
}

// state.systems: Record<string, SystemRecord> — added alongside apps.
// Wire-env resolution at app deploy: collect wires targeting the app from ALL
// systems it belongs to; the same key bound to different values in two
// systems is a HARD deploy error naming both systems.
//
// New API routes:
//   GET    /v1/systems                    -> { systems: SystemRecord[] }
//   POST   /v1/systems                    -> body { sourceFile } (abs path to system.toml)
//                                            parses manifest, creates/updates record,
//                                            auto-creates unknown member apps from source -> { system }
//   DELETE /v1/systems/:name              -> detach members (disconnect network), remove network
//                                            + record. NEVER deletes member apps -> 204
//   POST   /v1/systems/:name/deploy       -> deploy all members (topo order by wires),
//                                            join network, inject wires -> { system, apps }
//
// Engine additions (network layer):
//   ensureNetwork(name): Promise<void>            // docker network slab-net-<system>
//   removeNetwork(name): Promise<void>            // tolerate missing
//   connectNetworks(app, networks): Promise<void> // connect app's container to each
//                                                 // network with alias = app name;
//                                                 // tolerate already-connected
// runContainer gains opts: { publish: boolean; networks: string[] } —
// publish=false -> NO PortBindings (isolated); networks joined after start.
