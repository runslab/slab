# observatory — the rack watches itself

A slab-native observability system: Prometheus scrapes the slab daemon's
`/metrics`, Grafana draws it, skinned to slab. Deploy **per node** — each node
gets its own observatory of its own rack.

```
slab up examples/observatory
open http://grafana.localhost:8080     # the "slab · the rack" dashboard
```

## What it shows (live, from slab's own metrics)

- **node up** — the daemon's heartbeat
- **apps by state** — running / sleeping / stopped counts
- **systems, jobs** — how much the rack is carrying
- **req/min per app** — `rate(slab_app_requests_total[1m])`, the VU-meter data
- **app up/down timeline** — which app was up when

All from the daemon's `/metrics` (Prometheus exposition). No per-app
instrumentation — slab knows this because it owns the ingress and the state.

## Members

| member | role | exposure |
|---|---|---|
| `prometheus` | scrapes `host.docker.internal:7766/metrics` | private |
| `grafana` | the face — dark skin, anonymous LAN admin, dashboard provisioned | public |
| `loki` | receives log pushes from the daemon (grafana queries it) | public* |

\* loki is public only so the daemon can reach its push port from the host; you query it through grafana, not directly.

Both build from a Dockerfile so their config is baked in — slab volumes are
**named-only** (no host bind-mounts), so config can't be mounted from the host.

## Logs — the daemon ships them (no host-mounted agent)

Deploy `loki` and the slab daemon **auto-discovers it** and starts pushing
every app's container logs (plus its own log ring) to it, labeled
`{app,node}`. No promtail, no `docker.sock` mount — the daemon already owns
the containers, so it ships the logs itself. Grafana's "logs (all apps +
daemon)" panel searches them. Set `SLAB_LOKI_URL` to push elsewhere; don't
run loki and shipping stays off.

## Honest limit (the host-access wall)

**cAdvisor** (per-container CPU/mem) still isn't here: it needs
`/var/run/docker.sock` + `/sys` host mounts, and slab forbids host
bind-mounts (`volumes` are named only). Logs sidestepped this by having the
daemon push; container *resource* metrics would need either a host-mount
escape hatch for system members, or the daemon exporting cgroup stats
itself. Tracked for later.

## App-level metrics (opt-in, future)

An app that exposes its own Prometheus `/metrics` can be discovered via the
daemon's `/v1/sd` (Prometheus http service-discovery). It's commented out in
`prometheus.yml` by default — blindly scraping every app port just fills the
board with red 404s, since almost no app serves Prometheus. Opt in per app
when the manifest can declare it.
