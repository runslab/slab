# slab docs

> the localhost hyperscaler — your machine(s), run like a cloud.

New here? [Install slab](../README.md#install), then read
[getting-started](getting-started.md).

## guides

| doc | covers |
|---|---|
| [getting-started.md](getting-started.md) | install → deploy → routes, logs, secrets, tunnels, functions |
| [jobs.md](jobs.md) | `slab run` — one-shot workloads: tests, builds, sandbox/agent jobs |
| [cluster.md](cluster.md) | multiple machines: nodes, peers, `--node` targeting, the solar system |
| [manifest.md](manifest.md) | complete `slab.toml` reference (+ zero-manifest inference) |
| [skins.md](skins.md) | dashboard skins: built-ins + build your own with one CSS file |
| [agents.md](agents.md) | the MCP tool surface — slab as an AI agent's infrastructure |
| [providers/aws.md](providers/aws.md) | `--target aws`: App Runner / Lambda / Fargate in your own account |
| [api.md](api.md) | every daemon HTTP route |

## design notes

| doc | covers |
|---|---|
| [design/systems.md](design/systems.md) | systems: wiring + isolation (private networks, wires) |
| [design/trunks.md](design/trunks.md) | trunks: how systems span machines |
| [design/providers.md](design/providers.md) | providers: the plugin API for cloud targets (aws worked example) |

## the vocabulary

- **app** — one container slab manages: a `service` (always-on) or a
  `function` (scale-to-zero, wake-on-request)
- **job** — a run-to-completion container: exit code + logs kept
- **system** — apps wired together on a private network; `public = false`
  members are reachable only inside it
- **wire** — an env var one member gets, pointing at another
  (`"web.API_URL" = "http://api:5050"`)
- **node** — one machine running the slab daemon
- **peer** — another node this one can reach (the cluster registry)
- **trunk** — the per-system container that carries member traffic between
  nodes
- **slab types** — how a system carries load: **flat** (no wires),
  **one-way** (directed wiring), **two-way** (mutual wiring), **waffle**
  (spans nodes — utilities concealed in the voids)
