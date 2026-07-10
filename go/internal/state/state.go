// Package state persists the node's records — the Go twin of src/state.ts.
// Everything lives under SLAB_DIR (default ~/.slab): state.json (atomic
// writes), node.json (identity + token).
package state

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/runslab/slab/go/internal/manifest"
)

type AppState string

const (
	Created  AppState = "created"
	Building AppState = "building"
	Running  AppState = "running"
	Sleeping AppState = "sleeping"
	Stopped  AppState = "stopped"
	Error    AppState = "error"
)

// AppRecord mirrors the TS AppRecord (src/types.ts) — field names must stay
// identical: the JSON is the API contract the conformance harness reads.
type AppRecord struct {
	Name        string             `json:"name"`
	SourceDir   string             `json:"sourceDir"`
	GitURL      *string            `json:"gitUrl"`
	Manifest    *manifest.Manifest `json:"manifest"`
	HostPort    *int               `json:"hostPort"`
	ContainerID *string            `json:"containerId"`
	ImageTag    *string            `json:"imageTag"`
	Version     int                `json:"version"`
	State       AppState           `json:"state"`
	Error       *string            `json:"error"`
	Exposed     bool               `json:"exposed"`
	PublicURL   *string            `json:"publicUrl"`
}

type State struct {
	Apps map[string]*AppRecord `json:"apps"`

	mu   sync.Mutex `json:"-"`
	file string     `json:"-"`
}

type NodeConfig struct {
	Name  string `json:"name"`
	Token string `json:"token"`
}

func Dir() string {
	if d := os.Getenv("SLAB_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".slab")
}

// Load reads state.json, creating an empty state (and SLAB_DIR) if absent.
func Load() (*State, error) {
	dir := Dir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &State{Apps: map[string]*AppRecord{}, file: filepath.Join(dir, "state.json")}
	data, err := os.ReadFile(s.file)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, s); err != nil {
		return nil, fmt.Errorf("corrupt state.json: %w", err)
	}
	if s.Apps == nil {
		s.Apps = map[string]*AppRecord{}
	}
	return s, nil
}

// Save writes state.json atomically (temp file + rename), like the TS daemon.
func (s *State) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// AllocateHostPort hands out the first free port >= 20000 among records.
func (s *State) AllocateHostPort() int {
	used := map[int]bool{}
	for _, a := range s.Apps {
		if a.HostPort != nil {
			used[*a.HostPort] = true
		}
	}
	p := 20000
	for used[p] {
		p++
	}
	return p
}

// EnsureNode loads or creates node.json (name + auth token).
func EnsureNode() (*NodeConfig, error) {
	file := filepath.Join(Dir(), "node.json")
	data, err := os.ReadFile(file)
	if err == nil {
		var n NodeConfig
		if err := json.Unmarshal(data, &n); err == nil {
			return &n, nil
		}
	}
	host, _ := os.Hostname()
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	n := &NodeConfig{Name: host, Token: hex.EncodeToString(buf)}
	out, _ := json.MarshalIndent(n, "", "  ")
	if err := os.WriteFile(file, out, 0o600); err != nil {
		return nil, err
	}
	return n, nil
}
