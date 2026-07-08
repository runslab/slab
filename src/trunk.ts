// slab — trunk: the network layer between nodes (docs/design/trunks.md).
//
// One trunk container per system per node. It joins the node's
// slab-net-<system> bridge carrying a DNS alias for every REMOTE member, so
// when a local member dials http://<remote>:<port>, Docker DNS hands it the
// trunk's IP. The trunk accepts that TCP stream on the member's port, dials
// the target node's trunk ingress, sends a one-line preamble
// ("<token> <member>\n"), and pipes bytes. The receiving trunk verifies the
// token and pipes on to the real container via its own bridge's Docker DNS.
// Plain TCP both ends — HTTP, postgres, anything.
//
// The script below runs inside node:22-alpine with no dependencies; its
// TrunkConfig arrives via the TRUNK_CONFIG env var.

export const TRUNK_INGRESS_PORT = 9410

export const trunkScript = `// slab trunk — generated; do not edit (source: src/trunk.ts)
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
      up.write(cfg.token + ' ' + member + '\\n')
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
