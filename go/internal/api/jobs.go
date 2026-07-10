package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/runslab/slab/go/internal/state"
)

const jobDefaultTimeout = "30m"

var timeoutRe = regexp.MustCompile(`^\d+(s|m|h)$`)
var jobNameClean = regexp.MustCompile(`[^a-z0-9-]+`)

func sanitizeJobName(raw string) string {
	name := strings.ToLower(raw)
	name = jobNameClean.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-")
	if name == "" {
		name = "job"
	}
	if len(name) > 24 {
		name = name[:24]
	}
	return name
}

func newJobID(name string) string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	suffix := make([]byte, 4)
	for i := range suffix {
		suffix[i] = chars[rand.Intn(len(chars))]
	}
	return name + "-" + string(suffix)
}

func parseTimeout(s string) time.Duration {
	var n int
	var unit string
	if _, err := fmt.Sscanf(s, "%d%s", &n, &unit); err != nil {
		return 30 * time.Minute
	}
	switch unit {
	case "s":
		return time.Duration(n) * time.Second
	case "h":
		return time.Duration(n) * time.Hour
	default:
		return time.Duration(n) * time.Minute
	}
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func (s *Server) jobRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/jobs", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		jobs := make([]*state.JobRecord, 0, len(s.St.Jobs))
		for _, j := range s.St.Jobs {
			jobs = append(jobs, j)
		}
		s.St.Records.RUnlock()
		sort.Slice(jobs, func(i, k int) bool { return jobs[i].CreatedAt > jobs[k].CreatedAt })
		writeJSON(w, 200, map[string]any{"jobs": jobs})
	})

	mux.HandleFunc("POST /v1/jobs", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Image   string            `json:"image"`
			Command []string          `json:"command"`
			Env     map[string]string `json:"env"`
			Timeout string            `json:"timeout"`
			Systems []string          `json:"systems"`
			Name    string            `json:"name"`
			// sourceDir/gitUrl (Dockerfile job mode) arrive with a later rung
			SourceDir string `json:"sourceDir"`
			GitURL    string `json:"gitUrl"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		if body.SourceDir != "" || body.GitURL != "" {
			errJSON(w, 501, "source jobs (Dockerfile builds / workspace mounts) are a later rung of slabd — pass { image, command }")
			return
		}
		if body.Image == "" {
			errJSON(w, 400, "body must include { sourceDir } or { gitUrl } (a Dockerfile to build) and/or { image } (a stock image; source is mounted at /workspace)")
			return
		}
		if len(body.Command) == 0 {
			errJSON(w, 400, "a bare image job needs a { command } to run")
			return
		}
		timeout := body.Timeout
		if timeout == "" {
			timeout = jobDefaultTimeout
		}
		if !timeoutRe.MatchString(timeout) {
			errJSON(w, 400, fmt.Sprintf("invalid timeout %q — use e.g. \"90s\", \"10m\", \"1h\"", timeout))
			return
		}
		s.St.Records.Lock()
		for _, sys := range body.Systems {
			if s.St.Systems[sys] == nil {
				s.St.Records.Unlock()
				errJSON(w, 400, fmt.Sprintf("unknown system %q — the job can only join systems on this node", sys))
				return
			}
		}
		name := body.Name
		if name == "" {
			base := body.Image[strings.LastIndex(body.Image, "/")+1:]
			name, _, _ = strings.Cut(base, ":")
		}
		name = sanitizeJobName(name)
		img := body.Image
		env := body.Env
		if env == nil {
			env = map[string]string{}
		}
		job := &state.JobRecord{
			ID: newJobID(name), Name: name, Image: &img,
			Command: body.Command, Env: env, Systems: body.Systems,
			Timeout: timeout, State: state.JobQueued, CreatedAt: iso(time.Now()),
		}
		s.St.Jobs[job.ID] = job
		s.St.Records.Unlock()
		_ = s.St.Save()
		go s.executeJob(job)
		writeJSON(w, 201, map[string]any{"job": job})
	})

	mux.HandleFunc("GET /v1/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		job := s.St.Jobs[r.PathValue("id")]
		s.St.Records.RUnlock()
		if job == nil {
			errJSON(w, 404, "unknown job")
			return
		}
		writeJSON(w, 200, map[string]any{"job": job})
	})

	mux.HandleFunc("GET /v1/jobs/{id}/logs", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.RLock()
		job := s.St.Jobs[r.PathValue("id")]
		s.St.Records.RUnlock()
		if job == nil || job.ContainerID == nil {
			errJSON(w, 404, "unknown job (or it has no container yet)")
			return
		}
		out, err := s.Eng.ContainerLogsByID(r.Context(), *job.ContainerID, 500)
		if err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(out))
	})

	mux.HandleFunc("POST /v1/jobs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.Lock()
		job := s.St.Jobs[r.PathValue("id")]
		if job == nil {
			s.St.Records.Unlock()
			errJSON(w, 404, "unknown job")
			return
		}
		if job.State == state.JobQueued || job.State == state.JobRunning {
			job.State = state.JobCancelled
			now := iso(time.Now())
			job.FinishedAt = &now
		}
		cid := job.ContainerID
		s.St.Records.Unlock()
		if cid != nil {
			_ = s.Eng.KillContainer(r.Context(), *cid)
		}
		_ = s.St.Save()
		writeJSON(w, 200, map[string]any{"job": job})
	})

	mux.HandleFunc("DELETE /v1/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.St.Records.Lock()
		job := s.St.Jobs[r.PathValue("id")]
		if job == nil {
			s.St.Records.Unlock()
			errJSON(w, 404, "unknown job")
			return
		}
		cid := job.ContainerID
		delete(s.St.Jobs, job.ID)
		s.St.Records.Unlock()
		if cid != nil {
			_ = s.Eng.RemoveContainerByID(r.Context(), *cid)
		}
		_ = s.St.Save()
		w.WriteHeader(204)
	})
}

// executeJob runs the container to completion, enforcing the timeout.
func (s *Server) executeJob(job *state.JobRecord) {
	ctx := context.Background()
	fail := func(msg string) {
		s.St.Records.Lock()
		job.State = state.JobFailed
		job.Error = &msg
		now := iso(time.Now())
		job.FinishedAt = &now
		s.St.Records.Unlock()
		_ = s.St.Save()
	}

	if err := s.Eng.EnsureImage(ctx, *job.Image); err != nil {
		fail(err.Error())
		return
	}

	s.St.Records.RLock()
	networks := make([]string, 0, len(job.Systems))
	for _, sysName := range job.Systems {
		if sys := s.St.Systems[sysName]; sys != nil {
			networks = append(networks, systemNet(sys))
		}
	}
	s.St.Records.RUnlock()

	cid, err := s.Eng.RunJob(ctx, job.ID, *job.Image, job.Command, job.Env, networks)
	if err != nil {
		fail(err.Error())
		return
	}
	s.St.Records.Lock()
	job.ContainerID = &cid
	job.State = state.JobRunning
	now := iso(time.Now())
	job.StartedAt = &now
	s.St.Records.Unlock()
	_ = s.St.Save()

	waitCtx, cancel := context.WithTimeout(ctx, parseTimeout(job.Timeout))
	defer cancel()
	code, err := s.Eng.WaitJob(waitCtx, cid)

	s.St.Records.Lock()
	if job.State == state.JobCancelled {
		s.St.Records.Unlock()
		return // cancel already settled the record; the kill unblocked our wait
	}
	end := iso(time.Now())
	job.FinishedAt = &end
	if err != nil && waitCtx.Err() != nil {
		msg := fmt.Sprintf("timeout after %s — container killed", job.Timeout)
		job.State = state.JobFailed
		job.Error = &msg
		s.St.Records.Unlock()
		_ = s.Eng.KillContainer(ctx, cid)
		_ = s.St.Save()
		return
	}
	job.ExitCode = &code
	if code == 0 {
		job.State = state.JobSucceeded
	} else {
		job.State = state.JobFailed
	}
	s.St.Records.Unlock()
	_ = s.St.Save()
}
