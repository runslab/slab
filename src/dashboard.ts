// Control-plane UI, served by the daemon at GET / (port 7766).
// Zero build step, zero deps, system fonts only.
// Design: each app is a "slab" — a machined rack unit in a vertical stack.
// Warm graphite + amber, breathing LEDs, req/min meter with client-side sparkline.

export function dashboardHtml(proxyPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>slab</title>
<style>
  :root {
    --bg: #131418; --rail: #0d0e11;
    --unit-hi: #26282f; --unit-lo: #1b1d22; --edge: #33363e; --groove: #0a0b0d;
    --text: #ece9e2; --dim: #9a9da5; --faint: #5f626a;
    --amber: #ffb454; --green: #71d68d; --red: #f07f78; --blue: #82b8e8;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background:
      radial-gradient(1200px 500px at 50% -10%, rgba(255,180,84,.05), transparent 60%),
      var(--bg);
    color: var(--text); min-height: 100vh;
    padding: clamp(20px, 4vw, 56px);
  }
  .wrap { max-width: 980px; margin: 0 auto; }

  header { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 30px; }
  .mark { display: flex; gap: 6px; }
  .mark span {
    display: grid; place-items: center; width: 44px; height: 44px;
    background: linear-gradient(180deg, var(--unit-hi), var(--unit-lo));
    border: 1px solid var(--edge); border-radius: 6px;
    font-weight: 800; font-size: 20px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 3px 8px rgba(0,0,0,.45);
  }
  .mark span:first-child {
    background: linear-gradient(180deg, #ffc36e, #f0a13e); color: #2a1e08; border-color: #b97f2e;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 3px 10px rgba(240,161,62,.25);
  }
  .stats { display: flex; gap: 28px; text-align: right; }
  .stat b { display: block; font-size: 20px; font-weight: 700; color: var(--text); }
  .stat span { font-size: 10px; text-transform: uppercase; letter-spacing: .16em; color: var(--faint); }
  .stat b em { font-style: normal; color: var(--faint); font-size: 13px; }

  /* the rack */
  .rack {
    background: var(--rail); border: 1px solid var(--groove); border-radius: 10px;
    padding: 10px; box-shadow: inset 0 2px 10px rgba(0,0,0,.6);
  }
  .unit {
    display: grid; grid-template-columns: 18px 1fr auto auto; gap: 20px; align-items: center;
    background: linear-gradient(180deg, var(--unit-hi), var(--unit-lo));
    border: 1px solid var(--edge); border-radius: 7px;
    padding: 18px 22px; margin-bottom: 10px; position: relative;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.05), 0 4px 10px rgba(0,0,0,.35);
    transition: transform .12s ease, box-shadow .12s ease;
  }
  .unit:last-child { margin-bottom: 0; }
  .unit:hover { transform: translateY(-1px); box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 8px 18px rgba(0,0,0,.45); }
  /* screws */
  .unit::before, .unit::after {
    content: ''; position: absolute; width: 5px; height: 5px; border-radius: 50%;
    background: var(--groove); box-shadow: inset 0 1px 1px rgba(0,0,0,.9), 0 1px 0 rgba(255,255,255,.05);
  }
  .unit::before { top: 8px; right: 8px; }
  .unit::after { bottom: 8px; right: 8px; }

  .led { width: 10px; height: 10px; border-radius: 50%; justify-self: center; }
  .running .led { background: var(--green); box-shadow: 0 0 10px var(--green), 0 0 2px var(--green); animation: breathe 2.8s ease-in-out infinite; }
  .sleeping .led { background: var(--blue); opacity: .65; box-shadow: 0 0 5px rgba(130,184,232,.4); }
  .stopped .led, .created .led { background: #3a3d44; }
  .error .led { background: var(--red); box-shadow: 0 0 10px var(--red); }
  .building .led { background: var(--amber); box-shadow: 0 0 10px var(--amber); animation: breathe .9s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: .3; box-shadow: none; } }
  @media (prefers-reduced-motion: reduce) { .led { animation: none !important; } }

  .plate .name { font-size: 17px; font-weight: 800; letter-spacing: .01em; }
  .plate .name small { font-weight: 500; font-size: 11px; color: var(--faint); margin-left: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .plate .spec { color: var(--faint); font-size: 11px; margin-top: 3px; }
  .plate .spec b { color: var(--dim); font-weight: 500; }
  .routes { margin-top: 8px; font-size: 12px; }
  .routes a { color: var(--blue); text-decoration: none; margin-right: 18px; }
  .routes a.pub { color: var(--amber); }
  .routes a:hover, .routes a:focus-visible { text-decoration: underline; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; border-radius: 2px; }
  .errmsg { color: var(--red); font-size: 11px; margin-top: 6px; max-width: 420px; }

  .meter { text-align: right; min-width: 120px; }
  .meter .rpm { font-size: 20px; font-weight: 700; color: var(--faint); }
  .meter .rpm.hot { color: var(--text); }
  .meter .rpm small { font-size: 10px; color: var(--faint); font-weight: 500; margin-left: 2px; }
  .meter svg { display: block; margin: 4px 0 0 auto; opacity: .9; }
  .meter .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .16em; color: var(--faint); margin-top: 2px; }

  .acts { display: flex; flex-direction: column; gap: 6px; opacity: 0; transition: opacity .15s; }
  .unit:hover .acts, .acts:focus-within { opacity: 1; }
  .acts .row { display: flex; gap: 6px; justify-content: flex-end; }
  button {
    background: rgba(0,0,0,.25); color: var(--dim); border: 1px solid var(--edge); border-radius: 5px;
    padding: 4px 11px; font: inherit; font-size: 11px; cursor: pointer;
  }
  button:hover { color: var(--text); border-color: var(--faint); }
  button.warn:hover { color: var(--red); border-color: var(--red); }
  button.hot { border-color: rgba(255,180,84,.5); color: var(--amber); }
  button.hot:hover { border-color: var(--amber); }

  .empty {
    border: 1px dashed var(--edge); border-radius: 7px; padding: 44px; text-align: center; color: var(--faint);
  }
  .empty code { color: var(--amber); }

  footer { color: var(--faint); font-size: 11px; margin-top: 18px; display: flex; justify-content: space-between; }

  #drawer {
    position: fixed; left: 0; right: 0; bottom: 0; max-height: 46vh; display: none;
    background: #0b0c0e; border-top: 1px solid var(--edge); padding: 14px clamp(20px, 4vw, 56px);
    overflow: auto; font-size: 12px; white-space: pre-wrap; box-shadow: 0 -14px 40px rgba(0,0,0,.6);
  }
  #drawer .bar { display: flex; justify-content: space-between; align-items: center; color: var(--faint);
    font-size: 10px; text-transform: uppercase; letter-spacing: .16em; margin-bottom: 10px;
    position: sticky; top: 0; background: #0b0c0e; padding-bottom: 6px; }

  @media (max-width: 720px) {
    .unit { grid-template-columns: 14px 1fr; }
    .meter, .acts { display: none; }
  }
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <div class="mark"><span>S</span><span>L</span><span>A</span><span>B</span></div>
  </div>
  <div class="stats">
    <div class="stat"><b id="s-apps">–</b><span>apps</span></div>
    <div class="stat"><b id="s-run">–</b><span>running</span></div>
    <div class="stat"><b id="s-rpm">–<em>/m</em></b><span>requests</span></div>
  </div>
