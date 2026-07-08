# trunks — systems that span nodes

**Status: v1 shipped.** A system's members can live on different slab nodes;
a per-system **trunk** container on each involved node stitches them together
so `http://<member>:<port>` works unchanged, including for `public = false`
members that have no host port anywhere.

## the idea

Docker bridge networks are per-host, so a system spanning machines can't
share one. Instead of an IP overlay (CNI territory), slab solves it at the
layer it owns — names and wires:

- Each involved node keeps its own bridge for the system.
- Each node runs **one trunk container** joined to that bridge carrying a
  **DNS alias for every remote member**. When a local member dials
  `http://scoreboard:4000`, Docker DNS hands it the trunk's IP.
- The trunk accepts the TCP stream on the member's port, dials the target
  node's trunk ingress (a host-published port), sends a one-line preamble
  (`<token> <member>\n`), and pipes bytes. The receiving trunk verifies the
  token and pipes on to the real container over its own bridge.

Plain TCP end to end — HTTP, postgres, websockets, anything. Members never
know; the calling app's bytes are untouched.

## using it

```toml
# system.toml
name = "arcade"

[apps.game]
source = "./game"

[apps.scoreboard]
source = "https://github.com/you/scoreboard"   # git source: the peer clones it
node = "garage"                                # <- placement
```

```bash
slab peer add garage http://garage:7766 --token <its SLAB_TOKEN>
slab up ./system.toml
```

The console node deploys its own members, pushes the system to each placed
peer (**adopt**: the peer creates + deploys its members and allocates a trunk
port), validates that member ports are distinct across the system, then
starts every node's trunk (**trunk-sync**) with the same map.

## node config

The network posture is a persisted setting (`~/.slab/node.json`, chmod 600),
managed by the CLI — each command restarts the daemon for you:

```bash
slab node open                 # bind 0.0.0.0 + generate a token; prints dashboard/peer lines
slab node open --advertise garage.tailnet.ts.net   # what other nodes dial for trunks
slab node token --rotate       # fresh token (re-run slab peer add on nodes that point here)
slab node close                # back to loopback-only
slab upgrade                   # git pull + rebuild + restart, config survives
```

Env vars override the file for one-off runs:

| env | default | meaning |
|---|---|---|
| `SLAB_PORT` / `SLAB_PROXY_PORT` | 7766 / 8080 | api + ingress ports |
| `SLAB_BIND` | 127.0.0.1 | bind address for api + ingress |
| `SLAB_TOKEN` | — | required from non-loopback callers (`Authorization: Bearer` or `?token=`) |
| `SLAB_ADVERTISE` | 127.0.0.1 | address other nodes use to reach this one (tailnet name/IP) |
| `SLAB_DIR` | ~/.slab | state dir (lets several daemons share a machine) |

Recommended transport between machines: a tailnet — encrypted, stable names,
never on the public internet. Trunk ingress ports bind all interfaces; the
preamble token is the auth.

## same-machine clusters

Two daemons on one machine (separate `SLAB_DIR` + ports) share one Docker
engine, so spanning systems use **node-scoped** network and trunk names
(`slab-net-<node>-<system>`, `slab-trunk-<node>-<system>`) — each node gets
its own bridge and the aliases stay unambiguous. Single-node systems keep
plain names. Peer trunk addresses of `127.0.0.1` are rewritten to
`host.docker.internal` inside trunk containers.

## v1 limits, honestly

- **Distinct ports.** Members of a spanning system must listen on distinct
  container ports (the trunk routes egress by port). Clear deploy error.
- **Remote sources.** Across real machines, placed members should use git
  sources (the peer clones). Absolute paths only work if the path exists on
  the peer (fine for same-machine nodes).
- **Removal is per-node.** `slab system rm` cleans the local trunk +
  network; adopted records on peers are removed there.
- **Trunk hop.** One extra proxy hop per cross-node call; same-node calls
  never touch the trunk.
