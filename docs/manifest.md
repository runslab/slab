# slab.toml reference

Every app is a directory containing a `slab.toml` (parsed with `smol-toml`)
plus, unless `image` is set, a `Dockerfile`. This is the full field list, as
enforced by `loadManifest` in `src/manifest.ts` against the `Manifest`
interface in `src/types.ts`.

## no slab.toml? inference

`slab.toml` is optional when the directory has a `Dockerfile` — any random
GitHub repo deploys as-is: `slab deploy https://github.com/docker/welcome-to-docker`.
slab infers a manifest:

- `name` — the directory / repo name, sanitized to the name rules
- `type` — `service`
- `port` — the Dockerfile's first `EXPOSE`, else `3000`; `PORT` is injected
  as an env var so apps that read it listen where slab expects

Add a real `slab.toml` (`slab init`) whenever you need anything beyond the
defaults (functions, postgres, secrets, private members).

## `name` (required)

```toml
name = "hello-service"
```

Must match `^[a-z][a-z0-9-]{1,30}$` — starts with a lowercase letter,
followed by 1–30 more lowercase letters, digits, or hyphens (2–31 characters
total). This becomes the app's hostname (`<name>.localhost`), its container
name (`slab-<name>`), and its Docker label value (`slab.app=<name>`).
Anything else is rejected at create/deploy time with `Invalid app name
"..." — lowercase letters, digits, hyphens, 2-31 chars`.

## `target` (optional, default `"docker"`)

```toml
target = "aws"
```

Where the app runs. Omit for this node's local Docker engine. `"aws"`
renders the app onto AWS **in your own account** — and the substrate is
picked from your intent, never named: services get App Runner (stable
https URL), functions get Lambda (true scale-to-zero), `public = false`
gets Fargate (beta). See [providers/aws.md](providers/aws.md). Also
settable at create time with `slab deploy <src> --target aws`; changing an
existing app's target requires `slab rm` first.

## `type` (optional, default `"service"`)

```toml
type = "service"   # or "function"
```

Anything other than the literal string `"function"` is treated as
`"service"` — there's no validation error for a typo here, it just silently
falls back to `service`.

- **`service`** — always-on. The container is created with Docker restart
  policy `unless-stopped` and is never touched by the idle reaper.
- **`function`** — scale-to-zero. Restart policy is `no`; the daemon's idle
  reaper stops the container after `idle_timeout` of no requests, and the
  ingress proxy starts it again (wake-on-request) the next time traffic
  arrives for it.

## `port` (required)

```toml
port = 3000
```

The port the app listens on **inside** the container. Must be an integer in
`1–65535`. slab allocates and maps an external host port for you starting
at `20000` (`AppRecord.hostPort`) — you never set the host port yourself.

## `image` vs Dockerfile build

```toml
image = "nginx:alpine"    # prebuilt — slab does `docker pull`, no build
```

If `image` is set, slab pulls that image and runs it directly — any
`Dockerfile` present in the source directory is ignored. **`image` always
wins over a Dockerfile** when both exist.

If `image` is omitted, the source directory **must** contain a `Dockerfile`;
slab builds it and tags the result `slab/<name>:<version>` (version
increments on every deploy). If neither `image` nor a `Dockerfile` exists,
`loadManifest` throws: `<dir> has neither an "image" in slab.toml nor a
Dockerfile`.

## `postgres` (optional, default `false`)

```toml
postgres = true
```

Must be the literal boolean `true` (anything else, including the string
`"true"`, is treated as `false`). When enabled, every deploy:

1. Ensures a single shared `slab-postgres` container is running
   (`postgres:16-alpine`, named `slab-postgres`, volume `slab-pgdata`, bound
   to host port `20432`, credentials `slab`/`slab`).
2. Waits for it to report ready (`pg_isready`, up to 30s).
3. Ensures a database named `slab_<name>` exists, with hyphens in the app
   name converted to underscores (e.g. app `hello-service` → database
   `slab_hello_service`).
4. Injects `DATABASE_URL` into the container's env:

```
postgresql://slab:slab@host.docker.internal:20432/slab_<name>
```

**`host.docker.internal` caveat:** this hostname is resolved from inside
the *app's* container back to the Docker host, where `slab-postgres`'s port
is published. Docker Desktop (macOS/Windows) provides `host.docker.internal`
out of the box, so this works with no extra configuration. On Linux Docker
engines it is often not defined by default — if your app can't reach
Postgres there, you'll need to add the host gateway yourself (e.g. an
`extra_hosts: host.docker.internal:host-gateway` equivalent), since slab
does not currently add that mapping for you.

## `secrets` (optional, default `[]`)

```toml
secrets = ["API_KEY", "OTHER_SECRET"]
```

A list of env var names the app *expects*. This is documentation only —
slab does not validate that listed names actually have values set, and it
does not restrict which secrets get injected to only those named here.
Whatever key/value pairs exist in `~/.slab/secrets/<name>.json` (set via
`slab secret set <name> KEY=VALUE`) are injected into the container's env
on every deploy, regardless of what's listed in this array. Values are
never stored in `slab.toml` and are never returned by any CLI command, API
route, or MCP tool — only key names are ever listed.

## `env` (optional, default `{}`)

```toml
[env]
NODE_ENV = "production"
LOG_LEVEL = "info"
```

Static, non-secret env vars, written directly in the manifest and versioned
with the app. All values are coerced to strings. Merged into the
container's env first; secrets and (if `postgres = true`) `DATABASE_URL`
are layered on top, so a secret with the same key name as an `env` entry
wins.

## `idle_timeout` (optional, default `"5m"`, functions only)

```toml
idle_timeout = "30s"   # or "5m", "1h"
```

Format is `<integer><unit>` with unit `s` (seconds), `m` (minutes), or `h`
(hours) — no spaces, no combined units. Only meaningful for `type =
"function"`; ignored for services since they never sleep. An unparseable
value silently falls back to the 5-minute default rather than erroring.

---

## full annotated example — service

```toml
# slab.toml — always-on app, built from a local Dockerfile
name = "hello-service"
type = "service"
port = 3000
postgres = true
secrets = ["API_KEY"]

[env]
NODE_ENV = "production"
```

Paired with a `Dockerfile` in the same directory. Every deploy builds
`slab/hello-service:<version>`, ensures a `slab_hello_service` Postgres
database, and runs the container with restart policy `unless-stopped` — it
stays up until you `slab stop` or `slab rm` it.

## full annotated example — function

```toml
# slab.toml — scale-to-zero app, prebuilt image, no Dockerfile needed
name = "hello-fn"
type = "function"
image = "nginx:alpine"
port = 80
idle_timeout = "1m"
```

No build step — `docker pull nginx:alpine` and run. The idle reaper checks
every 30s; after 1 minute with no requests the container is stopped
(`state` becomes `sleeping`). The next request to `hello-fn.localhost:8080`
starts the container again and waits for it to answer before forwarding.
