# providers — one manifest, many targets

**Status: phase 1 shipped.** The Provider API below is implemented
(`src/providers/provider.ts`) with the **aws provider**
(`src/providers/aws.ts`, guide: [../providers/aws.md](../providers/aws.md))
as the reference: intent-routed — `type = "service"` → App Runner,
`type = "function"` → Lambda + Function URL, `public = false` → Fargate
(beta). Jobs/systems/postgres capabilities and further providers (fly, gcp)
are open — issues/PRs welcome.

## the one-sentence pitch

Agents (and humans) shouldn't have to learn AWS, Fly, or GCP — they learn
slab's three verbs and one TOML dialect, and a **provider** renders those
onto a target. The manifest, CLI, HTTP API, and MCP tools stay
byte-identical; only the substrate changes.

## what exists today: the Engine seam

Every substrate-touching call the daemon makes already goes through one
interface — `Engine` in `src/types.ts`, implemented once with dockerode in
`src/engine.ts`. Verbatim surface (19 methods, all in use):

| group | methods |
|---|---|
| apps | `buildImage` `runContainer` `stopContainer` `startContainer` `removeContainer` `getLogs` `isRunning` |
| data | `ensurePostgres` |
| systems | `ensureNetwork` `removeNetwork` `connectNetworks` |
| jobs | `buildJobImage` `runJob` `waitJob` `getJobLogs` `stopJob` `removeJob` |
| trunks | `runTrunk` `removeTrunk` |

That's the good news: the daemon has **no** other Docker knowledge. The bad
news, honestly: the contract leaks Docker idioms a cloud provider can't
honor —

- `containerId: string` on records — assumes one container per app
- `hostPort` — slab allocates local ports and the ingress dials
  `127.0.0.1:<hostPort>`
- `ensureNetwork('slab-net-x')` — assumes bridge networks it can name
- image-mode jobs bind-mount `sourceDir` — assumes shared filesystem
- `RestartPolicy`, label filters, `docker wait` semantics

## Provider API v1 — the proposed contract

A **provider** is an object implementing `Provider`, registered under a
name. Design rules, in priority order:

