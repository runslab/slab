// slab — the single binary: CLI verbs, the daemon, and the MCP agent
// server in one static executable.
//
//	slab daemon      run the daemon (api + ingress + dashboard)
//	slab mcp         run the MCP stdio server (agents drive slab through it)
//	slab <verb> …    everything else: create, deploy, up, run, list, …
//
// Parity ladder (scripts/conformance.js gates it, DAEMON_CMD="go/bin/slab daemon"):
//
//	rung 0-4  manifest → apps → systems → jobs → secrets/postgres/wake/auth/peers/fleet/trunks ✓
//	rung 5    git sources ✓ · source jobs ✓ · tunnels ✓ · dashboard ✓ · MCP ✓ · CLI ✓ · providers (pending)
package main

import (
	"log"
	"os"

	"github.com/runslab/slab/go/internal/cli"
	"github.com/runslab/slab/go/internal/daemon"
	"github.com/runslab/slab/go/internal/mcpserver"
)

// version is stamped by the release build: -ldflags "-X main.version=v0.2.0"
var version = "dev"

func main() {
	cli.Version = version
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "daemon":
			daemon.Run(version)
			return
		case "mcp":
			if err := mcpserver.Run(version); err != nil {
				log.Fatal(err)
			}
			return
		}
	}
	cli.Run(os.Args[1:])
}
