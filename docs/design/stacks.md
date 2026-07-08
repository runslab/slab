# Design: stacks — wiring, isolation, and the decoupling principle
_Status: design only, not built. Target: v0.3 (possibly v0.2 alongside jobs)._

## The gap

Slab has apps but no way to express a *system*. Every tenant is an island:
reachable only through the ingress (no discovery), yet also unisolated —
anything on the host can hit any published port. Real platforms grow this
pair eventually: **wiring** (how A finds B) and **isolation** (who may reach
whom). Fly: private 6PN. Kubernetes: services + network policies. AWS: VPC.

## The decoupling principle (three layers, three files)

Apps must not know about systems. The layers stay orthogonal:

| Layer | File | Declares | Analogy |
|---|---|---|---|
| **Unit** | `slab.toml` (per app) | what I am, what I listen on, what I **need** (named env inputs) | the appliance |
| **Wiring** | `[wires]` in the stack (or a separate `wires.toml` overlay) | which app's output feeds which app's need | the cabling |
| **System** | `stack.toml` | members, isolation boundary, which members are public | the room |

An app declares needs abstractly — it already half-does this via `secrets`
(named env inputs, values supplied externally). A stack *binds* those needs
to other members. The same app runs unchanged in any stack, or standalone
with values from `slab secret set`. No app ever contains another app's name.

```toml
# pg-notes/slab.toml — the unit knows only its own shape
name = "pg-notes"
type = "function"
port = 3000
postgres = true

# carehub.stack.toml — the system knows the topology
name = "carehub-demo"

[apps.conduit]
source = "github.com/jasonmimick/conduit"
public = true            # gets an ingress hostname

[apps.paysim]
source = "../paysim"
public = true

[apps.notes]
source = "./examples/pg-notes"
public = false           # NO published port, NO ingress — internal only

[wires]
# bind member needs to member addresses; names resolve via stack DNS
paysim.CONDUIT_INGEST_URL = "http://conduit:3000/api/ingest"
```

## Implementation sketch (deliberately thin)

- One Docker network per stack (`slab-net-<stack>`); members join with
  network alias = app name. Docker's embedded DNS then makes
  `http://conduit:3000` resolve inside the stack. Discovery costs zero code.
- `public = false` members get **no host port binding at all** — the VPC
  moment. Unreachable except by stack-mates.
- `[wires]` is env injection at deploy time. Explicit, greppable, no magic.
- Deploy order = topological sort of wires; a member failure stops the stack
  deploy and reports. **No** health-gated orchestration, rollbacks, retries,
  traffic splitting, or mTLS — connectivity is slab's job; *policy* is a
  mesh/governance product's job (in this portfolio: Cairn).
- Dashboard: each stack renders as its own cabinet. Standalone apps keep the
  default cabinet.
- MCP: `slab_stack_deploy` — one call, one wired system. This is the agent
  story's missing piece ("build me an api + worker + db" = one manifest).
- Maps 1:1 to promote-to-cloud: stack → VPC (AWS) / private network (Fly).

## Runtime dependence (the Docker question)

Slab is *conceptually* runtime-agnostic: the `Engine` interface
(`src/types.ts`) is the only place containers are touched, and stacks add
only "create network / join network" to it. Candidate engines, in order of
practicality:

1. **Docker Engine** (today) — ubiquitous, dockerode, done.
2. **Podman** — daemonless, near-drop-in (Docker-compatible API socket;
   dockerode can point at it). Cheapest second engine; kills the Docker
   Desktop licensing question.
3. **Apple containers** — macOS 26's native Containerization framework
   (`container` CLI, per-container lightweight VMs on Apple silicon).
   The natural Mac-native engine; watch its maturity.
4. **Process engine** — no containers at all: run trusted local apps as
   plain supervised processes (port + env, no image). Zero-dependency mode
   for dev; loses isolation, which is fine for your own code on your own
   machine. Pairs badly with stacks' isolation story — document as such.
5. **containerd / Firecracker** — the serious-Linux future (what Fly/faasd
   use); relevant only when slab runs fleets on Linux hosts.

Decision: stay on Docker through dogfood; keep the Engine seam honest (no
dockerode types outside engine.ts); Podman is the proof-of-pluggability
candidate. The Go rewrite should target the OCI/engine seam, not Docker.
