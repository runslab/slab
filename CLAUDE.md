# slab — architecture & information model

slab is the localhost hyperscaler: a self-hosted PaaS in TypeScript/Node that
turns machines you own into a rack. One daemon per node, docker underneath,
agents drive it via MCP. Repo: github.com/runslab/slab · site: runslab.run ·
install: `curl -fsSL https://runslab.run/install | bash`.

**Read this file first — it is the source of truth for agents. Do not
re-derive anything documented here by grepping.**

## Process architecture

One node = one daemon (`src/daemon.ts`), a single process serving:

- **HTTP API** on `:7766` (`docs/api.md`, routes in daemon.ts) — everything
  goes through it: CLI, MCP, dashboard, peers.
- **Ingress proxy** on `:8080` (`src/proxy.ts`) — routes
  `http://<app>.localhost:8080` to the app's host port; wakes sleeping
  functions on request.
- **Dashboard** at `localhost:7766` (`src/dashboard.ts`) — the rack UI
  (breathing rack → board flip → fleet zoom → skins). Rack metaphor is
  a product rule: UI language is racks/slabs/boards, not "instances".
- The CLI **self-starts the daemon** when it's unreachable.

Module map (`src/`): `cli.ts` (commander CLI), `daemon.ts` (API + deploy
orchestration), `engine.ts` (all dockerode container work), `manifest.ts`
(slab.toml + system.toml parsing), `types.ts` (**core contracts — every
module codes against this file**; the Engine interface here duplicates
runContainer's opts type, update both), `state.ts` (persistence),
`proxy.ts`, `trunk.ts` (cross-node stitching), `tunnel.ts` (cloudflared for
`slab expose`), `mcp.ts` (MCP server; tools `slab_create`, `slab_deploy`,
`slab_list`, `slab_logs`, `slab_run`, `slab_expose`, …), `git.ts` (git-url
sources, `"owner/repo"` shorthand), `api-client.ts` (CLI→daemon),
`dashboard.ts`, `providers/` (cloud targets).

State lives in `~/.slab/`: `state.json` (app/system records),
`secrets/<name>.json`. Containers are named `slab-<app>`, labeled
`slab.app=<app>`.

## Information model

### App (unit of deploy) — manifest `slab.toml`, parsed by `loadManifest()`

| field | type | notes |
|---|---|---|
| `name` | string | required, `^[a-z][a-z0-9-]{1,30}$` |
| `type` | `"service"` \| `"function"` | service = always-on (restart unless-stopped); function = scale-to-zero, sleeps after `idle_timeout` (default `"5m"`), woken by the proxy |
| `target` | string? | `"docker"` (default) or a provider, e.g. `"aws"` |
| `port` | int | port INSIDE the container |
| `public` | bool, default true | `false` → no host port, no ingress; reachable only by system-mates. A private *function* can't be woken (daemon warns) |
| `image` | string? | prebuilt image — pull & run. Omit → build the Dockerfile in the source dir |
| `postgres` | bool | `true` → shared `slab-postgres` container (postgres:16-alpine, volume `slab-pgdata`, host port 20432, creds slab/slab), per-app db `slab_<name>` (hyphens→underscores), injects `DATABASE_URL` via host.docker.internal |
| `secrets` | string[] | documentation-only list of expected env names; actual values via `slab secret set <app> K=V` → all stored secrets get injected regardless |
| `volumes` | string[] | `"name:/container/path"`, **named volumes only** (no host paths); real volume is `slab-<app>-<name>`, auto-created, **kept on `slab rm`** (purge: `docker volume rm`); per-node — a member moved via trunks starts empty |
| `env` | table | static env vars |

No slab.toml? Any dir/repo with a Dockerfile deploys anyway: name from the
dir, type service, port from first `EXPOSE` (default 3000). `PORT` is always
injected from `manifest.port`. Env merge order:
**PORT < manifest.env < wires < secrets < DATABASE_URL**.

Every deploy **removes and recreates** the container
(`removeExistingContainers` → `createContainer` in engine.ts) — the writable
layer is lost each time; only `volumes` paths survive.

### System (apps wired together) — `system.toml`, deployed with `slab up <dir|file>`

```toml
name = "demo"
[apps.web]
source = "./web"          # dir relative to system.toml, or git url
node = "some-peer"        # optional: run this member on a peer (the waffle move)
[wires]
"web.API_URL" = "http://api:3000"   # sets env API_URL on member web
```

- `slab up <dir>` resolves `<dir>/system.toml` (cli.ts).
- Members get a shared docker network `slab-sys-<system>`; they resolve each
  other **by app name**. An app can belong to several systems.
- Wires become env on the named member. Cross-node members are stitched by
  **trunks** (trunk.ts) so wired hostnames keep working across machines.
- **A system that spans nodes needs distinct member ports** (trunk
  constraint — deploy fails with a clear error otherwise). Catalog systems
  keep ports distinct for this reason (pg-replica 5433, waffle-api 3001).
- Cross-node members resolve `source` on the PEER's filesystem: deploy
  spanning systems from a path that exists on every node —
  `~/.slab/src/examples/...` works because every install has the repo there
  (git-pull peers' `~/.slab/src` to the right commit first). The dev-checkout
  path only exists on euler.
- Slab types (computed from the wire graph, never declared; site section
  "Slab types"): **flat** (no wires), **one-way** (directed/acyclic),
  **two-way** (mutual/cyclic), **waffle** (spans nodes). Product framing:
  three nouns (apps/jobs/systems), three verbs (deploy/run/up), one verb
  per noun. Jason's formalization (canonical): **system = ({apps, jobs},
  wires)** — a graph whose vertices are things that run (jobs are transient
  vertices: they attach, probe, leave — "the graph breathes"); **node = a
  daemon carrying a set of systems**; **nodes + trunks = the fleet, a graph
  one scale up** ("it's graphs all the way up" — this resolves the
  node/vertex terminology rub: machines are correctly nodes because the
  fleet is itself a graph). The dashboard mirrors the tower: rack unit →
  cabinet → band → fleet view. flat/one-way/two-way = edge properties;
  waffle = a system carried by more than one node. Motivation line: "what
  the daemon can compute, it can guarantee." Graph theory lives in the
  site's SHEET S-2 drafting figure + footnote register, never headlines.

### Jobs
`slab run <src> -- cmd` runs a container to completion (`slab jobs`,
`slab job`). Job containers may Bind a workspace mount.

### Cluster
Peers are other daemons: `slab peer add <name> <url>` with a shared token
(`slab node token`). Current rack: **euler** (this dev machine) +
**jasons-mac-mini** (`http://jasons-mac-mini.local:7766`).

### Providers (`src/providers/`, docs/providers/aws.md)
`target = "aws"` routes by **intent**: `type=service` (public) → App Runner
(pause/resume = real $0), `type=function` → Lambda container + Function URL
(web-adapter needed; PORT/AWS_LWA_PORT set), `public=false` → Fargate
(BETA). Substrate is encoded in the ref (`apprunner:`/`lambda:`/`fargate:`);
intent changes retire the old home. Images: uniformly linux/amd64 → ECR via
`provider.resolveImage`. Agents never learn AWS — the manifest's intent
picks the substrate. Jason tests AWS from a separate account **not reachable
from this machine — never probe AWS; trust pasted errors**.

## CLI surface
`create · deploy · up · run · jobs · job · list · systems · logs · stop ·
start · rm · secret · url · expose · hide · system · play · status · peer`
(note: it's `slab rm`, not `remove`). `slab feedback` opens a prefilled
GitHub issue. `slab upgrade` = git pull + rebuild + daemon restart
(installs live in `~/.slab/src`).

## Examples catalog (`examples/`)
Single apps (hello-fn, whoami, grafana, hello-service, pg-notes) + system
tomls (demo, arcade, observatory, studio, lakes, trunk-demo) + curated
systems: **pg-cluster** (postgres primary + streaming replica behind
pgbouncer, all private, volumes — compose-grade, no auto-failover) and
**waffle-house** (3-tier web app over pg-cluster; uncomment `node =` to span
machines). Images from bitnami must use **`bitnamilegacy/*`** — the bitnami
Docker Hub catalog is frozen (2025).

## Architecture rule: docker never leaks above the engine

The manifest/API/MCP surface is the product; `engine` (src/engine.ts,
go/internal/engine) is a docker *adapter*; providers are other adapters of
the same contracts (the trunk and the aws provider prove the contracts are
substrate-free). Docker SDK types must never appear in api/proxy/state/
daemon code — if a new layer needs docker, it goes through an engine
method. This is what keeps podman/colima compatibility free and future
substrates possible.

## Go rewrite (go/)

Module `github.com/runslab/slab/go`, ONE binary `cmd/slab`: `slab daemon`,
`slab mcp`, and every CLI verb (build: `cd go && go build -o bin/slab
./cmd/slab`). Parity ladder in cmd/slab/main.go; definition of done per
rung = `scripts/conformance.js` green with `DAEMON_CMD="go/bin/slab daemon"`
(`CONF_RUNG=n` scopes the run). Releases: push a `v*` tag →
.github/workflows/release.yml cross-compiles darwin/linux × amd64/arm64
and publishes tarballs + checksums. The TS daemon is the reference
implementation until the ladder is complete; behavior questions are
answered by reading src/, not by inventing.

## Dev workflow (this checkout)

- Build: `npm run build` (tsc + scripts/check-page.js). No test suite —
  verification is deploying real apps and driving them.
- **euler's daemon runs from THIS dev checkout** (not `~/.slab/src`): after a
  build, `pkill -f dist/daemon.js && node dist/daemon.js &`. Docker Desktop
  must be up (`open -a Docker`).
- mac-mini runs `~/.slab/src`; upgrade via `ssh mac-mini 'zsh -lc "slab upgrade"'`.
- Deploys of the site: push to master → `.github/workflows/pages.yml`
  uploads `site/` + `install.sh` (as `/install`) to Pages at runslab.run.
  Pushing workflow files needs gh's token, not the keychain:
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push`.
- Commit style: lowercase, dense, narrative — what shipped and why it's
  shaped that way (see `git log`).
