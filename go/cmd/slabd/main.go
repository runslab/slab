// slabd — the Go slab daemon. Parity ladder (scripts/conformance.js is the
// gate; run with DAEMON_CMD="go/bin/slabd"):
//
//	rung 0  manifest parsing                      ✓ internal/manifest
//	rung 1  state + engine + app lifecycle + ingress   ← here
//	rung 2  systems: networks, wires, private members; Dockerfile builds
//	rung 3  jobs
//	rung 4  trunks, peers, fleet
//	rung 5  tunnels, MCP, providers, dashboard
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/runslab/slab/go/internal/api"
	"github.com/runslab/slab/go/internal/engine"
	"github.com/runslab/slab/go/internal/proxy"
	"github.com/runslab/slab/go/internal/state"
)

func envPort(name string, fallback int) int {
	if v := os.Getenv(name); v != "" {
		var p int
		if _, err := fmt.Sscanf(v, "%d", &p); err == nil {
			return p
		}
	}
	return fallback
}

func main() {
	st, err := state.Load()
	if err != nil {
		log.Fatalf("state: %v", err)
	}
	if _, err := state.EnsureNode(); err != nil {
		log.Fatalf("node identity: %v", err)
	}
	eng, err := engine.New()
	if err != nil {
		log.Fatalf("docker: %v", err)
	}

	apiPort := envPort("SLAB_PORT", 7766)
	proxyPort := envPort("SLAB_PROXY_PORT", 8080)

	go func() {
		log.Printf("ingress :%d", proxyPort)
		log.Fatal(http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", proxyPort), (&proxy.Proxy{St: st}).Handler()))
	}()

	log.Printf("slabd (go) api :%d", apiPort)
	log.Fatal(http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", apiPort), (&api.Server{St: st, Eng: eng}).Handler()))
}
