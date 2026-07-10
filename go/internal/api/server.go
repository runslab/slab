// Package api serves the daemon HTTP surface — response shapes are the
// contract (scripts/conformance.js enforces them against both daemons).
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/runslab/slab/go/internal/engine"
	"github.com/runslab/slab/go/internal/manifest"
	"github.com/runslab/slab/go/internal/state"
)

type Server struct {
	St  *state.State
	Eng *engine.Engine
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

	mux.HandleFunc("POST /v1/apps", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SourceDir string `json:"sourceDir"`
			GitURL    string `json:"gitUrl"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.SourceDir == "" || !filepath.IsAbs(body.SourceDir) {
			errJSON(w, 400, "body must be { sourceDir: <absolute path> } or { gitUrl } (+ optional target)")
			return
		}
		m, err := manifest.Load(body.SourceDir)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		if _, exists := s.St.Apps[m.Name]; exists {
			errJSON(w, 409, fmt.Sprintf("app %q already exists", m.Name))
			return
		}
		rec := &state.AppRecord{
			Name: m.Name, SourceDir: body.SourceDir, Manifest: m,
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
		out, err := s.Eng.Logs(r.Context(), rec.Name, tail)
		if err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(out))
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
		for name, m := range sm.Members {
			if m.Node != "" {
				errJSON(w, 501, fmt.Sprintf("member %q has node placement — trunks are a later rung of slabd", name))
				return
			}
			if _, exists := s.St.Apps[name]; exists {
				members = append(members, name) // adopt the existing app
				continue
			}
			src := m.Source
			if !filepath.IsAbs(src) {
				src = filepath.Join(baseDir, src)
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
			s.St.Apps[name] = &state.AppRecord{Name: name, SourceDir: src, Manifest: mf, State: state.Created}
			members = append(members, name)
		}
		rec := &state.SystemRecord{Name: sm.Name, Members: members, Wires: sm.Wires, SourceFile: body.SourceFile}
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
		if err := s.Eng.EnsureNetwork(r.Context(), systemNet(sys)); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		for _, m := range sys.Members {
			rec := s.St.Apps[m]
			if rec == nil {
				errJSON(w, 500, fmt.Sprintf("system %q member %q is not a known app", sys.Name, m))
				return
			}
			if err := s.deployApp(r.Context(), rec); err != nil {
				errJSON(w, 500, fmt.Sprintf("failed to deploy member %q of system %q: %s", m, sys.Name, err.Error()))
				return
			}
		}
		writeJSON(w, 200, map[string]any{"system": sys})
	})

	mux.HandleFunc("DELETE /v1/systems/{name}", func(w http.ResponseWriter, r *http.Request) {
		sys := s.St.Systems[r.PathValue("name")]
		if sys == nil {
			errJSON(w, 404, "unknown system")
			return
		}
		s.Eng.RemoveNetwork(r.Context(), systemNet(sys)) // apps are kept
		delete(s.St.Systems, sys.Name)
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"detached": sys.Name})
	})

	s.jobRoutes(mux)

	return mux
}

func systemNet(sys *state.SystemRecord) string { return "slab-net-" + sys.Name }

// deployApp is the rung-1 deploy: re-read manifest, resolve the image
// (prebuilt only for now — Dockerfile builds are the next rung), assemble
// env (PORT < manifest.env), recreate the container.
func (s *Server) deployApp(ctx context.Context, rec *state.AppRecord) error {
	m, err := manifest.Load(rec.SourceDir) // manifest may have changed — re-read it
	if err != nil {
		return err
	}
	rec.Manifest = m
	rec.State = state.Building
	_ = s.St.Save()

	imageTag := m.Image
	if imageTag == "" {
		imageTag = fmt.Sprintf("slab-%s:v%d", rec.Name, rec.Version+1)
		if err := s.Eng.BuildImage(ctx, rec.SourceDir, imageTag); err != nil {
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
		if err := s.Eng.EnsureNetwork(ctx, systemNet(sys)); err != nil {
			return err
		}
		networks = append(networks, systemNet(sys))
	}

	// merge order: PORT < manifest.env < wires (secrets arrive a later rung)
	env := map[string]string{"PORT": fmt.Sprint(m.Port)}
	for k, v := range m.Env {
		env[k] = v
	}
	for k, v := range wireEnv {
		env[k] = v
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
