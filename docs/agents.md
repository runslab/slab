# agents

slab has a first-class MCP server (`src/mcp.ts`, built to `dist/mcp.js`)
that exposes the same operations as the CLI and HTTP API as tools, so an AI
agent can deploy, operate, and debug apps on slab without shelling out. It
talks to the daemon exactly like the CLI does — over HTTP to
`127.0.0.1:7766` (or `$SLAB_DAEMON_URL`) — via a shared client, so the
daemon must be running (`slab daemon`) for any tool call to succeed.

It's a stdio server: it never writes to stdout except the MCP protocol
itself (all diagnostics go to stderr), so it's safe to wire into any MCP
client that speaks stdio.

## registering it

Add an entry to `.mcp.json` (Claude Code, or any MCP-compatible client that
reads this format):

```json
{
  "mcpServers": {
    "slab": {
      "command": "node",
      "args": ["/absolute/path/to/slab/dist/mcp.js"]
    }
  }
}
```

Build first (`npm run build`) so `dist/mcp.js` exists. There are no
required env vars; set `SLAB_DAEMON_URL` only if the daemon isn't on the
default `127.0.0.1:7766`.

## tool list

All named `slab_*`, all returning JSON (either the result or an error
string with `isError: true`):

| tool | description |
|---|---|
| `slab_list` | List every app registered with slab, with its type, current state, URL, and last deploy time. Use this first to see what exists before deploying, stopping, or inspecting a specific app. |
| `slab_create` | Register a new app with slab from a source directory or a git repository URL. The source must contain a slab.toml manifest. Does not build or start the app — call slab_deploy afterward to run it. |
| `slab_deploy` | Build and run an app on slab. Use after creating or changing an app. Pass name for a known app, sourceDir to deploy from a directory, or gitUrl to deploy straight from a git repository (auto-created and cloned if not already registered; pulled on every redeploy). Returns the app record including its URL. |
| `slab_stop` | Stop a running app's container without removing it. The app record and its data are preserved; use slab_start to resume it. |
| `slab_start` | Start a previously stopped app's existing container (does not rebuild). Use slab_deploy instead if the app has code changes to pick up. |
| `slab_remove` | Permanently stop and delete an app: removes its container and its record from slab. This cannot be undone. |
| `slab_logs` | Fetch recent container logs for an app. Use to debug a failed deploy or investigate runtime errors. |
| `slab_secret_set` | Set one or more secret env vars for an app (merged into existing secrets). Values are never returned by any tool once set. Redeploy the app for new secret values to take effect in a running container. |
| `slab_secret_list` | List the names of secrets configured for an app. Never returns values — use this to check what is set before calling slab_secret_set. |
| `slab_status` | Check whether the slab daemon is running and healthy, and how many apps it manages. Use this to diagnose "daemon not reachable" errors before anything else. |
| `slab_url` | Get the public URL an app is reachable at through the slab ingress proxy. Use this after a deploy to know where to send requests. |
| `slab_expose` | Give an app a public HTTPS URL on the internet via a Cloudflare quick tunnel (free, no account). Use when the app must receive webhooks or be reachable from outside this machine. The URL changes each time the tunnel reopens. |
| `slab_hide` | Close an app's public tunnel so it is reachable only locally again. |
| `slab_run` | Run a job to completion in an isolated container and return exit code + logs in one blocking call. Dockerfile mode or stock `image` with the source mounted at `/workspace`. The `systems` param joins the job to system networks — the sandbox for working ON a system. |
| *(target param)* | `slab_create`/`slab_deploy` take `target: "aws"` — the agent never learns AWS: the manifest's `type`/`public` pick App Runner vs Lambda vs Fargate, in the operator's own account. |
| `slab_jobs` | List jobs (state, exit code, command, timings), newest first. |
| `slab_system_deploy` | Create/update + deploy a system from a `sourceFile` **or an inline `manifest`** — agents never need to write files. Members deploy in dependency order; placed members go to their nodes; trunks start automatically. |
| `slab_system_list` | List systems: members, wires, last deploy. |

## a realistic workflow

An agent asked to stand up a webhook receiver from a git repo might do:

1. **`slab_deploy`** with `{ "gitUrl": "owner/webhook-service" }` — no name
   yet, so the tool auto-creates the app (cloning to `~/.slab/repos`,
   reading `slab.toml` for the real name), then builds and starts it.
   Returns the app record, including `state` and, once running, its local
   URL.
2. If `state` comes back `"error"`, **`slab_logs`** with the app name to
   read the container's stdout/stderr and figure out what broke (bad
   `Dockerfile`, missing secret, wrong port) before retrying `slab_deploy`.
3. **`slab_expose`** with the app name to open a Cloudflare quick tunnel so
   the external service can actually reach the webhook endpoint. The tool
   returns `publicUrl` — that's what gets registered with the webhook
   sender.
4. Later, **`slab_secret_set`** to add a signing secret the handler needs,
   followed by another **`slab_deploy`** (by name — no need to re-pass
   `gitUrl`) so the new value actually reaches the running container.

Every step above returns structured JSON an agent can branch on
(`state`, `error`, `publicUrl`) rather than text an agent has to parse.

## working ON a system — the sandbox pattern

"Fix the ssl bug in system `arcade`" decomposes into primitives that all
exist today:

1. **`slab_system_list`** — find `arcade`: members, wires, which member is
   private, where each lives (`memberNodes`).
2. **`slab_run`** with `{ "systems": ["arcade"], "image": "alpine:3",
   "command": ["wget", "-qO-", "http://scoreboard:4000/health"] }` — probe
   the real member over the real wiring. `systems` puts the job container
   ON the system's private network (trunks carry it across nodes), so even
   `public = false` members answer by name. Exit code + logs come back in
   the same call.
3. Each member's app record carries its `gitUrl` — clone, patch, push.
4. **`slab_deploy`** (or `slab_system_deploy`) to roll the fix out, then
   re-probe with another `slab_run`.

Guardrails an agent inherits for free: job timeouts (default 30m), bounded
job history, and wire changes via `PUT /v1/systems/:name/wires` that
auto-redeploy affected members.

## design principle

**Tool descriptions are the product's UX for agents.** There's no docs site
an agent reads before acting — the string in `description` on each
`registerTool` call in `src/mcp.ts` *is* what the agent sees before
deciding whether and how to call it. That's why each one names the
preconditions (`slab_secret_set` tells you to redeploy afterward),
disambiguates near-duplicates (`slab_stop` vs `slab_remove`; `slab_start`
vs `slab_deploy`), and states what it returns. When adding a tool, write
the description as the entire interface contract — an agent will never read
this file to find out what you meant.
