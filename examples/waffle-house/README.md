# waffle-house

A 3-tier web app as one system — and the reason it's named after the site's
**waffle** cast: uncomment one line and a tier moves to another machine.

```
slab up examples/waffle-house
```

```
┌─ waffle-house ────────────────────────────────────────────────┐
│  browser ──> waffle-web (public)                        │
│                  │ API_URL (wire)                       │
│              waffle-api (private)                       │
│                  │ DATABASE_URL (wire)                  │
│              pgbouncer ──> pg-primary ~~> pg-replica    │
└─────────────────────────────────────────────────────────┘
```

Order a waffle topping in the browser; the web tier proxies it server-side to
the private api, the api writes it through pgbouncer, and the row streams to
the replica. Redeploy anything — orders survive (named `volumes` on the pg
members).

## The waffle move

By default all five members land on one node. To span machines, uncomment in
`system.toml`:

```toml
[apps.waffle-web]
source = "./web"
node = "your-peer-name"   # slab peer ls
```

and `slab up examples/waffle-house` again. The web tier now runs on the peer, the
api + database stay put, and the trunk conceals the distance — `API_URL`
keeps working, nothing else changes. That's the whole point.

## What it demonstrates

- **3 tiers, 1 manifest** — public web, private api, private database, wired
  by name, deployed by one command.
- **the tier boundary is real** — the browser can only ever reach
  `waffle-web`; the api and database have no host ports anywhere.
- **pg-cluster reuse** — the database members come from
  `../pg-cluster/*` by source. If you already ran `examples/pg-cluster`,
  waffle adopts the same running apps instead of duplicating them.
- **cross-node placement (`node =`)** — a member's home is one line of TOML,
  not an architecture decision.
