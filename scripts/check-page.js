// Renders the dashboard, extracts its inline <script>, and syntax-checks it.
// The page JS is string-built inside a TS template literal — three escaping
// layers deep — so a lost backslash can kill the whole UI. This catches it
// at build time instead of in the browser.
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { dashboardHtml } = require('../dist/dashboard')

const html = dashboardHtml(8080)
const m = /<script>([\s\S]*?)<\/script>/.exec(html)
if (!m) { console.error('check-page: no <script> found'); process.exit(1) }
const tmp = path.join(os.tmpdir(), 'slab-page-check.js')
fs.writeFileSync(tmp, m[1])
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  console.log('check-page: dashboard script parses OK')
} catch (err) {
  console.error('check-page: dashboard script has a syntax error:')
  console.error(String(err.stderr))
  process.exit(1)
}
