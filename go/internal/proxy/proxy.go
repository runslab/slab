// Package proxy is the ingress — Host-header routing to app host ports,
// exactly like src/proxy.ts. Wake-on-request for functions arrives with a
// later rung; rung 1 routes running apps and 404s the rest.
package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/runslab/slab/go/internal/state"
)

type Proxy struct {
	St *state.State
}

func (p *Proxy) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if i := strings.Index(host, ":"); i >= 0 {
			host = host[:i]
		}
		name, _, _ := strings.Cut(host, ".")
		rec := p.St.Apps[name]
		if rec == nil || rec.HostPort == nil {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(404)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "unknown app"})
			return
		}
		target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", *rec.HostPort))
		httputil.NewSingleHostReverseProxy(target).ServeHTTP(w, r)
	})
}
