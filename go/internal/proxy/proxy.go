// Package proxy is the ingress — Host-header routing to app host ports with
// wake-on-request for functions, mirroring src/proxy.ts.
package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/runslab/slab/go/internal/engine"
	"github.com/runslab/slab/go/internal/state"
)

const wakeTimeout = 15 * time.Second

type Proxy struct {
	St  *state.State
	Eng *engine.Engine
}

func sendJSON(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (p *Proxy) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if i := strings.Index(host, ":"); i >= 0 {
			host = host[:i]
		}
		name, _, _ := strings.Cut(host, ".")

		p.St.Records.Lock()
		rec := p.St.Apps[name]
		if rec != nil {
			now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
			rec.LastRequestAt = &now
		}
		p.St.Records.Unlock()

		if rec == nil {
			sendJSON(w, 404, "unknown app")
			return
		}
		if rec.HostPort == nil {
			sendJSON(w, 503, "app has never been deployed")
			return
		}

		if rec.Manifest != nil && rec.Manifest.Type == "function" && !p.Eng.IsRunning(r.Context(), rec.Name) {
			if err := p.wake(r.Context(), rec); err != nil {
				sendJSON(w, 502, "failed to wake app: "+err.Error())
				return
			}
		}

		target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", *rec.HostPort))
		httputil.NewSingleHostReverseProxy(target).ServeHTTP(w, r)
	})
}

// wake starts the container and polls the host port until it answers.
func (p *Proxy) wake(ctx context.Context, rec *state.AppRecord) error {
	if err := p.Eng.Start(ctx, rec.Name); err != nil {
		return err
	}
	deadline := time.Now().Add(wakeTimeout)
	addr := fmt.Sprintf("127.0.0.1:%d", *rec.HostPort)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			conn.Close()
			p.St.Records.Lock()
			rec.State = state.Running
			p.St.Records.Unlock()
			_ = p.St.Save()
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("app did not answer on :%d within %s", *rec.HostPort, wakeTimeout)
}
