# slab — the localhost hyperscaler

slab is a tiny local PaaS for the AI-agent era: containers, Postgres, HTTP
ingress, secrets, and public tunnels, driven by a CLI, a web dashboard, or AI
agents talking MCP. One binary, one daemon, your own machine — no cloud
account required to go from a directory (or a git URL) to a running,
routable app.

## 60-second quickstart

```
npm install
npm run build
node dist/daemon.js          # or: slab daemon — starts the API (:7766) and ingress proxy (:8080)
```

In another terminal:

```
node dist/cli.js deploy examples/hello-fn
curl http://hello-fn.localhost:8080
```

Open the dashboard at [http://localhost:7766](http://localhost:7766) to see
every app, its state, and its wiring.

Once `dist/cli.js` is on your `PATH` (or you run `npm link`), the same
commands are just `slab deploy ...`.

## What it does

- **Services vs functions.** `type = "service"` is always-on and restarts if
  it dies. `type = "function"` scales to zero: the daemon stops its
  container after `idle_timeout` of inactivity and the ingress proxy wakes
  it back up on the next incoming request before forwarding.
- **Image or Dockerfile.** Set `image = "..."` for a prebuilt image (slab
  just pulls and runs it), or drop a `Dockerfile` in the app's source dir
  and slab builds it. `image` wins if both are present.
- **Git-URL sources.** `slab deploy owner/repo` (or a full `https://`/`git@`
  URL) clones into `~/.slab/repos` and does a `git pull --ff-only` on every
  redeploy — no local checkout required.
- **Per-app Postgres.** `postgres = true` gets you a `DATABASE_URL` injected
  at deploy time, backed by one shared `slab-postgres` container and a
  dedicated database per app.
- **Secrets.** `slab secret set <app> KEY=VALUE` stores values outside the
  manifest; they're merged into the container's env on the next deploy.
- **Public tunnels.** `slab expose <app>` opens a free Cloudflare quick
  tunnel (no account, no domain) pointed at the ingress proxy, so webhooks
  and outside callers can reach an app that only lives on your laptop.
- **Telemetry.** The dashboard and `GET /v1/apps` report live req/min per
  app, computed from a rolling 60-second window.
- **MCP server.** `dist/mcp.js` exposes slab over stdio so agents can create,
  deploy, inspect logs, manage secrets, and expose apps as first-class
  tools — see [docs/agents.md](docs/agents.md).

More detail:
- [docs/getting-started.md](docs/getting-started.md) — full walkthrough
- [docs/manifest.md](docs/manifest.md) — complete `slab.toml` reference
- [docs/agents.md](docs/agents.md) — the MCP tool surface for agents
- [docs/api.md](docs/api.md) — the daemon HTTP API
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

## Roadmap

Rough order; nothing here is promised, everything here is intended.

1. **Jobs — `slab run`** (v0.2 headline). A third app type beside service and
   function: run-to-completion workloads. `slab run <git-url> -- npm test`,
   and the agent version: a coding agent in an isolated container with the
   workspace mounted, a budget cap, and results reported back through the
   same API the dashboard reads. This is the sandbox / AI-coding-task story.
2. **Systems — wiring + isolation** (design: [docs/design/systems.md](docs/design/systems.md)).
   A second manifest that groups apps into a system: one Docker network per
   system (members reach each other by app name), `public = false` members
   get no host port at all (the VPC moment), `[wires]` binds one app's needs
   to another's address. Membership is many-to-many — an app deploys once
   and can join several systems. Units never know about systems.
3. **TTL + budget guardrails.** Every app gets an optional `ttl` and
   spend/uptime budget in slab.toml; the daemon reaps what nobody remembered
   to turn off. Agents create infrastructure faster than humans track it —
   this is the founding lesson of the project.
4. **Named tunnels.** Stable hostnames on your own domain (Cloudflare named
   tunnels) instead of rotating trycloudflare URLs. Same code path as
   `expose`, config instead of chance.
5. **Multi-target drivers — `slab deploy --target aws|fly`.** The Engine
   interface already isolates Docker; a second driver renders the same
   manifest to Fargate/Lambda/RDS (or Fly machines). One manifest, one verb
   set, many targets — agents never learn AWS, they learn slab.
6. **Go rewrite (v1.0, decided).** TypeScript was the right spike language —
   MCP SDK first-class, product-in-a-day. Go is the right shipping language:
   the entire container/networking neighborhood lives there (Docker client,
   `httputil.ReverseProxy`, cloudflared itself), goroutines match the
   workload, and `GOOS=linux GOARCH=arm64` turns slab into a single static
   binary you `brew install` — no Node runtime on the target machine. The
   manifest, HTTP API, and MCP tool surface are the product and stay
   byte-compatible; the daemon behind them is an implementation detail, and
   `examples/` doubles as the acceptance suite. (Interim option if
   distribution itches sooner: `bun build --compile` on the existing code.)

