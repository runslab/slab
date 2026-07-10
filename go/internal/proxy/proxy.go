// Package proxy is the ingress — Host-header routing to app host ports with
// wake-on-request for functions, mirroring src/proxy.ts.
package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/runslab/slab/go/internal/engine"
	"github.com/runslab/slab/go/internal/state"
)

const wakeTimeout = 15 * time.Second

type Proxy struct {
	St  *state.State
	Eng *engine.Engine

	routeMu    sync.Mutex
	routes     map[string]*peerRoute
	routeCache map[string]routeEntry
}

type routeEntry struct {
	route *peerRoute
	at    time.Time
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
			// cluster ingress: not ours — find the peer that runs it and
			// reverse-proxy to that node's ingress (one rack, any node)
			if route := p.resolvePeerApp(name); route != nil {
				target, _ := url.Parse(fmt.Sprintf("http://%s:%d", route.host, route.proxyPort))
				rp := httputil.NewSingleHostReverseProxy(target)
				rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
					sendJSON(w, 502, "cluster ingress to "+route.node+" failed: "+err.Error())
				}
				rp.ServeHTTP(w, r) // Host header travels as-is; the peer routes by it
				return
			}
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

type peerRoute struct {
	node      string
	host      string
	proxyPort int
}

// resolvePeerApp finds which peer runs <name> and how to reach its ingress.
// Cached briefly — apps don't move every request, and the scan hits the
// network. Returns nil when no peer owns the app.
func (p *Proxy) resolvePeerApp(name string) *peerRoute {
	p.routeMu.Lock()
	if p.routes == nil {
		p.routes = map[string]*peerRoute{}
	}
	if e, ok := p.routeCache[name]; ok && time.Since(e.at) < 5*time.Second {
		r := e.route
		p.routeMu.Unlock()
		return r
	}
	p.routeMu.Unlock()

	p.St.Records.RLock()
	peers := make([]*state.PeerRecord, 0, len(p.St.Peers))
	for _, pr := range p.St.Peers {
		peers = append(peers, pr)
	}
	p.St.Records.RUnlock()

	var found *peerRoute
	for _, peer := range peers {
		client := &http.Client{Timeout: 3 * time.Second}
		req, _ := http.NewRequest("GET", peer.URL+"/v1/apps", nil)
		if peer.Token != "" {
			req.Header.Set("Authorization", "Bearer "+peer.Token)
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		var body struct {
			Apps []struct {
				Name     string `json:"name"`
				HostPort *int   `json:"hostPort"`
			} `json:"apps"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		has := false
		for _, a := range body.Apps {
			if a.Name == name && a.HostPort != nil {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		hreq, _ := http.NewRequest("GET", peer.URL+"/v1/health", nil)
		if peer.Token != "" {
			hreq.Header.Set("Authorization", "Bearer "+peer.Token)
		}
		hresp, err := client.Do(hreq)
		if err != nil {
			continue
		}
		var health struct {
			Node      string `json:"node"`
			ProxyPort int    `json:"proxyPort"`
		}
		_ = json.NewDecoder(hresp.Body).Decode(&health)
		hresp.Body.Close()
		found = &peerRoute{node: health.Node, host: hostOf(peer.URL), proxyPort: health.ProxyPort}
		break
	}
	p.routeMu.Lock()
	if p.routeCache == nil {
		p.routeCache = map[string]routeEntry{}
	}
	p.routeCache[name] = routeEntry{route: found, at: time.Now()}
	p.routeMu.Unlock()
	return found
}

func hostOf(rawURL string) string {
	if u, err := url.Parse(rawURL); err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	return rawURL
}

// wake starts the container and polls until the app answers HTTP. A bare
// TCP connect is not enough: docker-proxy accepts on the host port the
// moment the container starts, before the app inside is listening.
func (p *Proxy) wake(ctx context.Context, rec *state.AppRecord) error {
	if err := p.Eng.Start(ctx, rec.Name); err != nil {
		return err
	}
	deadline := time.Now().Add(wakeTimeout)
	probe := &http.Client{Timeout: time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/", *rec.HostPort)
	for time.Now().Before(deadline) {
		resp, err := probe.Get(url)
		if err == nil { // any HTTP status counts as awake
			resp.Body.Close()
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
