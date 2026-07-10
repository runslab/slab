// Spanning systems: adopt + trunk-sync orchestration (docs/design/trunks.md).
// The console node deploys local members, each placed peer adopts its own,
// and every node runs a trunk with one shared port-map.
package api

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/runslab/slab/go/internal/engine"
	"github.com/runslab/slab/go/internal/gitsrc"
	"github.com/runslab/slab/go/internal/manifest"
	"github.com/runslab/slab/go/internal/state"
)

type adoptResult struct {
	TrunkPort int `json:"trunkPort"`
	Members   []struct {
		Name string `json:"name"`
		Port int    `json:"port"`
	} `json:"members"`
}

// deploySystem deploys a system, spanning nodes when members are placed.
// Returns (httpStatus, error) on failure.
func (s *Server) deploySystem(ctx context.Context, sys *state.SystemRecord) (int, error) {
	if err := s.Eng.EnsureNetwork(ctx, s.systemNet(sys)); err != nil {
		return 500, err
	}

	remoteByNode := map[string][]string{}
	for m, n := range sys.MemberNodes {
		if n != "" && n != s.NodeName {
			remoteByNode[n] = append(remoteByNode[n], m)
		}
	}

	// ── remote members: each involved peer adopts the system ──
	peerResults := map[string]adoptResult{}
	if len(remoteByNode) > 0 {
		sm, err := manifest.LoadSystem(sys.SourceFile)
		if err != nil {
			return 500, fmt.Errorf("cannot re-read system manifest %s: %s", sys.SourceFile, err.Error())
		}
		baseDir := filepath.Dir(sys.SourceFile)
		for peerName, mems := range remoteByNode {
			peer := s.St.Peers[peerName]
			if peer == nil {
				return 400, fmt.Errorf("system %q places members on unknown node %q — slab peer add %s <url>", sys.Name, peerName, peerName)
			}
			membersPayload := map[string]map[string]string{}
			for _, m := range mems {
				src := sm.Members[m].Source
				asPath := src
				if !filepath.IsAbs(src) {
					asPath = filepath.Join(baseDir, src)
				}
				if _, err := os.Stat(asPath); err == nil {
					src = asPath // exists here — same-machine peer can use the path
				}
				membersPayload[m] = map[string]string{"source": src}
			}
			var result adoptResult
			err := postPeer(peer, "/v1/systems/adopt", map[string]any{
				"name": sys.Name, "origin": s.NodeName, "members": membersPayload,
				"wires": sys.Wires, "memberNodes": sys.MemberNodes,
			}, &result)
			if err != nil {
				return 500, fmt.Errorf("node %q failed to adopt system %q: %s", peerName, sys.Name, err.Error())
			}
			peerResults[peerName] = result
		}
	}

	// ── local members, dependency order ──
	for _, m := range topoSortMembers(sys) {
		if n := sys.MemberNodes[m]; n != "" && n != s.NodeName {
			continue
		}
		rec := s.St.Apps[m]
		if rec == nil {
			return 500, fmt.Errorf("system %q member %q is not a known app", sys.Name, m)
		}
		if err := s.deployApp(ctx, rec); err != nil {
			return 500, fmt.Errorf("failed to deploy member %q of system %q: %s", m, sys.Name, err.Error())
		}
	}

	// ── trunks: one per involved node, same port-map everywhere ──
	if len(remoteByNode) > 0 {
		type portInfo struct {
			port int
			node string
		}
		ports := map[string]portInfo{}
		for _, m := range sys.Members {
			if n := sys.MemberNodes[m]; n != "" && n != s.NodeName {
				continue
			}
			if rec := s.St.Apps[m]; rec != nil && rec.Manifest != nil {
				ports[m] = portInfo{rec.Manifest.Port, s.NodeName}
			}
		}
		for peerName, r := range peerResults {
			for _, mi := range r.Members {
				ports[mi.Name] = portInfo{mi.Port, peerName}
			}
		}
		seen := map[int]string{}
		for m, info := range ports {
			if clash, ok := seen[info.port]; ok {
				return 400, fmt.Errorf("a system that spans nodes needs distinct member ports: %q and %q both listen on %d", m, clash, info.port)
			}
			seen[info.port] = m
		}

		if sys.TrunkHostPort == nil {
			p := s.St.AllocateHostPort()
			sys.TrunkHostPort = &p
		}
		if sys.TrunkToken == nil {
			t := randToken()
			sys.TrunkToken = &t
		}
		_ = s.St.Save()

		trunkPeers := map[string]engine.TrunkPeerAddr{
			s.NodeName: {Host: s.Advertise, Port: *sys.TrunkHostPort},
		}
		for peerName, r := range peerResults {
			trunkPeers[peerName] = engine.TrunkPeerAddr{Host: hostOfURL(s.St.Peers[peerName].URL), Port: r.TrunkPort}
		}
		cfgFor := func(nodeName string) engine.TrunkConfig {
			local := map[string]engine.TrunkLocal{}
			remote := map[string]engine.TrunkRemote{}
			for m, info := range ports {
				if info.node == nodeName {
					local[m] = engine.TrunkLocal{Port: info.port}
				} else {
					remote[m] = engine.TrunkRemote{Port: info.port, Node: info.node}
				}
			}
			return engine.TrunkConfig{Token: *sys.TrunkToken, IngressPort: engine.TrunkIngressPort, Local: local, Remote: remote, Peers: trunkPeers}
		}

		script, err := engine.WriteTrunkScript(sys.Name)
		if err != nil {
			return 500, err
		}
		if _, err := s.Eng.RunTrunk(ctx, s.trunkKey(sys), script, cfgFor(s.NodeName), s.systemNet(sys), *sys.TrunkHostPort); err != nil {
			return 500, fmt.Errorf("failed to start trunk for %q: %s", sys.Name, err.Error())
		}
		for peerName := range peerResults {
			var out map[string]any
			if err := postPeer(s.St.Peers[peerName], "/v1/systems/"+sys.Name+"/trunk-sync", cfgFor(peerName), &out); err != nil {
				return 500, fmt.Errorf("node %q failed to start its trunk for %q: %s", peerName, sys.Name, err.Error())
			}
		}
	} else if sys.TrunkHostPort != nil {
		s.Eng.RemoveTrunk(ctx, s.trunkKey(sys)) // system no longer spans — retire the trunk
	}

	now := iso(time.Now())
	sys.DeployedAt = &now
	_ = s.St.Save()
	return 200, nil
}

