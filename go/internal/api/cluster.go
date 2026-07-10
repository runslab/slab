package api

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/runslab/slab/go/internal/state"
)

var peerNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)

// Auth mirrors the TS daemon: loopback is exempt, everything else needs
// Authorization: Bearer <node token>.
func (s *Server) Auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err == nil {
			ip := net.ParseIP(host)
			if ip != nil && ip.IsLoopback() {
				next.ServeHTTP(w, r)
				return
			}
		}
		if s.Token != "" && r.Header.Get("Authorization") == "Bearer "+s.Token {
			next.ServeHTTP(w, r)
			return
		}
		errJSON(w, 401, "unauthorized — non-loopback requests require Authorization: Bearer $SLAB_TOKEN (or open /?token=... once)")
	})
}

func (s *Server) clusterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		n := len(s.St.Apps)
		s.St.Records.RUnlock()
		writeJSON(w, 200, map[string]any{"status": "ok", "node": s.NodeName, "apps": n, "proxyPort": s.ProxyPort})
	})

	mux.HandleFunc("GET /v1/peers", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		peers := make([]*state.PeerRecord, 0, len(s.St.Peers))
		for _, p := range s.St.Peers {
			peers = append(peers, p)
		}
		s.St.Records.RUnlock()
		writeJSON(w, 200, map[string]any{"peers": peers})
	})

	mux.HandleFunc("PUT /v1/peers/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !peerNameRe.MatchString(name) {
			errJSON(w, 400, "invalid peer name — lowercase letters, digits, hyphens, 2-31 chars")
			return
		}
		var body struct {
			URL   string `json:"url"`
			Token string `json:"token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !strings.HasPrefix(body.URL, "http://") && !strings.HasPrefix(body.URL, "https://") {
			errJSON(w, 400, `body must be { url: "http://host:port", token? }`)
			return
		}
		peer := &state.PeerRecord{Name: name, URL: strings.TrimRight(body.URL, "/"), Token: body.Token}
		s.St.Records.Lock()
		s.St.Peers[name] = peer
		s.St.Records.Unlock()
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"peer": peer})
	})

	mux.HandleFunc("DELETE /v1/peers/{name}", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.Lock()
		if s.St.Peers[r.PathValue("name")] == nil {
			s.St.Records.Unlock()
			errJSON(w, 404, "unknown peer")
			return
		}
		delete(s.St.Peers, r.PathValue("name"))
		s.St.Records.Unlock()
		_ = s.St.Save()
		w.WriteHeader(204)
	})

	mux.HandleFunc("GET /v1/fleet", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		apps := make([]*state.AppRecord, 0, len(s.St.Apps))
		for _, a := range s.St.Apps {
			apps = append(apps, a)
		}
		systems := make([]*state.SystemRecord, 0, len(s.St.Systems))
		for _, sys := range s.St.Systems {
			systems = append(systems, sys)
		}
		peers := make([]*state.PeerRecord, 0, len(s.St.Peers))
		for _, p := range s.St.Peers {
			peers = append(peers, p)
		}
		s.St.Records.RUnlock()

		local := map[string]any{
			"name": s.NodeName, "self": true, "reachable": true, "url": nil,
			"proxyPort": s.ProxyPort, "apps": apps, "systems": systems, "error": nil,
		}
		nodes := []map[string]any{local}
		type result struct {
			idx  int
			node map[string]any
		}
		results := make(chan result, len(peers))
		for i, p := range peers {
			go func(i int, p *state.PeerRecord) {
				node, err := fetchPeer(p)
				if err != nil {
					node = map[string]any{
						"name": p.Name, "self": false, "reachable": false, "url": p.URL,
						"proxyPort": nil, "apps": []any{}, "systems": []any{}, "error": err.Error(),
					}
				}
				results <- result{i, node}
			}(i, p)
		}
		peerNodes := make([]map[string]any, len(peers))
		for range peers {
			res := <-results
			peerNodes[res.idx] = res.node
		}
		nodes = append(nodes, peerNodes...)
		writeJSON(w, 200, map[string]any{"nodes": nodes})
	})
}

// fetchPeer asks a peer for its health, apps, and systems (3s budget).
func fetchPeer(p *state.PeerRecord) (map[string]any, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	get := func(path string, into any) error {
		req, _ := http.NewRequest("GET", p.URL+path, nil)
		if p.Token != "" {
			req.Header.Set("Authorization", "Bearer "+p.Token)
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("%s -> %d", path, resp.StatusCode)
		}
		return json.NewDecoder(resp.Body).Decode(into)
	}
	var health struct {
		Node      string `json:"node"`
		ProxyPort int    `json:"proxyPort"`
	}
	var appsResp struct {
		Apps []json.RawMessage `json:"apps"`
	}
	var sysResp struct {
		Systems []json.RawMessage `json:"systems"`
	}
	if err := get("/v1/health", &health); err != nil {
		return nil, err
	}
	if err := get("/v1/apps", &appsResp); err != nil {
		return nil, err
	}
	if err := get("/v1/systems", &sysResp); err != nil {
		return nil, err
	}
	name := health.Node
	if name == "" {
		name = p.Name
	}
	return map[string]any{
		"name": name, "self": false, "reachable": true, "url": p.URL,
		"proxyPort": health.ProxyPort, "apps": appsResp.Apps, "systems": sysResp.Systems, "error": nil,
	}, nil
}
