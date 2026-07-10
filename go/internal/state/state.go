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
	"strconv"
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
	Name          string             `json:"name"`
	SourceDir     string             `json:"sourceDir"`
	GitURL        *string            `json:"gitUrl"`
	Manifest      *manifest.Manifest `json:"manifest"`
	HostPort      *int               `json:"hostPort"`
	ContainerID   *string            `json:"containerId"`
	ImageTag      *string            `json:"imageTag"`
	Version       int                `json:"version"`
	State         AppState           `json:"state"`
	Error         *string            `json:"error"`
	Exposed       bool               `json:"exposed"`
	PublicURL     *string            `json:"publicUrl"`
	LastRequestAt *string            `json:"lastRequestAt,omitempty"` // ISO — proxy updates, idle reaper reads
}

// PeerRecord mirrors the TS PeerRecord.
type PeerRecord struct {
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token,omitempty"`
}

// SystemRecord mirrors the TS SystemRecord (field names are the contract).
type SystemRecord struct {
	Name          string            `json:"name"`
	Members       []string          `json:"members"`
	MemberNodes   map[string]string `json:"memberNodes,omitempty"`
	Wires         map[string]string `json:"wires"`
	SourceFile    string            `json:"sourceFile"`
	Origin        *string           `json:"origin,omitempty"`        // set on adopted systems
	TrunkHostPort *int              `json:"trunkHostPort,omitempty"` // this node's trunk ingress
	TrunkToken    *string           `json:"trunkToken,omitempty"`
	CreatedAt     string            `json:"createdAt,omitempty"`
	DeployedAt    *string           `json:"deployedAt,omitempty"`
}

// SpansNodes reports whether any member is placed on another node.
func (sys *SystemRecord) SpansNodes() bool {
	for _, n := range sys.MemberNodes {
		if n != "" {
			return true
		}
	}
	return false
}

type JobState string

const (
	JobQueued    JobState = "queued"
	JobRunning   JobState = "running"
	JobSucceeded JobState = "succeeded"
	JobFailed    JobState = "failed"
	JobCancelled JobState = "cancelled"
)

// JobRecord mirrors the TS JobRecord (src/types.ts).
type JobRecord struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	SourceDir   *string           `json:"sourceDir"`
	GitURL      *string           `json:"gitUrl"`
	Image       *string           `json:"image"`
	Command     []string          `json:"command"`
	Env         map[string]string `json:"env"`
	Systems     []string          `json:"systems,omitempty"`
	Timeout     string            `json:"timeout"`
	State       JobState          `json:"state"`
	ExitCode    *int              `json:"exitCode"`
	ContainerID *string           `json:"containerId"`
	Error       *string           `json:"error"`
	CreatedAt   string            `json:"createdAt"`
	StartedAt   *string           `json:"startedAt"`
	FinishedAt  *string           `json:"finishedAt"`
}

type State struct {
	Apps    map[string]*AppRecord    `json:"apps"`
	Systems map[string]*SystemRecord `json:"systems"`
	Jobs    map[string]*JobRecord    `json:"jobs"`
	Peers   map[string]*PeerRecord   `json:"peers"`

	// Records guards the maps — node is single-threaded, Go is not; handlers
	// take Lock, the proxy takes RLock. Save() has its own file mutex.
	Records sync.RWMutex `json:"-"`
	mu      sync.Mutex   `json:"-"`
	file    string       `json:"-"`
}

// SystemsOf returns every system the app is a member of.
func (s *State) SystemsOf(app string) []*SystemRecord {
	var out []*SystemRecord
	for _, sys := range s.Systems {
		for _, m := range sys.Members {
			if m == app {
				out = append(out, sys)
				break
			}
		}
	}
	return out
}

type NodeConfig struct {
	Name      string `json:"name,omitempty"`
	Token     string `json:"token,omitempty"`
	Bind      string `json:"bind,omitempty"`      // 0.0.0.0 when the node is open
	Advertise string `json:"advertise,omitempty"` // what peers dial for trunks
}

// NodeFile is the node.json path (the CLI edits it; the daemon reads it).
func NodeFile() string { return filepath.Join(Dir(), "node.json") }

func LoadNodeFile() *NodeConfig {
	var n NodeConfig
	if data, err := os.ReadFile(NodeFile()); err == nil {
		_ = json.Unmarshal(data, &n)
	}
	return &n
}

func SaveNodeFile(n *NodeConfig) error {
	data, _ := json.MarshalIndent(n, "", "  ")
	return os.WriteFile(NodeFile(), data, 0o600)
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
	s := &State{Apps: map[string]*AppRecord{}, Systems: map[string]*SystemRecord{}, Jobs: map[string]*JobRecord{}, Peers: map[string]*PeerRecord{}, file: filepath.Join(dir, "state.json")}
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
	if s.Systems == nil {
		s.Systems = map[string]*SystemRecord{}
	}
	if s.Jobs == nil {
		s.Jobs = map[string]*JobRecord{}
	}
	if s.Peers == nil {
		s.Peers = map[string]*PeerRecord{}
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

// AllocateHostPort hands out the first free port >= the base (default
// 20000; SLAB_PORT_BASE overrides — multiple daemons on one host must not
// carve up the same range) among records.
func (s *State) AllocateHostPort() int {
	base := 20000
	if v := os.Getenv("SLAB_PORT_BASE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			base = n
		}
	}
	used := map[int]bool{}
	for _, a := range s.Apps {
		if a.HostPort != nil {
			used[*a.HostPort] = true
		}
	}
	p := base
	for used[p] {
		p++
	}
	return p
}

// Secrets live one JSON file per app under SLAB_DIR/secrets, chmod 600 —
// plaintext-on-disk v0 honesty, same as the TS daemon.
func secretsFile(app string) string { return filepath.Join(Dir(), "secrets", app+".json") }

func GetSecrets(app string) map[string]string {
	data, err := os.ReadFile(secretsFile(app))
	if err != nil {
		return map[string]string{}
	}
	var out map[string]string
	if json.Unmarshal(data, &out) != nil || out == nil {
		return map[string]string{}
	}
	return out
}

func SetSecrets(app string, values map[string]string) error {
	merged := GetSecrets(app)
	for k, v := range values {
		merged[k] = v
	}
	if err := os.MkdirAll(filepath.Join(Dir(), "secrets"), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(merged, "", "  ")
	return os.WriteFile(secretsFile(app), data, 0o600)
}

func DeleteSecrets(app string) { _ = os.Remove(secretsFile(app)) }

// EnsureNode loads or creates node.json (name + auth token).
func EnsureNode() (*NodeConfig, error) {
	file := NodeFile()
	data, err := os.ReadFile(file)
	if err == nil {
		var n NodeConfig
		if err := json.Unmarshal(data, &n); err == nil {
			if env := os.Getenv("SLAB_NODE_NAME"); env != "" {
				n.Name = env // env wins, same as the TS daemon
			}
			return &n, nil
		}
	}
	name := os.Getenv("SLAB_NODE_NAME")
	if name == "" {
		name, _ = os.Hostname()
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	n := &NodeConfig{Name: name, Token: hex.EncodeToString(buf)}
	out, _ := json.MarshalIndent(n, "", "  ")
	if err := os.WriteFile(file, out, 0o600); err != nil {
		return nil, err
	}
	return n, nil
}
