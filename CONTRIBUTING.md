# contributing to slab

slab is v0 and moving fast — small, focused PRs land quickest. Open an
issue first for anything bigger than a fix so we don't collide.

## dev setup

```bash
git clone https://github.com/jasonmimick/slab.git && cd slab
npm install
npm run build          # tsc + a parse-check of the dashboard's embedded JS
node dist/daemon.js    # api :7766 · ingress :8080 (needs docker running)
node dist/cli.js deploy examples/hello-fn
```

The daemon, CLI, MCP server, and dashboard are one TypeScript build; the
dashboard is a single served HTML string (`src/dashboard.ts`) — zero
frontend build step, on purpose.

## how to verify changes

`examples/` doubles as the acceptance suite. Before a PR, exercise what you
touched end-to-end: deploy an example, hit it through the ingress
(`curl http://<app>.localhost:8080`), check the dashboard. For cluster/trunk
changes, run a second daemon on one machine (`SLAB_DIR=~/.slab-b
SLAB_PORT=7866 SLAB_PROXY_PORT=8180 node dist/daemon.js`) and use
`examples/trunk-demo`.

## the map

| area | files |
|---|---|
| contracts (start here) | `src/types.ts` |
| daemon + HTTP API | `src/daemon.ts` |
| docker engine | `src/engine.ts` |
| ingress proxy | `src/proxy.ts` |
| CLI | `src/cli.ts` |
| MCP tools | `src/mcp.ts` |
| dashboard | `src/dashboard.ts` |
| trunks (cross-node) | `src/trunk.ts`, [docs/design/trunks.md](docs/design/trunks.md) |

## cloud providers

Want `slab deploy --target fly|gcp|…`? That's the most valuable
contribution surface. The **aws provider is the shipped reference**
(`src/providers/aws.ts` — intent-routed: services → App Runner, functions
→ Lambda) behind the Provider interface in `src/providers/provider.ts`.
Read [docs/design/providers.md](docs/design/providers.md) for the API
rules (wire-safe JSON, refs + endpoints, declared capabilities) and the
conformance checklist, then open a `provider: <name>` issue.

## style

- Match what's around you; comments state constraints the code can't.
- Commit messages: lowercase, narrative, say what shipped.
- Tool descriptions in `src/mcp.ts` are product UX for agents — write them
  as the entire interface contract.
- The dashboard's rack metaphor is load-bearing: new UI should be hardware
  (units, bays, patch cables, trunks), and screens stay dark glass in every
  skin.
