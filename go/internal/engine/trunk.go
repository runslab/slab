// Trunks — the network layer between nodes (docs/design/trunks.md).
// The trunk program is the SAME dependency-free JS the TS daemon generates
// (src/trunk.ts), run in node:22-alpine: Go trunks and TS trunks speak one
// wire protocol by construction. Do not edit the script here — port changes
// from src/trunk.ts.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"

	"github.com/docker/docker/api/types/container"
	dnetwork "github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"

	"github.com/runslab/slab/go/internal/state"
)

const TrunkIngressPort = 9410
const trunkImage = "node:22-alpine"

// TrunkConfig mirrors the TS TrunkConfig — it crosses nodes as JSON.
type TrunkConfig struct {
	Token       string                   `json:"token"`
	IngressPort int                      `json:"ingressPort"`
	Local       map[string]TrunkLocal    `json:"local"`
	Remote      map[string]TrunkRemote   `json:"remote"`
	Peers       map[string]TrunkPeerAddr `json:"peers"`
}

type TrunkLocal struct {
	Port int `json:"port"`
}

type TrunkRemote struct {
	Port int    `json:"port"`
	Node string `json:"node"`
}

type TrunkPeerAddr struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

const trunkScript = `// slab trunk — generated; do not edit (source: src/trunk.ts)
'use strict'
const net = require('net')
const cfg = JSON.parse(process.env.TRUNK_CONFIG)

function pipe(a, b) {
  a.pipe(b); b.pipe(a)
  a.on('error', () => b.destroy()); b.on('error', () => a.destroy())
  a.on('close', () => b.destroy()); b.on('close', () => a.destroy())
}

// egress: a listener per remote member, on that member's own port —
// docker dns aliases point the member name at this container
for (const [member, r] of Object.entries(cfg.remote)) {
  const peer = cfg.peers[r.node]
  if (!peer) { console.error('trunk: no peer entry for node ' + r.node); continue }
  net.createServer((sock) => {
    const up = net.connect(peer.port, peer.host, () => {
      up.write(cfg.token + ' ' + member + '\n')
      pipe(sock, up)
    })
    up.on('error', () => sock.destroy())
  }).listen(r.port, '0.0.0.0', () => {
    console.log('trunk egress: ' + member + ':' + r.port + ' -> ' + r.node + ' @ ' + peer.host + ':' + peer.port)
  })
}

// ingress: inbound tunnels from other trunks; preamble then raw pipe
net.createServer((sock) => {
  let acc = Buffer.alloc(0)
  const onData = (d) => {
    acc = Buffer.concat([acc, d])
    const nl = acc.indexOf(10)
    if (nl < 0) { if (acc.length > 512) sock.destroy(); return }
    sock.removeListener('data', onData)
    const [token, member] = acc.subarray(0, nl).toString().split(' ')
    const rest = acc.subarray(nl + 1)
    const local = cfg.local[member]
    if (token !== cfg.token || !local) { sock.destroy(); return }
    const up = net.connect(local.port, member, () => {   // docker dns -> the real container
      if (rest.length) up.write(rest)
      pipe(sock, up)
    })
    up.on('error', () => sock.destroy())
  }
  sock.on('data', onData)
  sock.on('error', () => {})
}).listen(cfg.ingressPort, '0.0.0.0', () => {
  console.log('trunk ingress: :' + cfg.ingressPort + ' — local members: ' + Object.keys(cfg.local).join(', '))
})
`

// WriteTrunkScript persists the trunk program under SLAB_DIR/trunks.
func WriteTrunkScript(systemName string) (string, error) {
	dir := filepath.Join(state.Dir(), "trunks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, systemName+".js")
	return p, os.WriteFile(p, []byte(trunkScript), 0o644)
}

var ipv4Re = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)

// trunkHost resolves a peer host ON THE HOST (containers can't do mDNS) and
// rewrites loopback to host.docker.internal for same-machine clusters.
func trunkHost(h string) string {
	if h == "127.0.0.1" || h == "localhost" {
		return "host.docker.internal"
	}
	if ipv4Re.MatchString(h) || h == "host.docker.internal" {
		return h
	}
	if addrs, err := net.LookupIP(h); err == nil {
		for _, a := range addrs {
			if v4 := a.To4(); v4 != nil {
				if v4.IsLoopback() {
					return "host.docker.internal"
				}
				return v4.String()
			}
		}
	}
	return h // best effort — leave unresolved names for the container to try
}

// RunTrunk starts (or replaces) the system's trunk container: joined to the
// system network with an alias per REMOTE member, ingress published on
// hostPort, config via env.
func (e *Engine) RunTrunk(ctx context.Context, key, scriptPath string, cfg TrunkConfig, networkName string, hostPort int) (string, error) {
	e.RemoveTrunk(ctx, key)
	if err := e.EnsureImage(ctx, trunkImage); err != nil {
		return "", err
	}

	peers := map[string]TrunkPeerAddr{}
	for node, p := range cfg.Peers {
		peers[node] = TrunkPeerAddr{Host: trunkHost(p.Host), Port: p.Port}
	}
	cfg.Peers = peers
	cfg.IngressPort = TrunkIngressPort
	cfgJSON, _ := json.Marshal(cfg)

	portKey := nat.Port(fmt.Sprintf("%d/tcp", TrunkIngressPort))
	created, err := e.cli.ContainerCreate(ctx,
		&container.Config{
			Image:        trunkImage,
			Labels:       map[string]string{"slab.trunk": key},
			Cmd:          []string{"node", "/trunk.js"},
			Env:          []string{"TRUNK_CONFIG=" + string(cfgJSON)},
			ExposedPorts: nat.PortSet{portKey: struct{}{}},
		},
		&container.HostConfig{
			Binds:         []string{scriptPath + ":/trunk.js:ro"},
			PortBindings:  nat.PortMap{portKey: []nat.PortBinding{{HostIP: "0.0.0.0", HostPort: fmt.Sprint(hostPort)}}},
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			ExtraHosts:    []string{"host.docker.internal:host-gateway"},
		}, nil, nil, "slab-trunk-"+key)
	if err != nil {
		return "", fmt.Errorf("failed to create trunk %s: %w", key, err)
	}

	// alias every REMOTE member at this trunk on the system network
	aliases := make([]string, 0, len(cfg.Remote))
	for m := range cfg.Remote {
		aliases = append(aliases, m)
	}
	if err := e.cli.NetworkConnect(ctx, networkName, created.ID, &dnetwork.EndpointSettings{Aliases: aliases}); err != nil {
		_ = e.cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true})
		return "", fmt.Errorf("failed to join trunk to %s: %w", networkName, err)
	}
	if err := e.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		_ = e.cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true})
		return "", fmt.Errorf("failed to start trunk %s: %w", key, err)
	}
	return created.ID, nil
}

// RemoveTrunk force-removes the trunk container (ignore-if-absent).
func (e *Engine) RemoveTrunk(ctx context.Context, key string) {
	_ = e.cli.ContainerRemove(ctx, "slab-trunk-"+key, container.RemoveOptions{Force: true})
}
