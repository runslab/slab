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

Both build from a Dockerfile so their config is baked in — slab volumes are
**named-only** (no host bind-mounts), so config can't be mounted from the host.

## Honest limits (the host-access wall)

This v1 is slab's *own* metrics. Two things a fuller stack wants are **not**
here, on purpose:

- **cAdvisor** (per-container CPU/mem) needs `/var/run/docker.sock` + `/sys`
  host mounts.
- **Loki log aggregation** needs a shipper with host/socket access.

slab deliberately forbids host bind-mounts (`volumes` are named only). So
infra tools that read host state don't drop in as normal slab apps. That's a
real product tension — the fix is either a privileged/host-mount escape hatch
for system members, or daemon-side pushing (the daemon already has the log
ring and app logs; it could push to a Loki endpoint). Tracked for later.

## App-level metrics (opt-in, future)

An app that exposes its own Prometheus `/metrics` can be discovered via the
daemon's `/v1/sd` (Prometheus http service-discovery). It's commented out in
`prometheus.yml` by default — blindly scraping every app port just fills the
board with red 404s, since almost no app serves Prometheus. Opt in per app
when the manifest can declare it.
