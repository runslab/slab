// Package cli is the slab command surface — the Go twin of src/cli.ts.
// Every command talks to the daemon over HTTP; --node re-points at a peer;
// commands self-start the local daemon when it isn't running.
package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/runslab/slab/go/internal/gitsrc"
	"github.com/runslab/slab/go/internal/manifest"
	"github.com/runslab/slab/go/internal/state"
)

var Version = "dev"

func daemonPort() int {
	if v := os.Getenv("SLAB_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			return p
		}
	}
	return 7766
}

// ── api client ──────────────────────────────────────────────────────────────

type apiClient struct {
	base  string
	token string
}

var localAPI = &apiClient{base: fmt.Sprintf("http://127.0.0.1:%d", daemonPort())}
var api = localAPI // --node re-points this

// set when --node targets a peer — the ship-image deploy path streams a
// docker-save tarball at the peer's raw url
var remotePeer *apiClient
var remotePeerName string

func (c *apiClient) req(method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		rd = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := (&http.Client{Timeout: 30 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			return fmt.Errorf("%s", e.Error)
		}
		return fmt.Errorf("%s %s -> %d", method, path, resp.StatusCode)
	}
	if out != nil {
		if s, ok := out.(*string); ok {
			*s = string(raw)
			return nil
		}
		return json.Unmarshal(raw, out)
	}
	return nil
}

