# Examples

Each directory is a self-contained slab app: a `slab.toml` plus either an
`image` reference or a `Dockerfile`. Deploy any of them with:

```
node dist/cli.js deploy ./examples/<name>
```

(or `slab deploy ./examples/<name>` if you've linked the CLI globally; run from
inside the example directory with no args once it's already registered).

| Example | Demonstrates | Build | Type | Postgres | Notes |
|---|---|---|---|---|---|
| `hello-fn/` | prebuilt `image` + scale-to-zero | `image = "nginx:alpine"` | function | no | Sleeps after 1m idle, wakes on the next request. |
| `whoami/` | request-echo via prebuilt image | `image = "traefik/whoami"` | function | no | Handy for inspecting what headers reach a tenant. |
| `grafana/` | a real third-party image as a function | `image = "grafana/grafana-oss"` | function | no | Wakes when you open it, sleeps 10m after you leave. |
| `hello-service/` | building from a `Dockerfile`, always-on service | `Dockerfile` (node:22-alpine, no npm deps) | service | no | Static `env` block (`GREETING`); never sleeps — `type = "service"`. |
| `pg-notes/` | `postgres = true` + scale-to-zero together | `Dockerfile` (node:22-alpine, `npm install`) | function | yes | slab injects `DATABASE_URL`; the app container can sleep (`idle_timeout = "3m"`) while the shared postgres container — and the notes in it — stay up. |
| `pg-cluster/` | a whole postgres cluster as a system: `volumes` + `[wires]` + private members | 3× prebuilt images (`bitnamilegacy/postgresql`, `pgbouncer`) | services | brings its own | Primary + streaming replica behind pgbouncer, all `public = false`; data survives redeploys via named volumes. `slab up examples/pg-cluster`. |
| `waffle/` | a 3-tier web app over pg-cluster; the waffle move (`node =` spans machines) | 2× `Dockerfile` + pg-cluster by source | services | brings its own | Public web → private api → pgbouncer; uncomment one `node =` line and the web tier runs on a peer, trunk conceals the distance. `slab up examples/waffle`. |
