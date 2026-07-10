// Package api serves the daemon HTTP surface — response shapes are the
// contract (scripts/conformance.js enforces them against both daemons).
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/runslab/slab/go/internal/dashboard"
	"github.com/runslab/slab/go/internal/engine"
	"github.com/runslab/slab/go/internal/gitsrc"
	"github.com/runslab/slab/go/internal/logbuf"
	"github.com/runslab/slab/go/internal/manifest"
	"github.com/runslab/slab/go/internal/state"
	"github.com/runslab/slab/go/internal/tunnel"
)

type Server struct {
	St        *state.State
	Eng       *engine.Engine
	NodeName  string
	Token     string
	ProxyPort int
	Advertise string // what other nodes dial for trunks (SLAB_ADVERTISE)
	Tunnels   *tunnel.Manager
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /v1/apps", func(w http.ResponseWriter, r *http.Request) {
		apps := make([]*state.AppRecord, 0, len(s.St.Apps))
		for _, a := range s.St.Apps {
			apps = append(apps, a)
		}
		writeJSON(w, 200, map[string]any{"apps": apps})
	})

	// image ship: docker-save tar stream in, docker load here — build where
	// the source lives, run where you point (slab -N <peer> deploy <dir>)
	mux.HandleFunc("PUT /v1/images", func(w http.ResponseWriter, r *http.Request) {
		if err := s.Eng.LoadImage(r.Context(), r.Body); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	})

	mux.HandleFunc("POST /v1/apps", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SourceDir string             `json:"sourceDir"`
			GitURL    string             `json:"gitUrl"`
			Manifest  *manifest.Manifest `json:"manifest"`
			Origin    string             `json:"origin"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		// inline manifest + image: the app arrives as an artifact; the image
		// was shipped separately via PUT /v1/images — no source here
		if body.Manifest != nil {
			m := body.Manifest
			if !appNameRe.MatchString(m.Name) {
				errJSON(w, 400, "manifest.name invalid")
				return
			}
			if m.Port < 1 || m.Port > 65535 {
				errJSON(w, 400, "manifest.port invalid")
				return
			}
			if m.Image == "" {
				errJSON(w, 400, "inline-manifest apps need manifest.image (ship it first: PUT /v1/images)")
				return
			}
			if _, exists := s.St.Apps[m.Name]; exists {
				errJSON(w, 409, fmt.Sprintf("app %q already exists", m.Name))
				return
			}
			if m.Type != "function" {
				m.Type = "service"
			}
			if m.IdleTimeout == "" {
				m.IdleTimeout = "5m"
			}
			if m.Env == nil {
				m.Env = map[string]string{}
			}
			if m.Secrets == nil {
				m.Secrets = []string{}
			}
			if m.Volumes == nil {
				m.Volumes = []string{}
			}
			origin := body.Origin
			if origin == "" {
				origin = "remote"
			}
			rec := &state.AppRecord{Name: m.Name, SourceDir: "shipped:" + origin, Manifest: m, State: state.Created}
			s.St.Apps[m.Name] = rec
			_ = s.St.Save()
			writeJSON(w, 201, map[string]any{"app": rec})
			return
		}
		source := body.GitURL
		if source == "" {
			source = body.SourceDir
		}
		if source == "" || (body.GitURL == "" && !filepath.IsAbs(source)) {
			errJSON(w, 400, "body must be { sourceDir: <absolute path> } or { gitUrl } (+ optional target)")
			return
		}
		sourceDir, gitURL, err := gitsrc.Resolve(source, "/")
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		m, err := manifest.Load(sourceDir)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		if _, exists := s.St.Apps[m.Name]; exists {
			errJSON(w, 409, fmt.Sprintf("app %q already exists", m.Name))
			return
		}
		rec := &state.AppRecord{
			Name: m.Name, SourceDir: sourceDir, GitURL: gitURL, Manifest: m,
			State: state.Created, Version: 0,
		}
		s.St.Apps[m.Name] = rec
		_ = s.St.Save()
		writeJSON(w, 201, map[string]any{"app": rec})
	})

	mux.HandleFunc("GET /v1/apps/{name}", func(w http.ResponseWriter, r *http.Request) {
		if rec := s.St.Apps[r.PathValue("name")]; rec != nil {
			writeJSON(w, 200, map[string]any{"app": rec})
			return
		}
		errJSON(w, 404, "unknown app")
	})

	mux.HandleFunc("DELETE /v1/apps/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		rec := s.St.Apps[name]
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		if err := s.Eng.RemoveExisting(r.Context(), name); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		state.DeleteSecrets(name)
		delete(s.St.Apps, name)
		_ = s.St.Save()
		w.WriteHeader(204)
	})

	mux.HandleFunc("POST /v1/apps/{name}/deploy", func(w http.ResponseWriter, r *http.Request) {
		rec := s.St.Apps[r.PathValue("name")]
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		if err := s.deployApp(r.Context(), rec); err != nil {
			msg := err.Error()
			rec.State = state.Error
			rec.Error = &msg
			_ = s.St.Save()
			errJSON(w, 500, msg)
			return
		}
		writeJSON(w, 200, map[string]any{"app": rec})
	})

	mux.HandleFunc("POST /v1/apps/{name}/stop", func(w http.ResponseWriter, r *http.Request) {
		rec := s.St.Apps[r.PathValue("name")]
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		if err := s.Eng.Stop(r.Context(), rec.Name); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		rec.State = state.Stopped
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"app": rec})
	})

	mux.HandleFunc("POST /v1/apps/{name}/start", func(w http.ResponseWriter, r *http.Request) {
		rec := s.St.Apps[r.PathValue("name")]
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		if err := s.Eng.Start(r.Context(), rec.Name); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		rec.State = state.Running
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"app": rec})
	})

	mux.HandleFunc("GET /v1/apps/{name}/logs", func(w http.ResponseWriter, r *http.Request) {
		rec := s.St.Apps[r.PathValue("name")]
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		tail := 200
		if t, err := strconv.Atoi(r.URL.Query().Get("tail")); err == nil && t > 0 {
			tail = t
		}
		if r.URL.Query().Get("follow") == "1" || r.URL.Query().Get("follow") == "true" {
			w.Header().Set("content-type", "text/plain; charset=utf-8")
			flusher, _ := w.(http.Flusher)
			pr, pw := io.Pipe()
			go func() { _ = s.Eng.FollowLogs(r.Context(), rec.Name, tail, pw); pw.Close() }()
			buf := make([]byte, 4096)
			for {
				n, err := pr.Read(buf)
				if n > 0 {
					_, _ = w.Write(buf[:n])
					if flusher != nil {
						flusher.Flush()
					}
				}
				if err != nil {
					return
				}
			}
		}
		out, err := s.Eng.Logs(r.Context(), rec.Name, tail)
		if err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(out))
	})

	// the daemon's OWN log — tail or follow, over the API so -N works too
	mux.HandleFunc("GET /v1/logs", func(w http.ResponseWriter, r *http.Request) {
		tail := 200
		if t, err := strconv.Atoi(r.URL.Query().Get("tail")); err == nil && t > 0 {
			tail = t
		}
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		for _, line := range logbuf.Default.Tail(tail) {
			_, _ = w.Write([]byte(line + "\n"))
		}
		if r.URL.Query().Get("follow") != "1" && r.URL.Query().Get("follow") != "true" {
			return
		}
		flusher, _ := w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}
		ch, unsub := logbuf.Default.Subscribe()
		defer unsub()
		for {
			select {
			case <-r.Context().Done():
				return
			case line, ok := <-ch:
				if !ok {
					return
				}
				_, _ = w.Write([]byte(line + "\n"))
				if flusher != nil {
					flusher.Flush()
				}
			}
		}
	})

	mux.HandleFunc("GET /v1/systems", func(w http.ResponseWriter, r *http.Request) {
		systems := make([]*state.SystemRecord, 0, len(s.St.Systems))
		for _, sys := range s.St.Systems {
			systems = append(systems, sys)
		}
		writeJSON(w, 200, map[string]any{"systems": systems})
	})

	mux.HandleFunc("POST /v1/systems", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SourceFile string `json:"sourceFile"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.SourceFile == "" || !filepath.IsAbs(body.SourceFile) {
			errJSON(w, 400, "body must be { sourceFile: <absolute path to system.toml> } or { manifest: {...} }")
			return
		}
		sm, err := manifest.LoadSystem(body.SourceFile)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		baseDir := filepath.Dir(body.SourceFile)
		members := make([]string, 0, len(sm.Members))
		memberNodes := map[string]string{}
		for name, m := range sm.Members {
			members = append(members, name)
			if m.Node != "" && m.Node != s.NodeName {
				memberNodes[name] = m.Node
				continue // placed members are created by the peer at adopt time
			}
			if _, exists := s.St.Apps[name]; exists {
				continue // adopt the existing app
			}
			src, gitURL, err := gitsrc.Resolve(m.Source, baseDir)
			if err != nil {
				errJSON(w, 400, fmt.Sprintf("member %q: %s", name, err.Error()))
				return
			}
			mf, err := manifest.Load(src)
			if err != nil {
				errJSON(w, 400, fmt.Sprintf("member %q: %s", name, err.Error()))
				return
			}
			if mf.Name != name {
				errJSON(w, 400, fmt.Sprintf("member key %q does not match manifest name %q", name, mf.Name))
				return
			}
			s.St.Apps[name] = &state.AppRecord{Name: name, SourceDir: src, GitURL: gitURL, Manifest: mf, State: state.Created}
		}
		rec := &state.SystemRecord{
			Name: sm.Name, Members: members, MemberNodes: memberNodes,
			Wires: sm.Wires, SourceFile: body.SourceFile, CreatedAt: iso(time.Now()),
		}
		s.St.Systems[sm.Name] = rec
		_ = s.St.Save()
		writeJSON(w, 201, map[string]any{"system": rec})
	})

	mux.HandleFunc("POST /v1/systems/{name}/deploy", func(w http.ResponseWriter, r *http.Request) {
		sys := s.St.Systems[r.PathValue("name")]
		if sys == nil {
			errJSON(w, 404, "unknown system")
			return
		}
		if status, err := s.deploySystem(r.Context(), sys); err != nil {
			errJSON(w, status, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"system": sys})
	})

	mux.HandleFunc("DELETE /v1/systems/{name}", func(w http.ResponseWriter, r *http.Request) {
		sys := s.St.Systems[r.PathValue("name")]
		if sys == nil {
			errJSON(w, 404, "unknown system")
			return
		}
		s.Eng.RemoveTrunk(r.Context(), s.trunkKey(sys))
		s.Eng.RemoveNetwork(r.Context(), s.systemNet(sys)) // apps are kept
		delete(s.St.Systems, sys.Name)
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"detached": sys.Name})
	})

	mux.HandleFunc("PUT /v1/apps/{name}/secrets", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		rec := s.St.Apps[r.PathValue("name")]
		s.St.Records.RUnlock()
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		var body struct {
			Values map[string]string `json:"values"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Values == nil {
			errJSON(w, 400, "body must be { values: Record<string, string> }")
			return
		}
		if err := state.SetSecrets(rec.Name, body.Values); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	})

	mux.HandleFunc("GET /v1/apps/{name}/secrets", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		rec := s.St.Apps[r.PathValue("name")]
		s.St.Records.RUnlock()
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		keys := make([]string, 0)
		for k := range state.GetSecrets(rec.Name) {
			keys = append(keys, k)
		}
		writeJSON(w, 200, map[string]any{"keys": keys})
	})

	mux.HandleFunc("POST /v1/apps/{name}/expose", func(w http.ResponseWriter, r *http.Request) {
		rec := s.St.Apps[r.PathValue("name")]
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		u, err := s.Tunnels.Open(rec.Name, s.ProxyPort)
		if err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		rec.PublicURL = &u
		rec.Exposed = true
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"app": rec})
	})

	mux.HandleFunc("POST /v1/apps/{name}/hide", func(w http.ResponseWriter, r *http.Request) {
		rec := s.St.Apps[r.PathValue("name")]
		if rec == nil {
			errJSON(w, 404, "unknown app")
			return
		}
		s.Tunnels.Close(rec.Name)
		rec.Exposed = false
		rec.PublicURL = nil
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"app": rec})
	})

	dashboard.Routes(mux, s.ProxyPort)

	s.jobRoutes(mux)
	s.spanningRoutes(mux)
	s.clusterRoutes(mux)

	return mux
}

// systemNet is node-scoped for spanning systems: two daemons on one docker
// host each keep their own bridge and the aliases stay unambiguous.
func (s *Server) systemNet(sys *state.SystemRecord) string {
	if sys.SpansNodes() {
		return "slab-net-" + s.NodeName + "-" + sys.Name
	}
	return "slab-net-" + sys.Name
}

func (s *Server) trunkKey(sys *state.SystemRecord) string { return s.NodeName + "-" + sys.Name }

// deployApp is the rung-1 deploy: re-read manifest, resolve the image
// (prebuilt only for now — Dockerfile builds are the next rung), assemble
// env (PORT < manifest.env), recreate the container.
func (s *Server) deployApp(ctx context.Context, rec *state.AppRecord) error {
	if rec.GitURL != nil { // git sources pull on every redeploy
		if _, err := gitsrc.CloneOrPull(*rec.GitURL, filepath.Base(rec.SourceDir)); err != nil {
			return err
		}
	}
	m := rec.Manifest
	// manifest may have changed (upstream pull or local edits) — re-read it.
	// Shipped apps have no source here; their manifest arrived inline.
	if !strings.HasPrefix(rec.SourceDir, "shipped:") {
		var err error
		m, err = manifest.Load(rec.SourceDir)
		if err != nil {
			return err
		}
		rec.Manifest = m
	}
	rec.State = state.Building
	_ = s.St.Save()

	imageTag := m.Image
	if imageTag == "" {
		imageTag = fmt.Sprintf("slab-%s:v%d", rec.Name, rec.Version+1)
		if err := s.Eng.BuildImage(ctx, rec.SourceDir, imageTag, m.Dockerfile); err != nil {
			return err
		}
	} else if err := s.Eng.EnsureImage(ctx, imageTag); err != nil {
		return err
	}

	if rec.HostPort == nil {
		p := s.St.AllocateHostPort()
		rec.HostPort = &p
	}

	// wires: env bindings from every system this app belongs to; two systems
	// disagreeing on the same key is an error, same as the TS daemon
	memberSystems := s.St.SystemsOf(rec.Name)
	wireEnv := map[string]string{}
	wireSource := map[string]string{}
	prefix := rec.Name + "."
	for _, sys := range memberSystems {
		for key, value := range sys.Wires {
			if !strings.HasPrefix(key, prefix) {
				continue
			}
			envKey := strings.TrimPrefix(key, prefix)
			if prev, seen := wireEnv[envKey]; seen && prev != value {
				return fmt.Errorf("wire conflict on %s for %s: system %q says %q, system %q says %q",
					envKey, rec.Name, wireSource[envKey], prev, sys.Name, value)
			}
			wireEnv[envKey] = value
			wireSource[envKey] = sys.Name
		}
	}
	networks := make([]string, 0, len(memberSystems))
	for _, sys := range memberSystems {
		if err := s.Eng.EnsureNetwork(ctx, s.systemNet(sys)); err != nil {
			return err
		}
		networks = append(networks, s.systemNet(sys))
	}

	// merge order: PORT < manifest.env < wires < secrets < DATABASE_URL
	env := map[string]string{"PORT": fmt.Sprint(m.Port)}
	for k, v := range m.Env {
		env[k] = v
	}
	for k, v := range wireEnv {
		env[k] = v
	}
	for k, v := range state.GetSecrets(rec.Name) {
		env[k] = v
	}
	if m.Postgres {
		dbURL, err := s.Eng.EnsurePostgres(ctx, rec.Name)
		if err != nil {
			return err
		}
		env["DATABASE_URL"] = dbURL
	}

	id, err := s.Eng.RunContainer(ctx, rec, imageTag, env, engine.RunOpts{
		Publish:  m.Public,
		Volumes:  m.Volumes,
		Networks: networks,
	})
	if err != nil {
		return err
	}
	if err := s.Eng.WaitReady(ctx, rec.Name, 30*time.Second); err != nil {
		return err
	}
	rec.ContainerID = &id
	rec.ImageTag = &imageTag
	rec.Version++
	rec.State = state.Running
	rec.Error = nil
	return s.St.Save()
}

var appNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)
