// Package manifest parses slab.toml with byte-identical semantics to
// src/manifest.ts — the TS parser is the reference; scripts/conformance.js
// is the judge. Any divergence is a bug here, not there.
package manifest

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

type AppType string

const (
	Service  AppType = "service"
	Function AppType = "function"
)

// Manifest mirrors the Manifest interface in src/types.ts.
type Manifest struct {
	Name        string            `json:"name"`
	Type        AppType           `json:"type"`
	Target      string            `json:"target,omitempty"`
	Port        int               `json:"port"`
	Public      bool              `json:"public"`
	Image       string            `json:"image,omitempty"`
	Dockerfile  string            `json:"dockerfile,omitempty"`
	Postgres    bool              `json:"postgres"`
	Secrets     []string          `json:"secrets"`
	Volumes     []string          `json:"volumes"`
	IdleTimeout string            `json:"idle_timeout"`
	Env         map[string]string `json:"env"`
}

var nameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)
var volumeNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

// raw is the loose TOML shape before validation/coercion.
type raw struct {
	Name        string            `toml:"name"`
	Type        string            `toml:"type"`
	Target      string            `toml:"target"`
	Port        int               `toml:"port"`
	Public      *bool             `toml:"public"`
	Image       string            `toml:"image"`
	Dockerfile  string            `toml:"dockerfile"`
	Postgres    bool              `toml:"postgres"`
	Secrets     []string          `toml:"secrets"`
	Volumes     []string          `toml:"volumes"`
	IdleTimeout string            `toml:"idle_timeout"`
	Env         map[string]string `toml:"env"`
}

// Load reads <sourceDir>/slab.toml, or infers a manifest from the Dockerfile
// when there is none — same fallback the TS daemon performs.
func Load(sourceDir string) (*Manifest, error) {
	file := filepath.Join(sourceDir, "slab.toml")
	data, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return infer(sourceDir)
		}
		return nil, err
	}

	var r raw
	if err := toml.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("invalid slab.toml: %w", err)
	}

	if !nameRe.MatchString(r.Name) {
		return nil, fmt.Errorf("invalid app name %q — lowercase letters, digits, hyphens, 2-31 chars", r.Name)
	}
	typ := Service
	if r.Type == "function" {
		typ = Function
	}
	if r.Port < 1 || r.Port > 65535 {
		return nil, fmt.Errorf("invalid port %q in slab.toml", fmt.Sprint(r.Port))
	}
	dockerfile := r.Dockerfile
	if r.Image == "" {
		if dockerfile != "" {
			if _, err := os.Stat(filepath.Join(sourceDir, dockerfile)); err != nil {
				return nil, fmt.Errorf("slab.toml points at dockerfile %q but %s/%s does not exist", dockerfile, sourceDir, dockerfile)
			}
		} else {
			found, err := FindDockerfile(sourceDir)
			if err != nil {
				return nil, err
			}
			if found == "" {
				return nil, fmt.Errorf("%s has neither an \"image\" in slab.toml nor a Dockerfile", sourceDir)
			}
			if rel, _ := filepath.Rel(sourceDir, found); rel != "Dockerfile" {
				dockerfile = rel
			}
		}
	}
	volumes := make([]string, 0, len(r.Volumes))
	for _, v := range r.Volumes {
		if err := validateVolume(v); err != nil {
			return nil, err
		}
		volumes = append(volumes, v)
	}
	idle := r.IdleTimeout
	if idle == "" {
		idle = "5m"
	}
	env := r.Env
	if env == nil {
		env = map[string]string{}
	}
	secrets := r.Secrets
	if secrets == nil {
		secrets = []string{}
	}

	return &Manifest{
		Name:        r.Name,
		Type:        typ,
		Target:      r.Target,
		Port:        r.Port,
		Public:      r.Public == nil || *r.Public, // default true; only literal false disables
		Image:       r.Image,
		Dockerfile:  dockerfile,
		Postgres:    r.Postgres,
		Secrets:     secrets,
		Volumes:     volumes,
		IdleTimeout: idle,
		Env:         env,
	}, nil
}

// validateVolume enforces "name:/container/path" — named volumes only.
func validateVolume(entry string) error {
	i := strings.Index(entry, ":")
	name, target := "", ""
	if i >= 0 {
		name, target = entry[:i], entry[i+1:]
	}
	if !volumeNameRe.MatchString(name) || !strings.HasPrefix(target, "/") {
		return fmt.Errorf("invalid volume %q — expected \"name:/container/path\" (named volumes only, no host paths)", entry)
	}
	return nil
}

