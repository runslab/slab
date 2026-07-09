# getting started

## install

```bash
curl -fsSL https://raw.githubusercontent.com/jasonmimick/slab/master/install.sh | bash
```

The installer checks prerequisites (Docker with the engine running,
Node ≥ 20, git; `cloudflared` optional — only `slab expose` uses it), clones
slab to `~/.slab/src`, builds it, puts `slab` on your PATH, and starts the
daemon. **Upgrading later is one command:** `slab upgrade` (git pull +
rebuild + daemon restart; all state and config survive).

The daemon is one process serving the HTTP API on `:7766` and the ingress
proxy on `:8080`. On boot it reconciles `~/.slab/state.json` against what
Docker actually reports and reopens tunnels for exposed apps. The CLI, the
dashboard, and the MCP server are all just clients of it.

Open the dashboard: **http://localhost:7766** — every app is a rack unit
(power button, VU meter, live thumbnail); flip a faceplate for its board.

## deploy something — no config needed

Any repo with a `Dockerfile` deploys as-is:

```bash
slab deploy dockersamples/linux_tweet_app     # owner/repo shorthand
slab deploy https://github.com/you/yourapp    # full URL (private repos use your git creds)
slab deploy ./myapp                           # local directory
```

Without a `slab.toml`, slab infers one: name from the repo, port from the
Dockerfile's `EXPOSE` (else 3000), `PORT` injected. From the dashboard, the
**⊕ empty bay** at the foot of the rack does the same thing — paste a URL,
`mount + deploy`.

```
deployed linux-tweet-app -> http://linux-tweet-app.localhost:8080 (v1)
```

## slab.toml — when you want more

Add a manifest for functions, postgres, secrets, or privacy
(`slab init` scaffolds one; full reference: [manifest.md](manifest.md)):

```toml
name = "hello-fn"
type = "function"        # scale-to-zero; "service" = always-on
image = "nginx:alpine"   # or omit and provide a Dockerfile
port = 80
idle_timeout = "1m"
postgres = false         # true -> DATABASE_URL appears at deploy
```

## routes

The ingress on `:8080` routes by `Host` header: `<name>.localhost:8080`
(or `<name>.slab:8080`) → the app. One app, one hostname; unknown hosts get
`404`.

```bash
curl http://hello-fn.localhost:8080/
```

## the everyday verbs

```bash
slab list                          # the rack, in text
slab logs hello-fn -n 500          # live from docker, stdout+stderr
slab stop hello-fn · slab start hello-fn
slab rm hello-fn                   # container + record + secrets (source untouched)
slab url hello-fn
slab status                        # daemon health + node name
```

## secrets

```bash
slab secret set hello-fn API_KEY=sk-123
slab secret ls hello-fn            # names only — values never come back
```

Stored in `~/.slab/secrets/<app>.json` (chmod 600), merged into the env at
container creation — **redeploy after setting** for values to take effect.

## public tunnels

```bash
slab expose hello-fn     # -> https://random-words.trycloudflare.com
slab hide hello-fn
```

Free Cloudflare quick tunnels, no account. URLs rotate every time a tunnel
(re)opens — including on daemon restart — so treat them as ephemeral.

## functions: scale-to-zero

`type = "function"` apps are stopped after `idle_timeout` (default `5m`)
with no requests, and woken by the ingress on the next one — it starts the
container and polls until the app answers before forwarding (15s budget,
then `502`). Services never sleep (`unless-stopped`).

## jobs: run-to-completion

```bash
slab run . -- npm test                       # build the Dockerfile, run the command
slab run . --image node:20 -- npm test       # stock image, source mounted at /workspace
```

Exit codes propagate, logs are kept, a timeout guardrail reaps runaways.
Full guide: [jobs.md](jobs.md).

## systems: apps wired together

```bash
slab up ./system.toml
```

A system puts members on a private Docker network (they reach each other at
`http://<member>:<port>`), injects `[wires]` env bindings, and members with
`public = false` get **no host port at all**. Or build one from the
dashboard: empty bay → **rack up a system**, then patch wires in the
workbench. Design: [design/systems.md](design/systems.md). Systems can span
machines: [cluster.md](cluster.md) + [design/trunks.md](design/trunks.md).

## the cloud as a target

```bash
slab deploy ./myapp --target aws     # or target = "aws" in slab.toml
```

Same manifest, rendered onto AWS **in your own account** (no stored keys —
slab uses your `aws` CLI identity): services become App Runner (stable
https URL), functions become Lambda (true scale-to-zero). Your local
ingress still fronts them. Guide: [providers/aws.md](providers/aws.md).

## more machines

One line installs slab on the next machine; a couple more make them a
cluster — shared dashboard (the solar system), `slab --node <name>`
targeting, jobs scheduled to the least-busy node, systems spanning
machines. See [cluster.md](cluster.md).

## where state lives

Everything is under `~/.slab` (override: `SLAB_DIR`):

- `state.json` — apps, systems, jobs, peers, node name (atomic writes)
- `node.json` — network posture: bind / advertise / token (chmod 600)
- `secrets/<app>.json` — chmod 600, plaintext KEY/VALUE (v0 honesty)
- `repos/<name>` — shallow clones of git-sourced apps, pulled per deploy
- `systems/<name>.toml` — manifests for systems created via dashboard/API
- `trunks/<system>.js` — generated trunk scripts
- `skins/<name>.css` — your custom dashboard skins
- `src/` — slab itself (installer-managed; `slab upgrade` updates it)
- `daemon.log`, `daemon.pid`

## hacking on slab itself

```bash
git clone https://github.com/jasonmimick/slab.git && cd slab
npm install && npm run build
node dist/daemon.js          # api :7766 + ingress :8080
node dist/cli.js deploy examples/hello-fn
```
