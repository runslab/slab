// Package tunnel wraps cloudflare quick tunnels — the Go twin of
// src/tunnel.ts. One cloudflared child per exposed app, pointed at the slab
// ingress with a host header so routing and wake-on-request still work.
package tunnel

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"sync"
	"time"
)

var urlRe = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

type Manager struct {
	mu      sync.Mutex
	tunnels map[string]*exec.Cmd
}

func New() *Manager { return &Manager{tunnels: map[string]*exec.Cmd{}} }

// Open spawns cloudflared for the app and returns the assigned public URL.
func (m *Manager) Open(appName string, proxyPort int) (string, error) {
	m.Close(appName)
	cmd := exec.Command("cloudflared",
		"tunnel",
		"--url", fmt.Sprintf("http://127.0.0.1:%d", proxyPort),
		"--http-host-header", appName+".localhost",
	)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to spawn cloudflared: %s — brew install cloudflared", err.Error())
	}

	urlC := make(chan string, 1)
	scan := func(r io.Reader) {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			if u := urlRe.FindString(sc.Text()); u != "" {
				select {
				case urlC <- u:
				default:
				}
			}
		}
	}
	go scan(stderr) // cloudflared logs the assigned URL to stderr
	go scan(stdout)

	select {
	case u := <-urlC:
		m.mu.Lock()
		m.tunnels[appName] = cmd
		m.mu.Unlock()
		go func() { _ = cmd.Wait() }() // reap on exit
		return u, nil
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return "", fmt.Errorf("cloudflared did not report a URL within 30s")
	}
}

// Close kills the app's tunnel if one is open.
func (m *Manager) Close(appName string) {
	m.mu.Lock()
	cmd := m.tunnels[appName]
	delete(m.tunnels, appName)
	m.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
