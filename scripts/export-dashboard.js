#!/usr/bin/env node
// Exports the rendered dashboard (and favicon) for the Go daemon to embed —
// one dashboard source of truth (src/dashboard.ts), two daemons serving it.
// Runs as part of `npm run build`. The proxy port is rendered as a sentinel
// the Go handler string-replaces at serve time.
const fs = require('fs')
const path = require('path')
const { dashboardHtml, faviconSvg } = require('../dist/dashboard.js')

const SENTINEL = 987654
const html = dashboardHtml(SENTINEL)
const hits = html.split(String(SENTINEL)).length - 1
if (hits < 1) {
  console.error('export-dashboard: sentinel port did not appear in the rendered html')
  process.exit(1)
}
const outDir = path.join(__dirname, '..', 'go', 'internal', 'dashboard')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'dashboard.html'), html)
fs.writeFileSync(path.join(outDir, 'favicon.svg'), faviconSvg)
console.log(`export-dashboard: dashboard.html (${(html.length / 1024).toFixed(0)}KB, ${hits} port slots) + favicon.svg`)
