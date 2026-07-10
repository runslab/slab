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

	return mux
}

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

	if m.Image == "" {
		return fmt.Errorf("dockerfile builds not implemented yet in slabd — use image = for now")
	}
	if err := s.Eng.EnsureImage(ctx, m.Image); err != nil {
		return err
	}

	if rec.HostPort == nil {
		p := s.St.AllocateHostPort()
		rec.HostPort = &p
	}

	env := map[string]string{"PORT": fmt.Sprint(m.Port)}
	for k, v := range m.Env {
		env[k] = v
	}

	id, err := s.Eng.RunContainer(ctx, rec, m.Image, env, engine.RunOpts{
		Publish: m.Public,
		Volumes: m.Volumes,
	})
	if err != nil {
		return err
	}
	if err := s.Eng.WaitReady(ctx, rec.Name, 30*time.Second); err != nil {
		return err
	}
	rec.ContainerID = &id
	rec.ImageTag = &m.Image
	rec.Version++
	rec.State = state.Running
	rec.Error = nil
	return s.St.Save()
}