1. **Wire-safe from day one.** Every method takes and returns
   JSON-serializable values only — no dockerode types, no callbacks, no
   streams (logs return strings; follow-mode is a capability for later).
   This is deliberate: at the Go rewrite (roadmap #8) providers become
   out-of-process plugins speaking this exact shape over stdio; anything
   written against v1 survives.
2. **Opaque refs, not container ids.** `deploy()` returns
   `{ ref, endpoint }` — `ref` is whatever the provider needs to find the
   workload again (container id, ECS task ARN, Fly machine id), stored
   as-is on the record. `endpoint` is `host:port` (or a URL) the ingress
   dials — replacing `hostPort` and unifying local + remote behind
   `app.localhost:8080`.
3. **Capabilities, not assumptions.** Providers declare what they support;
   the daemon feature-gates and errors *early and clearly* on the rest.

```ts
interface Provider {
  name: string                        // "docker" | "aws" | "fly" | ...
  capabilities: {
    functions: boolean                // scale-to-zero + wake-on-request
    jobs: boolean
    systems: boolean                  // member isolation + name resolution
    mounts: boolean                   // image-mode jobs (shared filesystem)
    postgres: boolean
    trunks: boolean                   // can host a trunk endpoint
  }

  // apps — image is always a registry ref the provider can pull
  deploy(app: AppSpec, image: string, env: Record<string, string>,
         opts: { public: boolean; system?: string }): Promise<{ ref: string; endpoint: string | null }>
  stop(ref: string): Promise<void>
  start(ref: string): Promise<{ endpoint: string | null }>
  remove(ref: string): Promise<void>
  status(ref: string): Promise<'running' | 'stopped' | 'unknown'>
  logs(ref: string, tail: number): Promise<string>

  // images — providers that can't reach the local image store get a push
  registry?(): Promise<{ repoUrl: string; auth: string }>   // e.g. ECR

  // jobs
  runJob(job: JobSpec, image: string): Promise<{ ref: string }>
  waitJob(ref: string): Promise<number>
  jobLogs(ref: string, tail: number): Promise<string>
  stopJob(ref: string): Promise<void>
  removeJob(ref: string): Promise<void>

  // systems — provider-native isolation + member DNS
  ensureSystem(name: string, members: string[]): Promise<void>
  removeSystem(name: string): Promise<void>

  // data
  ensurePostgres?(appName: string): Promise<string>         // DATABASE_URL
}
```

**Builds stay local.** Every slab node has Docker; providers don't build.
The daemon builds with the local engine, then — when the target isn't
local — pushes to the provider's `registry()` and hands `deploy()` the
remote ref. One build path, N run paths.

## targeting

- `slab.toml` gains `target = "aws"` (default `"docker"`); CLI gains
  `slab deploy --target aws`, mirroring `--node`. Per-app, so one system
  can mix targets (see trunks below).
- `AppRecord` gains `target: string`, `ref: string | null`,
  `endpoint: string | null` (deprecating `containerId`/`hostPort` — the
  docker provider returns `endpoint: "127.0.0.1:<port>"` so the proxy
  change is one line).
- Provider configs live in `~/.slab/providers.toml`:

```toml
[aws]
region = "us-east-1"
profile = "slab"        # never store raw keys in slab state
```

## worked example: the aws provider (as shipped)

The core design rule this provider proved out: **the manifest's intent
picks the substrate** — users and agents never choose an AWS service.

| slab concept | AWS rendering |
|---|---|
| service (public) | **App Runner** — stable random https URL, `stop` = pause (compute → $0) |
| function | **Lambda** container + Function URL — native wake-on-request, $0 idle (images need the aws-lambda-web-adapter) |
| `public = false` | **Fargate** service — BETA; the real systems/isolation story (Cloud Map namespace + per-system security groups) is future work |
| job | ECS `runTask`; `waitJob` polls `stoppedAt`; logs via CloudWatch — *not built yet* |
| image | always built/pulled as linux/amd64 and pushed to ECR (`resolveImage`) — App Runner/Lambda are ECR-only, and uniform arch kills platform bugs |
| ingress | the local proxy dials the substrate endpoint (https + changeOrigin) — `app.localhost:8080` keeps working from your machine |
| postgres | RDS serverless v2 — *not built yet*; wire a managed DB via secrets |
| secrets/wires | plain env at deploy (SSM later) |
| teardown | `remove()` deletes the service/function; **TTL/budget guardrails (roadmap #4) are mandatory for cloud targets** — a forgotten cloud service costs real money in a way a forgotten container doesn't |

**Trunks across substrates:** a system spanning your laptop and AWS is just
a waffle slab where one node's "bridge" is a Cloud Map namespace. The trunk
already speaks plain TCP with a token preamble; the AWS side runs it as one
more Fargate task. Not v1, but nothing in the design blocks it.

### auth: the user's account, the node's identity

slab holds no cloud credentials, ever. The v1 aws provider shells out to
the operator's own `aws` CLI, so calls run as whatever identity already
exists — `aws configure` keys, an SSO profile, env vars, or (the best
case) the **IAM instance role of an EC2-hosted slab node**: the standard
credential chain resolves it automatically, zero keys stored anywhere.
`~/.slab/providers.toml` names a profile/region at most.

**Roadmap: native SDK implementation.** Replace CLI shell-outs with AWS
SDK calls — same Provider surface, no `aws` binary dependency, faster
(no process spawn per call), and the node's IAM role remains the intended
credential source. The docs ship a least-privilege policy for the role
(ECS/ECR/CloudWatch Logs/EC2-describe/IAM-passrole on slab-prefixed
resources).

## plugin packaging — three phases

1. **Now (in-tree):** providers are TS modules in `src/providers/<name>.ts`
   implementing `Provider`, registered in a map. Contribution = one PR.
   The docker engine gets refactored into `src/providers/docker.ts` as the
   reference implementation.
2. **Soon (out-of-tree):** the daemon dynamic-imports
   `~/.slab/providers/<name>/index.js` (own `package.json`, own deps — the
   AWS SDK never enters slab's tree). Same interface, no slab rebuild.
3. **v1.0 (out-of-process):** the Go rewrite ships a stdio JSON-RPC plugin
   protocol whose messages are these same method signatures. Because v1 is
   wire-safe, phase-2 plugins port mechanically; partners can also write
   providers in Go/Python/anything.

## conformance: examples/ is the acceptance suite

A provider is done when `slab provider test <name>` passes — a harness that
runs the standing examples against the target and tears everything down:

1. deploy `examples/hello-service` → endpoint answers 200
2. deploy `examples/hello-fn` → sleeps after idle, wakes on request
   (skipped without the `functions` capability)
3. `slab run` a job → exit code 0 propagates, logs retrievable, timeout kills
4. `slab up examples/trunk-demo`-style system → private member unreachable
   publicly, reachable by name from a member
5. `slab rm` / `system rm` → **nothing left billing** (the harness asserts
   resource counts return to baseline)

Passing output pasted into the PR is the review artifact.

## open questions

- **Function wake latency** — the local proxy waits 15s; Lambda is fine,
  Fargate cold-start isn't. Per-provider wake budgets?
- **Who owns DNS for cloud endpoints** — keep everything behind the local
  ingress (works today, single point of failure) vs. teach `slab url` to
  return provider-native URLs (App Runner/Lambda URLs) directly?
- **State reconciliation** — boot-time reconcile currently asks Docker
  what's really running; providers need a `list()` for drift detection.
- **Cost visibility** — should `slab list` show a $/day estimate column for
  non-docker targets? (Probably yes; agents should see cost as a signal.)

## contributing a provider — the short version

1. Read this doc; open an issue claiming `provider: <name>`.
2. Implement `Provider` (start by copying `src/providers/docker.ts`).
3. Declare capabilities honestly — a services-only provider is welcome.
4. Pass the conformance run; paste output in the PR.
5. Add `docs/providers/<name>.md`: config keys, IAM/permissions needed,
   cost characteristics, and the capability matrix.