</header>
<div class="rack" id="rack"></div>
<footer>
  <span>ingress :${proxyPort} · api :7766</span>
  <span>the localhost hyperscaler</span>
</footer>
</div>
<div id="drawer"><div class="bar"><span id="dtitle"></span><button onclick="drawer.style.display='none'">close</button></div><div id="dbody"></div></div>
<script>
const drawer = document.getElementById('drawer')
const hist = {}  // name -> recent reqPerMin samples (client-side, resets on reload)
async function act(name, verb) {
  await fetch('/v1/apps/' + name + '/' + verb, { method: 'POST' })
  load()
}
async function showLogs(name) {
  const r = await fetch('/v1/apps/' + name + '/logs?tail=200')
  const d = await r.json()
  document.getElementById('dtitle').textContent = 'logs — ' + name
  document.getElementById('dbody').textContent = d.logs ?? d.error ?? ''
  drawer.style.display = 'block'
}
function rel(iso) {
  if (!iso) return 'never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') }
function spark(name) {
  const pts = hist[name] ?? []
  if (pts.length < 2) return ''
  const w = 84, h = 18, max = Math.max(...pts, 1)
  const step = w / (pts.length - 1)
  const path = pts.map((v, i) => (i ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + (h - 2 - (v / max) * (h - 4)).toFixed(1)).join(' ')
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<path d="' + path + '" fill="none" stroke="#ffb454" stroke-width="1.5" stroke-linecap="round"/></svg>'
}
async function load() {
  const r = await fetch('/v1/apps')
  const d = await r.json()
  const apps = d.apps ?? []
  let totalRpm = 0
  for (const a of apps) {
    const rpm = a.reqPerMin ?? 0
    totalRpm += rpm
    hist[a.name] = [...(hist[a.name] ?? []), rpm].slice(-24)
  }
  document.getElementById('s-apps').textContent = apps.length
  document.getElementById('s-run').textContent = apps.filter(a => a.state === 'running').length
  document.getElementById('s-rpm').innerHTML = totalRpm + '<em>/m</em>'
  document.getElementById('rack').innerHTML = apps.map(a => {
    const url = 'http://' + a.name + '.localhost:${proxyPort}'
    const rpm = a.reqPerMin ?? 0
    return '<div class="unit ' + a.state + '">'
      + '<div class="led" title="' + a.state + '"></div>'
      + '<div class="plate">'
      +   '<div class="name">' + esc(a.name) + '<small>' + a.state + '</small></div>'
      +   '<div class="spec"><b>' + a.manifest.type + '</b> · ' + (a.manifest.image ? esc(a.manifest.image) : 'dockerfile')
      +     (a.manifest.postgres ? ' · <b>postgres</b>' : '') + ' · v' + a.version + ' · deployed ' + rel(a.deployedAt) + '</div>'
      +   '<div class="routes"><a href="' + url + '" target="_blank">' + esc(a.name) + '.localhost</a>'
      +     (a.publicUrl ? '<a class="pub" href="' + esc(a.publicUrl) + '" target="_blank">' + esc(a.publicUrl.replace('https://', '')) + '</a>' : '')
      +   '</div>'
      +   (a.error ? '<div class="errmsg">' + esc(a.error.slice(0, 140)) + '</div>' : '')
      + '</div>'
      + '<div class="meter"><div class="rpm' + (rpm > 0 ? ' hot' : '') + '">' + rpm + '<small>req/min</small></div>' + spark(a.name) + '</div>'
      + '<div class="acts">'
      +   '<div class="row">'
      +     '<button onclick="act(\\'' + a.name + '\\',\\'deploy\\')">deploy</button>'
      +     (a.state === 'running'
              ? '<button class="warn" onclick="act(\\'' + a.name + '\\',\\'stop\\')">stop</button>'
              : '<button onclick="act(\\'' + a.name + '\\',\\'start\\')">start</button>')
      +   '</div>'
      +   '<div class="row">'
      +     '<button onclick="showLogs(\\'' + a.name + '\\')">logs</button>'
      +     (a.exposed
              ? '<button class="warn" onclick="act(\\'' + a.name + '\\',\\'hide\\')">hide</button>'
              : '<button class="hot" onclick="act(\\'' + a.name + '\\',\\'expose\\')">expose</button>')
      +   '</div>'
      + '</div>'
      + '</div>'
  }).join('') || '<div class="empty">rack is empty — <code>slab deploy ./yourapp</code> mounts the first unit</div>'
}
load()
setInterval(load, 5000)
</script>
</body>
</html>`
}
