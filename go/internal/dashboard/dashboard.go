// Package dashboard serves the rack UI. The HTML is NOT authored here — it
// is exported from src/dashboard.ts by scripts/export-dashboard.js at build
// time (one dashboard, two daemons). The proxy port is a sentinel replaced
// at serve time.
package dashboard

import (
	_ "embed"
	"fmt"
	"net/http"
	"strings"
)

//go:embed dashboard.html
var html string

//go:embed favicon.svg
var favicon string

const portSentinel = "987654"

func Routes(mux *http.ServeMux, proxyPort int) {
	rendered := strings.ReplaceAll(html, portSentinel, fmt.Sprint(proxyPort))
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(rendered))
	})
	mux.HandleFunc("GET /favicon.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "image/svg+xml")
		w.Header().Set("cache-control", "public, max-age=86400")
		_, _ = w.Write([]byte(favicon))
	})
}
