// slabd — the Go slab daemon. Parity ladder (scripts/conformance.js is the
// gate; run with DAEMON_CMD="go/bin/slabd"):
//
//	rung 0  manifest parsing                                  ✓
//	rung 1  state + engine + app lifecycle + ingress          ✓
//	rung 2  systems, wires, private members, builds           ✓
//	rung 3  jobs                                              ✓
//	rung 4  secrets, postgres, wake/sleep, auth, peers, fleet ← here
//	rung 5  trunks, tunnels, MCP, providers, dashboard
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/runslab/slab/go/internal/api"
	"github.com/runslab/slab/go/internal/engine"
	"github.com/runslab/slab/go/internal/manifest"
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
	node, err := state.EnsureNode()
	if err != nil {
		log.Fatalf("node identity: %v", err)
	}
	eng, err := engine.New()
	if err != nil {
		log.Fatalf("docker: %v", err)
	}

	apiPort := envPort("SLAB_PORT", 7766)
	proxyPort := envPort("SLAB_PROXY_PORT", 8080)
	bind := os.Getenv("SLAB_BIND")
	if bind == "" {
		bind = "127.0.0.1"
	}

	srv := &api.Server{St: st, Eng: eng, NodeName: node.Name, Token: node.Token, ProxyPort: proxyPort}

	go idleReaper(st, eng)

	go func() {
		log.Printf("ingress :%d", proxyPort)
		log.Fatal(http.ListenAndServe(fmt.Sprintf("%s:%d", bind, proxyPort), (&proxy.Proxy{St: st, Eng: eng}).Handler()))
	}()

	log.Printf("slabd (go) node %q api %s:%d", node.Name, bind, apiPort)
	log.Fatal(http.ListenAndServe(fmt.Sprintf("%s:%d", bind, apiPort), srv.Auth(srv.Handler())))
}

// idleReaper puts idle functions to sleep — same 30s cadence as the TS
// daemon (SLAB_IDLE_REAP_MS overrides, mainly for the conformance harness).
func idleReaper(st *state.State, eng *engine.Engine) {
	ctx := context.Background()
	tick := 30 * time.Second
	if ms := envPort("SLAB_IDLE_REAP_MS", 0); ms > 0 {
		tick = time.Duration(ms) * time.Millisecond
	}
	for range time.Tick(tick) {
		type target struct{ name string }
		var victims []target
		st.Records.RLock()
		for _, a := range st.Apps {
			if a.Manifest == nil || a.Manifest.Type != "function" || a.State != state.Running || a.LastRequestAt == nil {
				continue
			}
			last, err := time.Parse("2006-01-02T15:04:05.000Z", *a.LastRequestAt)
			if err != nil {
				continue
			}
			idleFor := time.Since(last)
			timeout := manifest.ParseDuration(a.Manifest.IdleTimeout)
			if idleFor >= timeout {
				victims = append(victims, target{a.Name})
			}
		}
		st.Records.RUnlock()
		for _, v := range victims {
			if err := eng.Stop(ctx, v.name); err != nil {
				log.Printf("idle reaper: failed to stop %s: %v", v.name, err)
				continue
			}
			st.Records.Lock()
			if rec := st.Apps[v.name]; rec != nil {
				rec.State = state.Sleeping
			}
			st.Records.Unlock()
			_ = st.Save()
			log.Printf("idle reaper: %s -> sleeping", v.name)
		}
	}
}
