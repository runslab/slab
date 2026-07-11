// Package logship pushes container logs to Loki — the platform ships logs
// because it owns the containers, so no host-mounted agent (promtail) is
// needed. A supervisor reconciles the running-app set every few seconds,
// runs one streaming tail per container, batches lines, and POSTs them to
// Loki's push API labeled {app,node}.
//
// Zero-config: shipping turns on whenever an app named "loki" is running
// (its host port is resolved from state) — deploy examples/observatory and
// logs just flow. SLAB_LOKI_URL overrides the target explicitly.
package logship

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/runslab/slab/go/internal/logbuf"
	"github.com/runslab/slab/go/internal/state"
)

type Shipper struct {
	St   *state.State
	Node string

	mu      sync.Mutex
	tailers map[string]context.CancelFunc // app -> stop
}

// lokiURL resolves where to push: SLAB_LOKI_URL wins; else a running app
// named "loki" with a host port (http://127.0.0.1:<port>). "" = shipping off.
func (s *Shipper) lokiURL() string {
	if u := os.Getenv("SLAB_LOKI_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	s.St.Records.RLock()
	defer s.St.Records.RUnlock()
	if a := s.St.Apps["loki"]; a != nil && a.State == state.Running && a.HostPort != nil {
		return fmt.Sprintf("http://127.0.0.1:%d", *a.HostPort)
	}
	return ""
}

// Run supervises tailers until ctx is cancelled.
func (s *Shipper) Run(ctx context.Context) {
	s.tailers = map[string]context.CancelFunc{}
	// the daemon's own log ring ships under app="slab-daemon"
	go s.tailRing(ctx)
	for {
		if s.lokiURL() != "" {
			s.reconcile(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// reconcile starts a tail for every running app (except loki itself) and
// stops tails for apps that are gone.
func (s *Shipper) reconcile(ctx context.Context) {
	s.St.Records.RLock()
	want := map[string]bool{}
	for _, a := range s.St.Apps {
		if a.Name == "loki" || a.State != state.Running {
			continue
		}
		want[a.Name] = true
	}
	s.St.Records.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	for app := range want {
		if _, running := s.tailers[app]; !running {
			tctx, cancel := context.WithCancel(ctx)
			s.tailers[app] = cancel
			go s.tail(tctx, app, "slab-"+app)
		}
	}
	for app, cancel := range s.tailers {
		if !want[app] {
			cancel()
			delete(s.tailers, app)
		}
	}
}

// tail streams a container's logs (from now) and pushes each line.
func (s *Shipper) tail(ctx context.Context, app, container string) {
	cmd := exec.CommandContext(ctx, "docker", "logs", "-f", "--tail", "0", container)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return
	}
	s.pump(ctx, app, stdout)
	_ = cmd.Wait()
}

// tailRing ships the daemon's own log lines.
func (s *Shipper) tailRing(ctx context.Context) {
	ch, unsub := logbuf.Default.Subscribe()
	defer unsub()
	batch := []logLine{}
	flush := func() {
		if len(batch) == 0 || s.lokiURL() == "" {
			return
		}
		s.push("slab-daemon", batch)
		batch = batch[:0]
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case line := <-ch:
			batch = append(batch, logLine{time.Now(), line})
			if len(batch) >= 200 {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}

type logLine struct {
	at   time.Time
	text string
}

// pump reads lines from a stream, batches, and pushes on a 1s cadence.
func (s *Shipper) pump(ctx context.Context, app string, r interface {
	Read([]byte) (int, error)
}) {
	buf := make([]byte, 4096)
	var partial []byte
	batch := []logLine{}
	flush := func() {
		if len(batch) == 0 || s.lokiURL() == "" {
			return
		}
		s.push(app, batch)
		batch = batch[:0]
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	lines := make(chan string, 256)
	go func() {
		for {
			n, err := r.Read(buf)
			if n > 0 {
				partial = append(partial, buf[:n]...)
				for {
					i := bytes.IndexByte(partial, '\n')
					if i < 0 {
						break
					}
					lines <- string(partial[:i])
					partial = partial[i+1:]
				}
			}
			if err != nil {
				close(lines)
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-lines:
			if !ok {
				flush()
				return
			}
			batch = append(batch, logLine{time.Now(), line})
			if len(batch) >= 200 {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}

// push POSTs a batch to Loki. Best-effort: Loki down -> drop, never block.
func (s *Shipper) push(app string, batch []logLine) {
	url := s.lokiURL()
	if url == "" {
		return
	}
	values := make([][2]string, 0, len(batch))
	for _, l := range batch {
		values = append(values, [2]string{fmt.Sprint(l.at.UnixNano()), l.text})
	}
	body, _ := json.Marshal(map[string]any{
		"streams": []map[string]any{{
			"stream": map[string]string{"app": app, "node": s.Node},
			"values": values,
		}},
	})
	req, _ := http.NewRequest("POST", url+"/loki/api/v1/push", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err == nil {
		resp.Body.Close()
	}
}
