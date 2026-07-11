// Package metrics renders slab's own state as Prometheus text — the
// slab-specific telemetry nothing else can produce (fleet/app up-down,
// ingress request counts). cAdvisor covers container resources; this covers
// what only the daemon knows.
package metrics

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/runslab/slab/go/internal/state"
)

var (
	mu       sync.Mutex
	requests = map[string]uint64{} // app -> total ingress requests
)

// IncRequest counts one ingress request to an app (called by the proxy).
func IncRequest(app string) {
	mu.Lock()
	requests[app]++
	mu.Unlock()
}

// Render produces the Prometheus exposition for this node.
func Render(st *state.State, node, version string) string {
	st.Records.RLock()
	byState := map[string]int{}
	type appRow struct {
		name    string
		up      int
		reqs    uint64
		lastReq string
	}
	var apps []appRow
	mu.Lock()
	for _, a := range st.Apps {
		byState[string(a.State)]++
		up := 0
		if a.State == state.Running {
			up = 1
		}
		last := ""
		if a.LastRequestAt != nil {
			last = *a.LastRequestAt
		}
		apps = append(apps, appRow{a.Name, up, requests[a.Name], last})
	}
	mu.Unlock()
	systems := len(st.Systems)
	jobs := len(st.Jobs)
	st.Records.RUnlock()

	sort.Slice(apps, func(i, j int) bool { return apps[i].name < apps[j].name })
	nl := func(s string) string { return strings.ReplaceAll(s, `"`, `\"`) }

	var b strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&b, f, a...) }

	w("# HELP slab_node_up 1 while the daemon is serving.\n# TYPE slab_node_up gauge\n")
	w("slab_node_up{node=%q,version=%q} 1\n", nl(node), nl(version))

	w("# HELP slab_apps Apps on this node by state.\n# TYPE slab_apps gauge\n")
	states := make([]string, 0, len(byState))
	for s := range byState {
		states = append(states, s)
	}
	sort.Strings(states)
	for _, s := range states {
		w("slab_apps{node=%q,state=%q} %d\n", nl(node), nl(s), byState[s])
	}

	w("# HELP slab_systems Systems deployed on this node.\n# TYPE slab_systems gauge\n")
	w("slab_systems{node=%q} %d\n", nl(node), systems)
	w("# HELP slab_jobs Jobs in history on this node.\n# TYPE slab_jobs gauge\n")
	w("slab_jobs{node=%q} %d\n", nl(node), jobs)

	w("# HELP slab_app_up 1 if the app's container is running.\n# TYPE slab_app_up gauge\n")
	for _, a := range apps {
		w("slab_app_up{node=%q,app=%q} %d\n", nl(node), nl(a.name), a.up)
	}
	w("# HELP slab_app_requests_total Ingress requests routed to the app.\n# TYPE slab_app_requests_total counter\n")
	for _, a := range apps {
		w("slab_app_requests_total{node=%q,app=%q} %d\n", nl(node), nl(a.name), a.reqs)
	}
	return b.String()
}
