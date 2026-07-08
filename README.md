<div align="center">

<img src="assets/logo.svg" width="170" alt="slab — a concrete slab: the foundation">

# slab

**the localhost hyperscaler**

Your machine, run like a cloud: containers, HTTP ingress, Postgres, secrets,
public tunnels, and one-shot jobs — driven by a CLI, a live hi-fi-rack
dashboard, or AI agents speaking MCP.

*one machine · one daemon · zero cloud accounts*

**[jasonmimick.github.io/slab](https://jasonmimick.github.io/slab/)** · [docs](docs/README.md) · [install](#install)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/jasonmimick/slab?quickstart=1)

*↑ try slab in your browser — no install. Docker-in-Docker in a free Codespace: the daemon boots, the rack seeds itself, open port 7766.*

</div>

```text
┌────────────────────────────────────────────────────────────────┐
│  ▘▝▘▝▘▝▘▝▘▝▘▝▘▝▘▝▘▝▘▝▘▝▘▝▘▝                                    │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ U01 ◉ ▮▮▮▮▮▯▯▯  lake-api    ● running      042 req/m       │ │
│ │ U02 ◉ ▮▮▯▯▯▯▯▯  feeder      ◐ sleeping  wakes-on-hit       │ │
│ │ U03 ◉ ▮▮▮▮▮▮▮▯  scoreboard  ○ private    system-only       │ │
│ └────────────────────────────────────────────────────────────┘ │
│  arcade_     system · 3 members · 2 wires      ch2 · C · sine  │
└────────────────────────────────────────────────────────────────┘
      every app a rack unit · flip it open to see the board
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jasonmimick/slab/master/install.sh | bash
```

The installer checks your prerequisites (and tells you exactly how to fix
any that are missing), clones slab to `~/.slab/src`, builds it, puts `slab`
on your PATH, and starts the daemon. Re-run it any time to upgrade.

**Prerequisites** — the installer verifies all of these:

| need | why | get it |
|---|---|---|
| **Docker** (engine running) | every app, job, and database is a container | [Docker Desktop](https://www.docker.com/products/docker-desktop) (mac) · `curl -fsSL https://get.docker.com \| sh` (linux) |
| **Node.js ≥ 20** | the daemon + CLI runtime (until the Go rewrite) | `brew install node` · [nodejs.org](https://nodejs.org) |
| **git** | cloning repos you deploy | `brew install git` |
| *cloudflared* (optional) | only for `slab expose` public tunnels | `brew install cloudflared` |

macOS and Linux; on Windows use WSL2.

## Sixty seconds

```bash
slab deploy dockersamples/linux_tweet_app   # any github repo with a Dockerfile — no config needed
open http://linux-tweet-app.localhost:8080  # routed by the ingress
open http://localhost:7766                  # the rack
```

No `slab.toml` in the repo? slab infers one: name from the repo, port from
the Dockerfile's `EXPOSE`. Add a manifest when you want more (functions,
postgres, secrets, private members) — see [docs/manifest.md](docs/manifest.md).

## Three verbs

| verb | what it runs | example |
|---|---|---|
| `slab deploy` | **apps** — services (always-on) & functions (scale-to-zero, wake-on-request) | `slab deploy owner/repo` |
| `slab run` | **jobs** — build/test/scripts to completion, exit code + logs kept, timeout guardrail | `slab run . -- npm test` · `slab run . --image node:20 -- npm test` |
| `slab up` | **systems** — apps wired together on a private network; `public = false` members are unreachable from outside | `slab up ./system.toml` |

Everything else: `slab list · jobs · logs · secret set · expose · url ·
stop/start/rm · node <name> · play` *(yes, you can hear your rack)*.

## The dashboard

`http://localhost:7766` renders your fleet as a wall of hi-fi rack cabinets:
per-unit power buttons, VU needles swinging with live req/min, LED level
ladders, live iframe thumbnails of running apps, a spectrum analyzer that
plays your traffic as pentatonic audio, system wiring diagrams, a zoomed-out
overview for many racks, and an **empty bay** — paste any GitHub URL and it
mounts + deploys from the browser.

Not your vibe? It's **skinnable**: built-in `hyperscaler` skin (flat ops
console, all hardware chrome stripped), light/dark for both, and custom
skins are a single CSS file in `~/.slab/skins/` — see
[docs/skins.md](docs/skins.md).

## For agents

slab ships an MCP server (`dist/mcp.js`, stdio): `slab_deploy`, `slab_run`
(blocks and returns exit code + logs), `slab_logs`, `slab_secret_set`,
`slab_expose`, `slab_system_deploy`, … — an agent can take a repo to a
running, routable app, or execute sandboxed jobs, without ever learning
Docker. See [docs/agents.md](docs/agents.md). The founding thesis: agents
create infrastructure faster than humans can track it, so the platform
must make running things legible, bounded, and reversible.

## What's in the box

- **Services vs functions.** `type = "service"` is always-on and restarts if
  it dies. `type = "function"` scales to zero after `idle_timeout`; the
  ingress wakes it on the next request.
- **Jobs.** Run-to-completion workloads with exit codes, kept logs, a
  timeout reaper, cancel, and a dashboard job bench.
- **Image or Dockerfile.** `image = "..."` pulls and runs; otherwise the
  `Dockerfile` is built. Git sources are pulled on every redeploy.
- **Systems.** One Docker network per system, members reach each other by
  app name, `[wires]` inject env bindings, private members get no host port
  at all.
- **Per-app Postgres.** `postgres = true` → a `DATABASE_URL` appears,
  backed by one shared postgres container, one database per app.
- **Secrets.** `slab secret set <app> KEY=VALUE` — outside the manifest,
  merged into the env at deploy.
- **Public tunnels.** `slab expose <app>` → a free Cloudflare quick-tunnel
  URL for webhooks and demos.
- **Named nodes.** Every daemon has an identity (`slab node`) — groundwork
  for multi-node.

More detail — full index at [docs/](docs/README.md):
- [docs/getting-started.md](docs/getting-started.md) — install → deploy → everything
- [docs/jobs.md](docs/jobs.md) — `slab run`: tests, builds, sandbox/agent jobs
- [docs/cluster.md](docs/cluster.md) — nodes, peers, `--node`, the solar system
- [docs/manifest.md](docs/manifest.md) — complete `slab.toml` reference
- [docs/agents.md](docs/agents.md) — the MCP tool surface for agents
- [docs/api.md](docs/api.md) — the daemon HTTP API
- [docs/skins.md](docs/skins.md) — dashboard skins: built-ins (stereo, hyperscaler) + build your own CSS skin
- [examples/](examples/) — runnable sample apps

## Status

v0, weekend-spike maturity. Known sharp edges, honestly stated:

- **Single-node.** One daemon, one Docker host, no clustering, no HA.
- **Secrets are plaintext on disk**, one JSON file per app under
  `~/.slab/secrets`, `chmod 600`. Fine for a single-user local machine, not
  a substitute for a real secrets manager.
- **Quick-tunnel URLs rotate.** Every time a tunnel (re)opens — including on
  daemon restart — Cloudflare hands out a new `trycloudflare.com` URL.
  Don't hardcode it anywhere that matters.
- **Function wake latency** depends on the image; the proxy waits up to 15s
  for the container to answer before giving up.

## Hacking on slab itself

```bash
git clone https://github.com/jasonmimick/slab.git && cd slab
npm install && npm run build
node dist/daemon.js          # api :7766 + ingress :8080
node dist/cli.js deploy examples/hello-fn
```

## Roadmap

Rough order; nothing here is promised, everything here is intended.

1. **Jobs — `slab run`** ✅ SHIPPED. A third thing slab runs beside services
   and functions: run-to-completion workloads. `slab run . -- npm test`
   builds the Dockerfile and runs the command; `slab run . --image node:20
   -- npm test` skips the build and mounts the source at `/workspace` in a
   stock image. Timeout guardrail (default 30m), cancel, exit codes, logs,
   job bench on the dashboard, `slab_run` MCP tool for agents. Next up in
   this lane: the coding-agent job with a budget cap.
2. **Overview / zoom-out mode** ✅ SHIPPED — a bird's-eye grid when there are
   many systems (imagine 1000 racks): each system a small tile, live status
   colors, click a tile to fly into that rack. The dashboard scales from
   one laptop to a wall of racks.
3. **Systems — wiring + isolation** ✅ SHIPPED (design + status: [docs/design/systems.md](docs/design/systems.md)).
   A second manifest that groups apps into a system: one Docker network per
   system (members reach each other by app name), `public = false` members
   get no host port at all (the VPC moment), `[wires]` binds one app's needs
   to another's address. Membership is many-to-many — an app deploys once
   and can join several systems. Units never know about systems.
4. **TTL + budget guardrails.** Every app gets an optional `ttl` and
   spend/uptime budget in slab.toml; the daemon reaps what nobody remembered
   to turn off. Agents create infrastructure faster than humans track it —
   this is the founding lesson of the project.
5. **Named tunnels.** Stable hostnames on your own domain (Cloudflare named
   tunnels) instead of rotating trycloudflare URLs. Same code path as
   `expose`, config instead of chance.
6. **Multi-node.** Shipping in slices. Done: node identity (`slab node`),
   peers registry (`slab peer add garage http://garage:7766`), cluster auth
   (`SLAB_TOKEN` + `SLAB_BIND`/`SLAB_ADVERTISE`), and **trunks** — systems
   that span nodes ([docs/design/trunks.md](docs/design/trunks.md)): put
   `node = "garage"` on a member and a per-system trunk container on each
   node carries `http://<member>:<port>` across machines unchanged, private
   members included. Also done: the **solar system** (zoom out and every
   node renders as its own band — sun badge, systems as tiles, dead nodes
   shown honestly) and **`slab --node <name>`** targeting (any command
   against any peer: `slab --node garage deploy owner/repo`, resolved from
   the peer registry, tokens included) and **`slab run --node any`** — git-
   sourced jobs land on whichever node has the fewest active jobs. A bunch
   of slabs, one hyperscaler: this lane is done pending a real scheduler
   (capacity signals beyond job count).
7. **Multi-target drivers — `slab deploy --target aws|fly`.** The Engine
   interface already isolates Docker; a second driver renders the same
   manifest to Fargate/Lambda/RDS (or Fly machines). One manifest, one verb
   set, many targets — agents never learn AWS, they learn slab.
8. **Go rewrite (v1.0, decided).** TypeScript was the right spike language —
   MCP SDK first-class, product-in-a-day. Go is the right shipping language:
   the entire container/networking neighborhood lives there (Docker client,
   `httputil.ReverseProxy`, cloudflared itself), goroutines match the
   workload, and `GOOS=linux GOARCH=arm64` turns slab into a single static
   binary you `brew install` — no Node runtime on the target machine. The
   manifest, HTTP API, and MCP tool surface are the product and stay
   byte-compatible; the daemon behind them is an implementation detail, and
   `examples/` doubles as the acceptance suite. (Interim option if
   distribution itches sooner: `bun build --compile` on the existing code.)
