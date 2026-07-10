// Package logbuf is the daemon's own in-memory log ring, so `slab logs
// --daemon` (and -N <peer> for it) can tail the daemon over the API — no
// matter where its stdout was redirected. log output goes to both the real
// stderr and this ring.
package logbuf

import (
	"io"
	"sync"
)

type Ring struct {
	mu      sync.Mutex
	lines   []string
	max     int
	subs    map[chan string]struct{}
	partial []byte
}

var Default = New(2000)

func New(max int) *Ring {
	return &Ring{max: max, subs: map[chan string]struct{}{}}
}

// Write satisfies io.Writer — plug it into log.SetOutput via io.MultiWriter.
func (r *Ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	r.partial = append(r.partial, p...)
	for {
		i := indexByte(r.partial, '\n')
		if i < 0 {
			break
		}
		line := string(r.partial[:i])
		r.partial = r.partial[i+1:]
		r.lines = append(r.lines, line)
		if len(r.lines) > r.max {
			r.lines = r.lines[len(r.lines)-r.max:]
		}
		for ch := range r.subs {
			select {
			case ch <- line:
			default:
			}
		}
	}
	r.mu.Unlock()
	return len(p), nil
}

// Tail returns the last n lines.
func (r *Ring) Tail(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || n > len(r.lines) {
		n = len(r.lines)
	}
	out := make([]string, n)
	copy(out, r.lines[len(r.lines)-n:])
	return out
}

// Subscribe returns a channel of new lines and an unsubscribe func.
func (r *Ring) Subscribe() (<-chan string, func()) {
	ch := make(chan string, 256)
	r.mu.Lock()
	r.subs[ch] = struct{}{}
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.subs, ch)
		close(ch)
		r.mu.Unlock()
	}
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

// MultiWriter tees the daemon's log output to real stderr and the ring.
func MultiWriter(stderr io.Writer) io.Writer { return io.MultiWriter(stderr, Default) }
