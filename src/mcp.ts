// slab — MCP server over stdio. Exposes slab to AI agents (e.g. `claude mcp add slab`).
//
// The MCP SDK is ESM-only while this project compiles to CommonJS, so the SDK
// is loaded via dynamic import() inside main(). zod is CJS-compatible and can
// be imported normally.
//
// IMPORTANT: this is a stdio server — stdout is the wire protocol. Never
// console.log. All diagnostics go to stderr via console.error.

import { z } from 'zod'
import { client, appUrl } from './api-client'
import { AppRecord } from './types'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text', text: message }], isError: true }
}

function summarize(app: AppRecord) {
  return {
    name: app.name,
    type: app.manifest.type,
    state: app.state,
    url: app.hostPort ? `http://${app.name}.localhost` : null,
    lastDeploy: app.deployedAt,
  }
}

async function main() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  const server = new McpServer({ name: 'slab', version: '0.1.0' })

  server.registerTool(
    'slab_list',
    {
      description:
        'List every app registered with slab, with its type, current state, URL, and last deploy time. Use this first to see what exists before deploying, stopping, or inspecting a specific app.',
      inputSchema: {},
    },
    async () => {
      try {
        const { apps } = await client.listApps()
        return ok(apps.map(summarize))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_create',
    {
      description:
        'Register a new app with slab from a source directory or a git repository URL. The source must contain a slab.toml manifest. Does not build or start the app — call slab_deploy afterward to run it.',
      inputSchema: {
        sourceDir: z.string().optional().describe('Absolute path to the app source directory containing slab.toml'),
        gitUrl: z.string().optional().describe('Git repository URL (https://, git@, or shorthand owner/repo); slab clones it and pulls on each deploy'),
      },
    },
    async ({ sourceDir, gitUrl }) => {
      try {
        const { app } = await client.createApp(gitUrl ? { gitUrl } : { sourceDir })
        return ok(app)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_deploy',
    {
      description:
        'Build and run an app on slab. Use after creating or changing an app. Pass name for a known app, sourceDir to deploy from a directory, or gitUrl to deploy straight from a git repository (auto-created and cloned if not already registered; pulled on every redeploy). Returns the app record including its URL.',
      inputSchema: {
        name: z.string().optional().describe('Name of an already-registered app to deploy'),
        sourceDir: z
          .string()
          .optional()
          .describe('Absolute path to the app source directory; used to auto-create the app if not yet registered'),
        gitUrl: z.string().optional().describe('Git repository URL; the app is auto-created from the repo if not yet registered'),
      },
    },
    async ({ name, sourceDir, gitUrl }) => {
      try {
        let appName = name
        if (!appName && gitUrl) {
          const { app } = await client.createApp({ gitUrl }).catch(async (e: Error) => {
            if (!/exists/.test(e.message)) throw e
            const m = /app "([^"]+)"/.exec(e.message)
            return client.getApp(m ? m[1] : gitUrl)
          })
          appName = app.name
        }
        if (!appName) {
          if (!sourceDir) throw new Error('Provide name, sourceDir, or gitUrl')
          try {
            const { app } = await client.getApp(sourceDirToName(sourceDir))
            appName = app.name
          } catch {
            const { app } = await client.createApp({ sourceDir })
            appName = app.name
          }
        }
        const { app } = await client.deploy(appName)
        return ok(app)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_stop',
    {
      description: 'Stop a running app\'s container without removing it. The app record and its data are preserved; use slab_start to resume it.',
      inputSchema: { name: z.string().describe('App name') },
    },
    async ({ name }) => {
      try {
        const { app } = await client.stop(name)
        return ok(app)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_start',
    {
      description: 'Start a previously stopped app\'s existing container (does not rebuild). Use slab_deploy instead if the app has code changes to pick up.',
      inputSchema: { name: z.string().describe('App name') },
    },
    async ({ name }) => {
      try {
        const { app } = await client.start(name)
        return ok(app)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_remove',
    {
      description: 'Permanently stop and delete an app: removes its container and its record from slab. This cannot be undone.',
      inputSchema: { name: z.string().describe('App name') },
    },
    async ({ name }) => {
      try {
        await client.removeApp(name)
        return ok({ removed: name })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_logs',
    {
      description: 'Fetch recent container logs for an app. Use to debug a failed deploy or investigate runtime errors.',
      inputSchema: {
        name: z.string().describe('App name'),
        tail: z.number().int().positive().optional().describe('Number of recent log lines to return (default 100)'),
      },
    },
    async ({ name, tail }) => {
      try {
        const { logs } = await client.logs(name, tail ?? 100)
        return ok({ logs })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_secret_set',
    {
      description: 'Set one or more secret env vars for an app (merged into existing secrets). Values are never returned by any tool once set. Redeploy the app for new secret values to take effect in a running container.',
      inputSchema: {
        name: z.string().describe('App name'),
        values: z.record(z.string(), z.string()).describe('Map of secret env var name to value'),
      },
    },
    async ({ name, values }) => {
      try {
        await client.setSecrets(name, values)
        return ok({ name, keys: Object.keys(values) })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_secret_list',
    {
      description: 'List the names of secrets configured for an app. Never returns values — use this to check what is set before calling slab_secret_set.',
      inputSchema: { name: z.string().describe('App name') },
    },
    async ({ name }) => {
      try {
        const { keys } = await client.listSecretKeys(name)
        return ok({ name, keys })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_status',
    {
      description: 'Check whether the slab daemon is running and healthy, and how many apps it manages. Use this to diagnose "daemon not reachable" errors before anything else.',
      inputSchema: {},
    },
    async () => {
      try {
        const health = await client.health()
        return ok(health)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_url',
    {
      description: 'Get the public URL an app is reachable at through the slab ingress proxy. Use this after a deploy to know where to send requests.',
      inputSchema: { name: z.string().describe('App name') },
    },
    async ({ name }) => {
      try {
        const { app } = await client.getApp(name)
        const { proxyPort } = await client.health()
        return ok({ name, url: appUrl(app, proxyPort), publicUrl: app.publicUrl })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_expose',
    {
      description: 'Give an app a public HTTPS URL on the internet via a Cloudflare quick tunnel (free, no account). Use when the app must receive webhooks or be reachable from outside this machine. The URL changes each time the tunnel reopens.',
      inputSchema: { name: z.string().describe('App name') },
    },
    async ({ name }) => {
      try {
        const { app } = await client.expose(name)
        return ok({ name, publicUrl: app.publicUrl })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'slab_hide',
    {
      description: 'Close an app\'s public tunnel so it is reachable only locally again.',
      inputSchema: { name: z.string().describe('App name') },
    },
    async ({ name }) => {
      try {
        await client.hide(name)
        return ok({ name, hidden: true })
      } catch (err) {
        return fail(err)
      }
    }
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('slab mcp server connected (stdio)')
}

// Best-effort name derivation from a source directory, mirroring the CLI's
// convention of naming an app after its directory basename. Only used to
// probe for an existing app before falling back to createApp, which reads
// the authoritative name from slab.toml.
function sourceDirToName(sourceDir: string): string {
  const trimmed = sourceDir.replace(/\/+$/, '')
  const parts = trimmed.split('/')
  return parts[parts.length - 1] || trimmed
}

main().catch((err) => {
  console.error('slab mcp server failed to start:', err)
  process.exit(1)
})