func (s *Server) spanningRoutes(mux *http.ServeMux) {
	// a console pushes a spanning system to this node: create + deploy OUR
	// members, allocate the trunk ingress port, report member ports back
	mux.HandleFunc("POST /v1/systems/adopt", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string                       `json:"name"`
			Origin      string                       `json:"origin"`
			Members     map[string]map[string]string `json:"members"`
			Wires       map[string]string            `json:"wires"`
			MemberNodes map[string]string            `json:"memberNodes"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Name == "" || body.Members == nil {
			errJSON(w, 400, "body must be { name, origin, members, wires, memberNodes }")
			return
		}
		for memberName, cfg := range body.Members {
			if s.St.Apps[memberName] != nil {
				continue
			}
			src, gitURL, err := gitsrc.Resolve(cfg["source"], "/")
			if err != nil {
				errJSON(w, 400, fmt.Sprintf("member %q: %s", memberName, err.Error()))
				return
			}
			mf, err := manifest.Load(src)
			if err != nil {
				errJSON(w, 400, fmt.Sprintf("member %q: %s", memberName, err.Error()))
				return
			}
			s.St.Apps[memberName] = &state.AppRecord{Name: memberName, SourceDir: src, GitURL: gitURL, Manifest: mf, State: state.Created}
		}
		existing := s.St.Systems[body.Name]
		origin := body.Origin
		members := make([]string, 0, len(body.Members))
		for m := range body.Members {
			members = append(members, m)
		}
		rec := &state.SystemRecord{
			Name: body.Name, SourceFile: "adopted:" + origin, Members: members,
			Wires: body.Wires, MemberNodes: body.MemberNodes, Origin: &origin,
			CreatedAt: iso(time.Now()),
		}
		if existing != nil {
			rec.TrunkHostPort = existing.TrunkHostPort
			rec.TrunkToken = existing.TrunkToken
			rec.CreatedAt = existing.CreatedAt
		}
		if rec.TrunkHostPort == nil {
			p := s.St.AllocateHostPort()
			rec.TrunkHostPort = &p
		}
		s.St.Systems[body.Name] = rec
		_ = s.St.Save()
		if err := s.Eng.EnsureNetwork(r.Context(), s.systemNet(rec)); err != nil {
			errJSON(w, 500, err.Error())
			return
		}

		out := []map[string]any{}
		for _, memberName := range rec.Members {
			app := s.St.Apps[memberName]
			if app == nil {
				errJSON(w, 500, fmt.Sprintf("adopted member %q is not a known app", memberName))
				return
			}
			if err := s.deployApp(r.Context(), app); err != nil {
				errJSON(w, 500, err.Error())
				return
			}
			out = append(out, map[string]any{"name": memberName, "port": app.Manifest.Port})
		}
		now := iso(time.Now())
		rec.DeployedAt = &now
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"trunkPort": rec.TrunkHostPort, "members": out})
	})

	// the console broadcasts the agreed port-map; start our trunk with it
	mux.HandleFunc("POST /v1/systems/{name}/trunk-sync", func(w http.ResponseWriter, r *http.Request) {
		sys := s.St.Systems[r.PathValue("name")]
		if sys == nil {
			errJSON(w, 404, "unknown system")
			return
		}
		var cfg engine.TrunkConfig
		if json.NewDecoder(r.Body).Decode(&cfg) != nil || cfg.Token == "" || cfg.Local == nil || cfg.Peers == nil {
			errJSON(w, 400, "body must be a TrunkConfig { token, ingressPort, local, remote, peers }")
			return
		}
		sys.TrunkToken = &cfg.Token
		if sys.TrunkHostPort == nil {
			p := s.St.AllocateHostPort()
			sys.TrunkHostPort = &p
		}
		_ = s.St.Save()
		script, err := engine.WriteTrunkScript(sys.Name)
		if err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		id, err := s.Eng.RunTrunk(r.Context(), s.trunkKey(sys), script, cfg, s.systemNet(sys), *sys.TrunkHostPort)
		if err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"trunk": id})
	})
}

// postPeer POSTs JSON to a peer's API with its token.
func postPeer(p *state.PeerRecord, path string, body any, into any) error {
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", p.URL+path, bytes.NewReader(data))
	req.Header.Set("content-type", "application/json")
	if p.Token != "" {
		req.Header.Set("Authorization", "Bearer "+p.Token)
	}
	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if e.Error != "" {
			return fmt.Errorf("%s", e.Error)
		}
		return fmt.Errorf("%s -> %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(into)
}

func hostOfURL(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	return raw
}

func randToken() string {
	b := make([]byte, 16)
	_, _ = crand.Read(b)
	return hex.EncodeToString(b)
}

// topoSortMembers orders members so wire providers deploy before consumers —
// a member whose wire VALUE mentions another member depends on it.
func topoSortMembers(sys *state.SystemRecord) []string {
	memberSet := map[string]bool{}
	for _, m := range sys.Members {
		memberSet[m] = true
	}
	dependsOn := map[string]map[string]bool{}
	for _, m := range sys.Members {
		dependsOn[m] = map[string]bool{}
	}
	for wireKey, value := range sys.Wires {
		dot := -1
		for i, c := range wireKey {
			if c == '.' {
				dot = i
				break
			}
		}
		if dot < 0 {
			continue
		}
		target := wireKey[:dot]
		if !memberSet[target] {
			continue
		}
		for _, candidate := range sys.Members {
			if candidate == target {
				continue
			}
			if regexp.MustCompile(`\b` + regexp.QuoteMeta(candidate) + `\b`).MatchString(value) {
				dependsOn[target][candidate] = true
			}
		}
	}
	// Kahn's algorithm; ties keep declaration order, cycles append at the end
	var order []string
	placed := map[string]bool{}
	for len(order) < len(sys.Members) {
		progressed := false
		for _, m := range sys.Members {
			if placed[m] {
				continue
			}
			ready := true
			for dep := range dependsOn[m] {
				if !placed[dep] {
					ready = false
					break
				}
			}
			if ready {
				order = append(order, m)
				placed[m] = true
				progressed = true
			}
		}
		if !progressed { // cycle — append the rest in declaration order
			for _, m := range sys.Members {
				if !placed[m] {
					order = append(order, m)
					placed[m] = true
				}
			}
		}
	}
	return order
}
