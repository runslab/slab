// Control-plane UI, served by the daemon at GET / (port 7766).
// Zero build step, zero deps, system fonts only.
// Design: apps are "slabs" — machined rack units. Click a unit's faceplate to
// flip it open (CSS 3D) and see the board inside: chips, wiring, source, secrets.

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
    --accent: #ffb454;
    --amber: var(--accent); --green: #71d68d; --red: #f07f78; --blue: #82b8e8;
    --board: #14170f; --trace: color-mix(in srgb, var(--accent) 28%, transparent);
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background:
      radial-gradient(1200px 500px at 50% -10%, color-mix(in srgb, var(--accent) 5%, transparent), transparent 60%),
      var(--bg);
    color: var(--text); min-height: 100vh;
    padding: clamp(20px, 4vw, 56px);
  }
  .wrap { max-width: 1040px; margin: 0 auto; }

  header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 26px; }
  header h1 { font-size: 12px; font-weight: 500; letter-spacing: .22em; text-transform: uppercase; color: var(--faint); }
  header h1 b { color: var(--amber); font-weight: 700; }
  .stats { display: flex; gap: 28px; text-align: right; }
  .stat b { display: block; font-size: 20px; font-weight: 700; color: var(--text); }
  .stat span { font-size: 10px; text-transform: uppercase; letter-spacing: .16em; color: var(--faint); }
  .stat b em { font-style: normal; color: var(--faint); font-size: 13px; }

  .layout { display: grid; grid-template-columns: 46px 1fr; gap: 16px; align-items: start; }
  .spine { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 24px; z-index: 20; }
  .spine span {
    display: grid; place-items: center; width: 46px; height: 44px;
    font-weight: 800; font-size: 24px; cursor: pointer; position: relative;
    color: var(--faint); text-shadow: 0 1px 0 rgba(0,0,0,.6);
    transition: color .12s ease, transform .12s ease;
  }
  .spine span:hover { color: var(--accent); transform: translateX(2px); }
  .spine span:hover::after {
    content: attr(data-nav); position: absolute; left: 52px; top: 50%; transform: translateY(-50%);
    white-space: nowrap; font-size: 9px; font-weight: 500; letter-spacing: .18em; text-transform: uppercase;
    color: var(--accent); background: rgba(10,11,13,.97); border: 1px solid var(--edge);
    padding: 3px 8px; border-radius: 4px; z-index: 30;
  }
  .spine span:first-child { color: var(--accent); }

  /* cabinet: matte monolith with scattered vent perforations (oxide-style) */
  .cabinet {
    background: linear-gradient(180deg, #101114, #0c0d10);
    border: 1px solid var(--groove); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.03);
    overflow: hidden;
  }
  .vents {
    height: 64px; margin: 14px 18px 4px;
    background:
      repeating-linear-gradient(90deg, #030304 0 7px, transparent 7px 13px),
      repeating-linear-gradient(0deg, #030304 0 11px, transparent 11px 16px);
    background-blend-mode: lighten;
    -webkit-mask-image: linear-gradient(105deg, transparent 0 8%, #000 30% 55%, transparent 78%), linear-gradient(180deg, #000 0 55%, transparent);
    -webkit-mask-composite: source-in;
    mask-image: linear-gradient(105deg, transparent 0 8%, #000 30% 55%, transparent 78%), linear-gradient(180deg, #000 0 55%, transparent);
    mask-composite: intersect;
    opacity: .9;
  }
  .rack {
    background: var(--rail); border-top: 1px solid var(--groove);
    padding: 10px; box-shadow: inset 0 2px 10px rgba(0,0,0,.6);
  }
  .cabmark {
    padding: 10px 18px 12px; font-size: 13px; letter-spacing: .06em;
    color: var(--amber); opacity: .85; user-select: none;
  }
  .cabmark::after { content: '_'; animation: cursor 1.2s steps(1) infinite; }
  @keyframes cursor { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cabmark::after { animation: none; } }

  /* ── 3D flip machinery ─────────────────────────────────────────────── */
  .bay { perspective: 1400px; margin-bottom: 10px; }
  .bay:last-child { margin-bottom: 0; }
  .flipper { position: relative; transform-style: preserve-3d; transition: transform .55s cubic-bezier(.4,.1,.2,1); display: grid; }
  .bay.open .flipper { transform: rotateX(-180deg); }
  @media (prefers-reduced-motion: reduce) { .flipper { transition: none; } }
  .face { grid-area: 1 / 1; backface-visibility: hidden; -webkit-backface-visibility: hidden; border-radius: 7px; }
  .face.back { transform: rotateX(180deg); }

  /* front face: the machined unit */
  .unit {
    display: grid; grid-template-columns: 18px 1fr auto auto; gap: 20px; align-items: center;
    background: linear-gradient(180deg, var(--unit-hi), var(--unit-lo));
    border: 1px solid var(--edge); border-radius: 7px;
    padding: 18px 22px 18px 62px; position: relative; height: 100%;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.05), 0 4px 10px rgba(0,0,0,.35);
  }
  /* sled edge: PCB strip with activity LEDs (lit count tracks req/min) */
  .sled {
    position: absolute; left: 30px; top: 8px; bottom: 8px; width: 16px;
    background: linear-gradient(180deg, #1c2b20, #14211a);
    border: 1px solid #2a3d2f; border-radius: 3px;
    display: flex; flex-direction: column; justify-content: space-evenly; align-items: center;
  }
  .sled i {
    width: 5px; height: 5px; border-radius: 1px; background: #223228;
  }
  .sled i.on { background: #f2f6ef; box-shadow: 0 0 5px rgba(242,246,239,.9), 0 0 12px rgba(242,246,239,.35); }
  .sleeping .sled i.on, .stopped .sled i.on, .created .sled i.on { background: #5a6a5e; box-shadow: none; }
  .bay:not(.open):hover .unit { box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 8px 18px rgba(0,0,0,.45); }
  .unit::before, .unit::after {
    content: ''; position: absolute; width: 5px; height: 5px; border-radius: 50%;
    background: var(--groove); box-shadow: inset 0 1px 1px rgba(0,0,0,.9), 0 1px 0 rgba(255,255,255,.05);
  }
  .unit::before { top: 8px; right: 8px; }
  .unit::after { bottom: 8px; right: 8px; }
  .unum {
    position: absolute; left: 0; top: 0; bottom: 0; width: 26px;
    display: grid; place-items: center;
    font-size: 9px; letter-spacing: .1em; color: var(--faint);
    border-right: 1px solid rgba(0,0,0,.35); background: rgba(0,0,0,.15);
    border-radius: 7px 0 0 7px; writing-mode: vertical-rl;
  }

  .led { width: 10px; height: 10px; border-radius: 50%; justify-self: center; }
  .running .led { background: var(--green); box-shadow: 0 0 10px var(--green), 0 0 2px var(--green); animation: breathe 2.8s ease-in-out infinite; }
  .sleeping .led { background: var(--blue); opacity: .65; box-shadow: 0 0 5px rgba(130,184,232,.4); }
  .stopped .led, .created .led { background: #3a3d44; }
  .error .led { background: var(--red); box-shadow: 0 0 10px var(--red); }
  .building .led { background: var(--amber); box-shadow: 0 0 10px var(--amber); animation: breathe .9s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: .3; box-shadow: none; } }
  @media (prefers-reduced-motion: reduce) { .led { animation: none !important; } }

  .plate { cursor: pointer; }
  .plate .name { font-size: 17px; font-weight: 800; letter-spacing: .01em; }
  .plate .name small { font-weight: 500; font-size: 11px; color: var(--faint); margin-left: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .plate .name .hint { color: var(--faint); font-size: 10px; margin-left: 10px; opacity: 0; transition: opacity .15s; }
  .bay:hover .plate .name .hint { opacity: .8; }
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
  .meter svg path { stroke: var(--accent); filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 45%, transparent)); }

  .acts { display: flex; flex-direction: column; gap: 6px; opacity: 0; transition: opacity .15s; }
  .bay:hover .acts, .acts:focus-within { opacity: 1; }
  .acts .row { display: flex; gap: 6px; justify-content: flex-end; }
  button {
    background: rgba(0,0,0,.25); color: var(--dim); border: 1px solid var(--edge); border-radius: 5px;
    padding: 4px 11px; font: inherit; font-size: 11px; cursor: pointer;
  }
  button:hover { color: var(--text); border-color: var(--faint); }
  button.warn:hover { color: var(--red); border-color: var(--red); }
  button.hot { border-color: color-mix(in srgb, var(--accent) 75%, transparent); border-width: 1.5px; color: var(--accent); }
  button.hot:hover { border-color: var(--amber); }

  /* back face: the board inside */
  .board {
    height: 100%; cursor: pointer; overflow: hidden; position: relative;
    background:
      repeating-linear-gradient(90deg, transparent 0 46px, var(--trace) 46px 48px),
      repeating-linear-gradient(0deg, transparent 0 34px, rgba(255,180,84,.10) 34px 35px),
      linear-gradient(180deg, #171a10, var(--board));
    border: 1px solid #2e331f; border-radius: 7px;
    padding: 16px 20px; display: flex; flex-wrap: wrap; gap: 12px; align-content: flex-start;
  }
  .board::after { content: 'click to close'; position: absolute; right: 12px; bottom: 8px; font-size: 9px; color: #4a4f3a; letter-spacing: .15em; text-transform: uppercase; }
  .chip {
    background: #0c0d09; border: 1px solid #34392a; border-radius: 4px;
    padding: 8px 12px; min-width: 130px; position: relative;
    box-shadow: 0 2px 6px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.04);
  }
  /* pins */
  .chip::before, .chip::after {
    content: ''; position: absolute; left: 8px; right: 8px; height: 3px;
    background: repeating-linear-gradient(90deg, #6b705c 0 3px, transparent 3px 7px);
  }
  .chip::before { top: -3px; } .chip::after { bottom: -3px; }
  .chip .lbl { font-size: 8px; letter-spacing: .18em; text-transform: uppercase; color: #7a805f; }
  .chip .val { font-size: 11px; color: var(--text); margin-top: 2px; word-break: break-all; max-width: 260px; }
  .chip .val.amber { color: var(--amber); }
  .chip.wide { flex: 1 1 100%; }
  .wire { display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .wire .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 6px var(--amber); }
  .wire .lead { flex: 1; height: 2px; background: repeating-linear-gradient(90deg, var(--amber) 0 6px, transparent 6px 11px); opacity: .6; min-width: 30px; }

  .empty { border: 1px dashed var(--edge); border-radius: 7px; padding: 44px; text-align: center; color: var(--faint); }
  .empty code { color: var(--amber); }
  footer { color: var(--faint); font-size: 11px; margin-top: 18px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .settings { background: none; border: none; color: var(--faint); font: inherit; font-size: 9px;
    text-transform: uppercase; letter-spacing: .14em; cursor: pointer; padding: 2px 4px; }
  .settings:hover { color: var(--accent); }
  .setrow { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid #1c1e24; font-size: 12px; }
  .setrow .k { width: 140px; color: var(--dim); }
  .setrow input[type=color] { width: 26px; height: 26px; border: 1px solid var(--edge); border-radius: 50%; background: none; padding: 0; cursor: pointer; }
  .setrow input[type=color]::-webkit-color-swatch-wrapper { padding: 2px; }
  .setrow input[type=color]::-webkit-color-swatch { border: none; border-radius: 50%; }
  .setrow .swatches { display: flex; gap: 8px; }
  .setrow .swatches i { width: 18px; height: 18px; border-radius: 50%; cursor: pointer; border: 1px solid var(--edge); }
  .setrow.sliders { flex-direction: column; align-items: stretch; gap: 10px; }
  .srow { display: flex; align-items: center; gap: 12px; }
  .srow label { width: 24px; color: var(--faint); font-size: 10px; text-transform: uppercase; }
  .srow input[type=range] { flex: 1; -webkit-appearance: none; appearance: none; height: 10px; border-radius: 5px; border: 1px solid var(--edge); cursor: pointer; background: #222; }
  .srow input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 2px solid #0b0c0e; box-shadow: 0 1px 4px rgba(0,0,0,.6); }
  .preview { display: flex; align-items: center; gap: 12px; }
  .preview .chipbox { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--edge); background: var(--accent); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 40%, transparent); }
  .preview code { color: var(--dim); font-size: 11px; }

  #drawer {
    position: fixed; left: 0; right: 0; bottom: 0; max-height: 46vh; display: none;
    background: #0b0c0e; border-top: 1px solid var(--edge); padding: 14px clamp(20px, 4vw, 56px);
    overflow: auto; font-size: 12px; white-space: pre-wrap; box-shadow: 0 -14px 40px rgba(0,0,0,.6);
  }
  #drawer .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--faint);
    font-size: 10px; text-transform: uppercase; letter-spacing: .16em; margin-bottom: 10px;
    position: sticky; top: 0; background: #0b0c0e; padding-bottom: 6px; }
  #dapps { flex: 1; display: flex; gap: 6px; flex-wrap: wrap; }
  #dapps button { text-transform: none; letter-spacing: 0; }
  #dapps button.active { border-color: var(--amber); border-width: 1.5px; color: var(--amber); }

  @media (max-width: 720px) {
    .layout { grid-template-columns: 1fr; }
    .spine { flex-direction: row; position: static; }
    .spine .vent { display: none; }
    .unit { grid-template-columns: 14px 1fr; }
    .meter, .acts { display: none; }
  }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>the localhost <b>hyperscaler</b></h1>
  <div class="stats">
    <div class="stat"><b id="s-apps">–</b><span>apps</span></div>
    <div class="stat"><b id="s-run">–</b><span>running</span></div>
    <div class="stat"><b id="s-rpm">–<em>/m</em></b><span>requests</span></div>
  </div>
</header>
<div class="layout">
  <div class="spine">
    <span data-nav="status" onclick="navStatus()">S</span>
    <span data-nav="logs" onclick="navLogs()">L</span>
    <span data-nav="api — raw json" onclick="window.open('/v1/apps')">A</span>
    <span data-nav="boards — flip all" onclick="navBoards()">B</span>
  </div>
  <div class="cabinet">
    <div class="vents"></div>
    <div class="rack" id="rack"></div>
    <div class="cabmark">slab</div>
  </div>
</div>
<footer>
  <span>ingress :${proxyPort} · api :7766</span>
  <button class="settings" onclick="openSettings()">settings</button>
  <span id="clock"></span>
</footer>
</div>
<div id="drawer"><div class="bar"><span id="dtitle"></span><span id="dapps"></span><button onclick="drawer.style.display='none'">close</button></div><div id="dbody"></div></div>
<script>
const drawer = document.getElementById('drawer')
const hist = {}          // name -> recent reqPerMin samples
const openBays = new Set()  // names of flipped-open units (persists across refresh)
let appsCache = []
function toggle(name) {
  if (openBays.has(name)) openBays.delete(name); else openBays.add(name)
  render()
}
async function act(name, verb) {
  await fetch('/v1/apps/' + name + '/' + verb, { method: 'POST' })
  load()
}
async function removeApp(name) {
  if (!confirm('Remove ' + name + '? Its container and secrets are deleted; the source directory is untouched.')) return
  await fetch('/v1/apps/' + name, { method: 'DELETE' })
  load()
}
function logPicker(active) {
  document.getElementById('dapps').innerHTML = appsCache.map(a =>
    '<button class="' + (a.name === active ? 'active' : '') + '" onclick="showLogs(\\'' + a.name + '\\')">' + esc(a.name) + '</button>'
  ).join('')
}
async function showLogs(name) {
  document.getElementById('dtitle').textContent = 'logs'
  logPicker(name)
  document.getElementById('dbody').textContent = 'loading…'
  drawer.style.display = 'block'
  const r = await fetch('/v1/apps/' + name + '/logs?tail=200')
  const d = await r.json()
  document.getElementById('dbody').textContent = d.logs ?? d.error ?? ''
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
    + '<path d="' + path + '" fill="none" stroke-width="2.5" stroke-linecap="round"/></svg>'
}
function chip(lbl, val, amber) {
  return '<div class="chip"><div class="lbl">' + lbl + '</div><div class="val' + (amber ? ' amber' : '') + '">' + val + '</div></div>'
}
function boardHtml(a) {
  const secrets = (a.manifest.secrets ?? []).length
    ? a.manifest.secrets.map(esc).join(' · ')
    : 'none'
  return ''
    + chip('image', esc(a.imageTag ?? a.manifest.image ?? 'not built'), true)
    + chip('container', a.containerId ? esc(a.containerId.slice(0, 12)) : 'none')
    + chip('build', 'v' + a.version + ' · ' + rel(a.deployedAt))
    + '<div class="chip"><div class="lbl">port map</div><div class="val wire">'
    +   '<span class="dot"></span>:' + (a.hostPort ?? '?') + '<span class="lead"></span>:' + a.manifest.port + '<span class="dot"></span>'
    + '</div></div>'
    + chip('source', esc(a.gitUrl ?? a.sourceDir), !!a.gitUrl)
    + chip('secrets (' + (a.manifest.secrets ?? []).length + ')', secrets)
    + (a.manifest.type === 'function' ? chip('idle timeout', esc(a.manifest.idle_timeout ?? '5m')) : '')
    + (a.manifest.postgres ? chip('postgres', 'slab_' + a.name.replace(/-/g, '_'), true) : '')
    + chip('created', rel(a.createdAt))
}
function render() {
  const apps = appsCache
  document.getElementById('rack').innerHTML = apps.map((a, i) => {
    const url = 'http://' + a.name + '.localhost:${proxyPort}'
    const rpm = a.reqPerMin ?? 0
    const open = openBays.has(a.name)
    const lit = a.state === 'running' ? Math.min(8, 1 + Math.ceil(Math.log2(rpm + 1))) : 1
    const sled = Array.from({ length: 8 }, (_, k) => '<i class="' + (k < lit ? 'on' : '') + '"></i>').join('')
    return '<div class="bay' + (open ? ' open' : '') + '"><div class="flipper">'
      // front
      + '<div class="face"><div class="unit ' + a.state + '">'
      + '<div class="unum">U' + String(i + 1).padStart(2, '0') + '</div>'
      + '<div class="sled">' + sled + '</div>'
      + '<div class="led" title="' + a.state + '"></div>'
      + '<div class="plate" onclick="toggle(\\'' + a.name + '\\')" title="open unit">'
      +   '<div class="name">' + esc(a.name) + '<small>' + a.state + '</small><span class="hint">▸ open</span></div>'
      +   '<div class="spec"><b>' + a.manifest.type + '</b> · ' + (a.manifest.image ? esc(a.manifest.image) : 'dockerfile')
      +     (a.manifest.postgres ? ' · <b>postgres</b>' : '') + ' · v' + a.version + ' · deployed ' + rel(a.deployedAt) + '</div>'
      +   '<div class="routes" onclick="event.stopPropagation()"><a href="' + url + '" target="_blank">' + esc(a.name) + '.localhost</a>'
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
      +     '<button class="warn" onclick="removeApp(\\'' + a.name + '\\')">rm</button>'
      +   '</div>'
      + '</div>'
      + '</div></div>'
      // back
      + '<div class="face back"><div class="board" onclick="toggle(\\'' + a.name + '\\')">' + boardHtml(a) + '</div></div>'
      + '</div></div>'
  }).join('') || '<div class="empty">rack is empty — <code>slab deploy ./yourapp</code> mounts the first unit</div>'
}
async function load() {
  const r = await fetch('/v1/apps')
  const d = await r.json()
  appsCache = d.apps ?? []
  let totalRpm = 0
  for (const a of appsCache) {
    const rpm = a.reqPerMin ?? 0
    totalRpm += rpm
    hist[a.name] = [...(hist[a.name] ?? []), rpm].slice(-24)
  }
  document.getElementById('s-apps').textContent = appsCache.length
  document.getElementById('s-run').textContent = appsCache.filter(a => a.state === 'running').length
  document.getElementById('s-rpm').innerHTML = totalRpm + '<em>/m</em>'
  render()
}
async function navStatus() {
  const r = await fetch('/v1/health')
  const h = await r.json()
  document.getElementById('dtitle').textContent = 'status'
  document.getElementById('dapps').innerHTML = ''
  document.getElementById('dbody').textContent = JSON.stringify(h, null, 2)
  drawer.style.display = 'block'
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function navLogs() {
  // per-app terminal: pick an app in the bar, or default to the first running one
  const first = appsCache.find(a => a.state === 'running') ?? appsCache[0]
  if (!first) return
  showLogs(first.name)
}
function navBoards() {
  if (openBays.size) openBays.clear()
  else for (const a of appsCache) openBays.add(a.name)
  render()
}
function tick() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString()
}
const savedAccent = localStorage.getItem('slab-accent')
if (savedAccent) document.documentElement.style.setProperty('--accent', savedAccent)
function setAccent(v) {
  document.documentElement.style.setProperty('--accent', v)
  localStorage.setItem('slab-accent', v)
  const hex = document.getElementById('accent-hex')
  if (hex) hex.textContent = v
}
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  if (!d) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = Math.round(h * 60); if (h < 0) h += 360
  return [h, Math.round(s * 100), Math.round(l * 100)]
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return '#' + to(r) + to(g) + to(b)
}
function slide() {
  const h = +document.getElementById('sl-h').value
  const s = +document.getElementById('sl-s').value
  const l = +document.getElementById('sl-l').value
  setAccent(hslToHex(h, s, l))
  paintTracks(h, s, l)
}
function paintTracks(h, s, l) {
  document.getElementById('sl-s').style.background =
    'linear-gradient(90deg, hsl(' + h + ',0%,' + l + '%), hsl(' + h + ',100%,' + l + '%))'
  document.getElementById('sl-l').style.background =
    'linear-gradient(90deg, #000, hsl(' + h + ',' + s + '%,50%), #fff)'
}
function syncSliders(hex) {
  const [h, s, l] = hexToHsl(hex)
  document.getElementById('sl-h').value = h
  document.getElementById('sl-s').value = s
  document.getElementById('sl-l').value = l
  paintTracks(h, s, l)
}
function pickPreset(c) {
  setAccent(c)
  syncSliders(c)
}
function openSettings() {
  const presets = ['#ffb454', '#6ee7b7', '#82b8e8', '#f07f78', '#d8b4fe', '#e2e8f0']
  const cur = localStorage.getItem('slab-accent') ?? '#ffb454'
  document.getElementById('dtitle').textContent = 'settings'
  document.getElementById('dapps').innerHTML = ''
  document.getElementById('dbody').innerHTML =
    '<div class="setrow"><span class="k">accent color</span>'
    + '<span class="preview"><span class="chipbox"></span><code id="accent-hex">' + cur + '</code></span>'
    + '<span class="swatches">' + presets.map(c => '<i style="background:' + c + '" onclick="pickPreset(\\'' + c + '\\')"></i>').join('') + '</span>'
    + '</div>'
    + '<div class="setrow sliders">'
    +   '<div class="srow"><label>hue</label><input type="range" id="sl-h" min="0" max="360" oninput="slide()" style="background:linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)"></div>'
    +   '<div class="srow"><label>sat</label><input type="range" id="sl-s" min="0" max="100" oninput="slide()"></div>'
    +   '<div class="srow"><label>lum</label><input type="range" id="sl-l" min="20" max="85" oninput="slide()"></div>'
    + '</div>'
    + '<div class="setrow"><span class="k">state</span><span style="color:var(--faint)">~/.slab · state.json, secrets/, repos/</span></div>'
  syncSliders(cur)
  drawer.style.display = 'block'
}
load()
tick()
setInterval(load, 5000)
setInterval(tick, 1000)
</script>
</body>
</html>`
}

// Human view of API endpoints: same URL as the JSON, selected by Accept header.
// Browsers send Accept: text/html; agents and curl don't — so /v1/* serves both
// audiences without separate routes.
export function apiHumanHtml(path: string, data: unknown): string {
  const routes = [
    ['GET', '/v1/apps', 'all apps (+reqPerMin)'],
    ['POST', '/v1/apps', '{ sourceDir } | { gitUrl }'],
    ['GET', '/v1/apps/:name', 'one app'],
    ['DELETE', '/v1/apps/:name', 'remove app'],
    ['POST', '/v1/apps/:name/deploy', 'build + run'],
    ['POST', '/v1/apps/:name/stop', 'stop container'],
    ['POST', '/v1/apps/:name/start', 'start container'],
    ['GET', '/v1/apps/:name/logs?tail=100', 'recent logs'],
    ['PUT', '/v1/apps/:name/secrets', '{ values: {K:V} }'],
    ['GET', '/v1/apps/:name/secrets', 'secret names'],
    ['POST', '/v1/apps/:name/expose', 'public tunnel url'],
    ['POST', '/v1/apps/:name/hide', 'close tunnel'],
    ['GET', '/v1/health', 'daemon status'],
  ]
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>slab api — ${path}</title>
<style>
  body { font: 13px/1.6 ui-monospace, Menlo, monospace; background: #131418; color: #ece9e2; padding: 40px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 13px; color: #ffb454; letter-spacing: .1em; margin-bottom: 4px; }
  .note { color: #5f626a; font-size: 11px; margin-bottom: 22px; }
  pre { background: #0b0c0e; border: 1px solid #2c2f36; border-radius: 8px; padding: 16px; overflow: auto; font-size: 12px; margin-bottom: 26px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td { padding: 5px 14px 5px 0; border-bottom: 1px solid #1c1e24; color: #9a9da5; }
  td:first-child { color: #82b8e8; width: 60px; }
  td:nth-child(2) { color: #ece9e2; }
  a { color: #82b8e8; }
</style></head><body>
<h1>slab api — ${path}</h1>
<div class="note">You're seeing HTML because your client sent <b>Accept: text/html</b>. Agents and curl get raw JSON from the same URL. Dashboard: <a href="/">/</a></div>
<pre>${JSON.stringify(data, null, 2).replace(/</g, '&lt;')}</pre>
<table>${routes.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table>
</body></html>`
}