// reqStream sends a raw body (e.g. a docker-save tarball) — no JSON wrapping.
func (c *apiClient) reqStream(method, path string, body io.Reader) error {
	req, _ := http.NewRequest(method, c.base+path, body)
	req.Header.Set("content-type", "application/x-tar")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := (&http.Client{Timeout: 30 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("image ship failed: peer answered %d %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// stream copies a plain-text streaming response (follow logs) to w.
func (c *apiClient) stream(method, path string, w io.Writer) error {
	req, _ := http.NewRequest(method, c.base+path, nil)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := (&http.Client{}).Do(req) // no timeout — follow runs until Ctrl-C
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("logs failed: %d %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

func getJSON(path string) (map[string]any, error) {
	var out map[string]any
	err := api.req("GET", path, nil, &out)
	return out, err
}

// ── helpers ─────────────────────────────────────────────────────────────────

func fail(err error) {
	fmt.Fprintf(os.Stderr, "error: %s\n", err.Error())
	os.Exit(1)
}

func relativeTime(iso string) string {
	if iso == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		if t, err = time.Parse("2006-01-02T15:04:05.000Z", iso); err != nil {
			return "-"
		}
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func table(header []string, rows [][]string) {
	widths := make([]int, len(header))
	for i, h := range header {
		widths[i] = len(h)
	}
	for _, r := range rows {
		for i, c := range r {
			if len(c) > widths[i] {
				widths[i] = len(c)
			}
		}
	}
	line := func(r []string) string {
		var b strings.Builder
		for i, c := range r {
			b.WriteString(c)
			b.WriteString(strings.Repeat(" ", widths[i]-len(c)+2))
		}
		return strings.TrimRight(b.String(), " ")
	}
	fmt.Println(line(header))
	for _, r := range rows {
		fmt.Println(line(r))
	}
}

func appURL(name string, proxyPort any) string {
	return fmt.Sprintf("http://%s.localhost:%v", name, proxyPort)
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func health() (map[string]any, error) { return getJSON("/v1/health") }

// ensureDaemon boots the local daemon when it isn't running (detached,
// logging to SLAB_DIR/daemon.log) — no "start it first" dead ends.
func ensureDaemon() error {
	if _, err := localAPI.req2("GET", "/v1/health"); err == nil {
		return nil
	}
	fmt.Fprintln(os.Stderr, "daemon not running — starting it…")
	if err := spawnDaemon(); err != nil {
		return err
	}
	for i := 0; i < 40; i++ {
		if _, err := localAPI.req2("GET", "/v1/health"); err == nil {
			fmt.Fprintln(os.Stderr, "daemon up.")
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("daemon did not come up — check %s", filepath.Join(state.Dir(), "daemon.log"))
}

func (c *apiClient) req2(method, path string) (map[string]any, error) {
	var out map[string]any
	req, _ := http.NewRequest(method, c.base+path, nil)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out, nil
}

func spawnDaemon() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	_ = os.MkdirAll(state.Dir(), 0o755)
	logf, err := os.OpenFile(filepath.Join(state.Dir(), "daemon.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	cmd := exec.Command(self, "daemon")
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}

func restartDaemon() error {
	if data, err := os.ReadFile(filepath.Join(state.Dir(), "daemon.pid")); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && pid > 1 {
			_ = syscall.Kill(pid, syscall.SIGTERM)
		}
	}
	time.Sleep(800 * time.Millisecond)
	if err := spawnDaemon(); err != nil {
		return err
	}
	for i := 0; i < 40; i++ {
		if _, err := localAPI.req2("GET", "/v1/health"); err == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("daemon did not come back — check %s", filepath.Join(state.Dir(), "daemon.log"))
}

// ── entry ───────────────────────────────────────────────────────────────────

var noDaemonNeeded = map[string]bool{"init": true, "upgrade": true, "feedback": true, "version": true, "help": true, "": true}
var localOnly = map[string]bool{"upgrade": true, "node": true, "init": true}

func Run(args []string) {
	// global --node/-N extraction (anywhere in args)
	var nodeTarget string
	rest := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--node" || args[i] == "-N" {
			if i+1 < len(args) {
				nodeTarget = args[i+1]
				i++
			}
			continue
		}
		rest = append(rest, args[i])
	}
	cmd := ""
	if len(rest) > 0 {
		cmd = rest[0]
		rest = rest[1:]
	}

	if !noDaemonNeeded[cmd] && os.Getenv("SLAB_DAEMON_URL") == "" {
		if err := ensureDaemon(); err != nil {
			fail(err)
		}
	}

	if nodeTarget != "" {
		if localOnly[cmd] {
			fail(fmt.Errorf("\"slab %s\" runs on the machine itself — ssh to %s for that", cmd, nodeTarget))
		}
		if err := pointAtNode(nodeTarget, cmd, rest); err != nil {
			fail(err)
		}
	}

	if err := dispatch(cmd, rest); err != nil {
		fail(err)
	}
}

func pointAtNode(target, cmd string, rest []string) error {
	h, err := health()
	if err != nil {
		return err
	}
	if target == "any" {
		return scheduleOnLeastBusy(cmd, rest, h)
	}
	if fmt.Sprint(h["node"]) == target {
		return nil // targeting ourselves
	}
	peers, err := getJSON("/v1/peers")
	if err != nil {
		return err
	}
	list, _ := peers["peers"].([]any)
	for _, p := range list {
		pm := p.(map[string]any)
		if pm["name"] == target {
			token, _ := pm["token"].(string)
			api = &apiClient{base: fmt.Sprint(pm["url"]), token: token}
			remotePeer = api
			remotePeerName = target
			return nil
		}
	}
	known := []string{fmt.Sprint(h["node"]) + " (local)"}
	for _, p := range list {
		known = append(known, fmt.Sprint(p.(map[string]any)["name"]))
	}
	return fmt.Errorf("unknown node %q — known nodes: %s. Register with: slab peer add %s <url> --token <t>", target, strings.Join(known, ", "), target)
}

// --node any: pick the node with the fewest active jobs (git-sourced runs only).
func scheduleOnLeastBusy(cmd string, rest []string, h map[string]any) error {
	if cmd != "run" {
		return fmt.Errorf("--node any only applies to \"slab run\" — name a node for other commands")
	}
	src := ""
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		src = rest[0]
	}
	localName := fmt.Sprint(h["node"])
	abs, _ := filepath.Abs(src)
	if src == "" || !gitsrc.LooksLikeGitURL(src) || isDir(abs) {
		fmt.Fprintf(os.Stderr, "scheduling on %s — directory sources can't roam (use a git url to fan out)\n", localName)
		return nil
	}
	peers, err := getJSON("/v1/peers")
	if err != nil {
		return err
	}
	type cand struct {
		name   string
		c      *apiClient
		active int
	}
	active := func(c *apiClient) int {
		var out struct {
			Jobs []struct {
				State string `json:"state"`
			} `json:"jobs"`
		}
		if err := c.req("GET", "/v1/jobs", nil, &out); err != nil {
			return 1 << 30
		}
		n := 0
		for _, j := range out.Jobs {
			if j.State == "queued" || j.State == "building" || j.State == "running" {
				n++
			}
		}
		return n
	}
	best := cand{name: localName, c: localAPI, active: active(localAPI)}
	if list, ok := peers["peers"].([]any); ok {
		for _, p := range list {
			pm := p.(map[string]any)
			token, _ := pm["token"].(string)
			c := &apiClient{base: fmt.Sprint(pm["url"]), token: token}
			if a := active(c); a < best.active {
				best = cand{name: fmt.Sprint(pm["name"]), c: c, active: a}
			}
		}
	}
	if best.active >= 1<<30 {
		return fmt.Errorf("no reachable node to schedule on")
	}
	plural := "s"
	if best.active == 1 {
		plural = ""
	}
	fmt.Fprintf(os.Stderr, "scheduling on %s (%d active job%s)\n", best.name, best.active, plural)
	api = best.c
	return nil
}

// ── url helpers used by commands ────────────────────────────────────────────

func openInBrowser(u string) {
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	_ = exec.Command(opener, u).Start()
}

func queryEscape(s string) string { return url.QueryEscape(s) }

// resolveAppName mirrors the TS deploy resolution: git url -> create-or-find;
// dir -> ensure created; else treat as an app name.
func resolveAppName(arg, target string) (string, error) {
	abs, _ := filepath.Abs(arg)
	if gitsrc.LooksLikeGitURL(arg) && !isDir(abs) {
		body := map[string]any{"gitUrl": arg}
		if target != "" {
			body["target"] = target
		}
		var out struct {
			App struct {
				Name string `json:"name"`
			} `json:"app"`
		}
		err := api.req("POST", "/v1/apps", body, &out)
		if err == nil {
			return out.App.Name, nil
		}
		if strings.Contains(err.Error(), "exists") {
			if i := strings.Index(err.Error(), `"`); i >= 0 {
				restStr := err.Error()[i+1:]
				if j := strings.Index(restStr, `"`); j >= 0 {
					return restStr[:j], nil
				}
			}
		}
		return "", err
	}
	if isDir(abs) {
		m, err := manifest.Load(abs)
		if err != nil {
			return "", err
		}
		if _, err := getJSON("/v1/apps/" + m.Name); err != nil {
			body := map[string]any{"sourceDir": abs}
			if target != "" {
				body["target"] = target
			}
			if err := api.req("POST", "/v1/apps", body, nil); err != nil {
				return "", err
			}
		}
		return m.Name, nil
	}
	return arg, nil
}