var exposeRe = regexp.MustCompile(`(?im)^\s*EXPOSE\s+(\d+)`)

// FindDockerfile searches the source tree (depth <= 3) for a Dockerfile —
// memos keeps it in scripts/, plenty of repos use docker/. Exact "Dockerfile"
// beats variants; shallower beats deeper; a tie is an error listing the
// candidates. The build context is always the repo root.
func FindDockerfile(sourceDir string) (string, error) {
	ignored := map[string]bool{"node_modules": true, ".git": true, "vendor": true, "dist": true, "build_output": true}
	var candidates []string
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "Dockerfile") {
				candidates = append(candidates, filepath.Join(dir, e.Name()))
			} else if e.IsDir() && depth < 3 && !ignored[e.Name()] && !strings.HasPrefix(e.Name(), ".") {
				walk(filepath.Join(dir, e.Name()), depth+1)
			}
		}
	}
	walk(sourceDir, 0)
	if len(candidates) == 0 {
		return "", nil
	}
	var exact []string
	for _, c := range candidates {
		if filepath.Base(c) == "Dockerfile" {
			exact = append(exact, c)
		}
	}
	pool := candidates
	if len(exact) > 0 {
		pool = exact
	}
	sort.Slice(pool, func(i, j int) bool {
		di, dj := strings.Count(pool[i], string(filepath.Separator)), strings.Count(pool[j], string(filepath.Separator))
		if di != dj {
			return di < dj
		}
		return pool[i] < pool[j]
	})
	if len(exact) != 1 && len(pool) > 1 {
		shallow := strings.Count(pool[0], string(filepath.Separator))
		var tied []string
		for _, c := range pool {
			if strings.Count(c, string(filepath.Separator)) == shallow {
				rel, _ := filepath.Rel(sourceDir, c)
				tied = append(tied, rel)
			}
		}
		if len(tied) > 1 {
			return "", fmt.Errorf("Found several Dockerfiles (%s) — add a slab.toml to choose, or keep one", strings.Join(tied, ", "))
		}
	}
	return pool[0], nil
}

// infer builds a manifest for a Dockerfile-only source: name from the dir,
// type service, port from the first EXPOSE (default 3000), PORT injected.
func infer(sourceDir string) (*Manifest, error) {
	found, err := FindDockerfile(sourceDir)
	if err != nil {
		return nil, err
	}
	if found == "" {
		return nil, fmt.Errorf("no slab.toml found in %s — and no Dockerfile to infer an app from. Add a slab.toml (slab init) or a Dockerfile", sourceDir)
	}
	df, err := os.ReadFile(found)
	if err != nil {
		return nil, fmt.Errorf("no slab.toml found in %s — and no Dockerfile to infer an app from. Add a slab.toml (slab init) or a Dockerfile", sourceDir)
	}
	port := 3000
	if m := exposeRe.FindSubmatch(df); m != nil {
		fmt.Sscanf(string(m[1]), "%d", &port)
	}
	dockerfile := ""
	if rel, _ := filepath.Rel(sourceDir, found); rel != "Dockerfile" {
		dockerfile = rel
	}
	return &Manifest{
		Name:        sanitizeName(filepath.Base(sourceDir)),
		Type:        Service,
		Port:        port,
		Public:      true,
		Dockerfile:  dockerfile,
		Secrets:     []string{},
		Volumes:     []string{},
		IdleTimeout: "5m",
		Env:         map[string]string{"PORT": fmt.Sprint(port)},
	}, nil
}

var durationRe = regexp.MustCompile(`^(\d+)(s|m|h)$`)

// ParseDuration mirrors the TS parseDuration: "5m" | "30s" | "1h", with a
// 5-minute fallback for anything malformed.
func ParseDuration(s string) time.Duration {
	m := durationRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 5 * time.Minute
	}
	n, _ := strconv.Atoi(m[1])
	switch m[2] {
	case "s":
		return time.Duration(n) * time.Second
	case "h":
		return time.Duration(n) * time.Hour
	default:
		return time.Duration(n) * time.Minute
	}
}

var nonName = regexp.MustCompile(`[^a-z0-9-]+`)
var multiDash = regexp.MustCompile(`-+`)

func sanitizeName(rawName string) string {
	name := strings.ToLower(rawName)
	name = nonName.ReplaceAllString(name, "-")
	name = multiDash.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-")
	if name == "" || name[0] < 'a' || name[0] > 'z' {
		name = "app-" + name
	}
	if len(name) > 31 {
		name = name[:31]
	}
	for len(name) < 2 {
		name += "0"
	}
	if !nameRe.MatchString(name) {
		return "app"
	}
	return name
}
