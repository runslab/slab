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
    border-left: 9px solid transparent; border-right: 9px solid transparent;
    background-clip: padding-box; position: relative;
    box-shadow: 0 12px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.03);
    overflow: hidden;
  }
  .cabinet::before, .cabinet + .cabinet::before { content: none; }
  .cabinet { box-shadow: -9px 0 0 0 #241a12, 9px 0 0 0 #241a12, -9px 2px 8px rgba(0,0,0,.5), 9px 2px 8px rgba(0,0,0,.5), 0 12px 40px rgba(0,0,0,.5); }
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
  .vents.slim { height: 28px; margin: 8px 18px 2px; }
  .cabinet + .cabinet { margin-top: 18px; }
  .rack {
    background: var(--rail); border-top: 1px solid var(--groove);
    padding: 10px; box-shadow: inset 0 2px 10px rgba(0,0,0,.6);
  }
  .cabmark {
    padding: 10px 18px 12px; font-size: 13px; letter-spacing: .06em;
    color: var(--amber); opacity: .85; user-select: none;
  }
  .cabmark::after { content: '_'; animation: cursor 1.2s steps(1) infinite; }
  .cabinfo { color: var(--faint); font-size: 10px; margin-left: 14px; letter-spacing: .1em; text-transform: uppercase; }
  .diagbtn { float: right; background: none; border: 1px solid var(--edge); border-radius: 4px; color: var(--dim);
    font: inherit; font-size: 10px; padding: 2px 10px; cursor: pointer; letter-spacing: .08em; }
  .diagbtn:hover { color: var(--accent); border-color: var(--accent); }
  #overlay { position: fixed; inset: 0; display: none; background: rgba(8,9,11,.82); z-index: 100;
    padding: 5vh 5vw; backdrop-filter: blur(3px); }
  #overlay .panel { max-width: 860px; margin: 0 auto; background: linear-gradient(180deg, #101114, #0c0d10);
    border: 1px solid var(--edge); border-radius: 12px; padding: 18px 22px; box-shadow: 0 24px 70px rgba(0,0,0,.7); }
  #overlay .panel h2 { font-size: 11px; color: var(--accent); letter-spacing: .18em; text-transform: uppercase; margin-bottom: 4px; }
  #overlay .panel .note { color: var(--faint); font-size: 10px; margin-bottom: 12px; }
  #overlay svg { width: 100%; height: auto; display: block; }
  #overlay text { font-family: ui-monospace, Menlo, monospace; }
  @keyframes cursor { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cabmark::after { animation: none; } }

  /* monitor deck: spectrum analyzer + listen knob (a component above the cabinets) */
  .deck {
    display: grid; grid-template-columns: auto auto 1fr auto; gap: 18px; align-items: center;
    background:
      repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px),
      linear-gradient(180deg, #202127 0%, #17181d 18%, #101116 60%, #15161b 100%);
    border: 1px solid #2b2d34; border-radius: 8px;
    padding: 12px 18px; margin-bottom: 16px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.07), inset 0 -1px 0 rgba(0,0,0,.6), 0 5px 14px rgba(0,0,0,.45);
  }
  .knobwrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .knob {
    width: 40px; height: 40px; border-radius: 50%; cursor: pointer; position: relative; padding: 0;
    background: radial-gradient(circle at 35% 30%, #33363e, #14151a 75%);
    border: 1px solid #3a3d45;
    box-shadow: inset 0 2px 4px rgba(0,0,0,.6), 0 2px 5px rgba(0,0,0,.5);
    transition: transform .25s ease;
  }
  .knob::after {
    content: ''; position: absolute; left: 50%; top: 4px; width: 3px; height: 12px;
    margin-left: -1.5px; border-radius: 2px; background: #6a6e78;
    transition: background .2s;
  }
  .knob.on { transform: rotate(135deg); }
  .knob.on::after { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
  .knobwrap .klbl { font-size: 8px; letter-spacing: .18em; color: var(--faint); text-transform: uppercase; }
  .playbtn { width: 40px; height: 40px; border-radius: 50%; cursor: pointer; color: var(--dim); font-size: 13px;
    background: radial-gradient(circle at 35% 30%, #33363e, #14151a 75%); border: 1px solid #3a3d45; padding: 0;
    box-shadow: inset 0 2px 4px rgba(0,0,0,.6), 0 2px 5px rgba(0,0,0,.5); }
  .playbtn:hover { color: var(--accent); border-color: var(--accent); }
  .knob.on + .klbl { color: var(--accent); }
  #viz { width: 100%; height: 64px; display: block; background: #0b0c09; border: 1px solid #26282e; border-radius: 4px;
    box-shadow: inset 0 1px 5px rgba(0,0,0,.8); }
  .deck .lcd { align-self: center; }

  /* ── 3D flip machinery ─────────────────────────────────────────────── */
  .bay { perspective: 1400px; margin-bottom: 10px; }
  .bay:last-child { margin-bottom: 0; }
  .flipper { position: relative; transform-style: preserve-3d; transition: transform .55s cubic-bezier(.4,.1,.2,1); display: grid; }
  .bay.open .flipper { transform: rotateX(-180deg); }
  @media (prefers-reduced-motion: reduce) { .flipper { transition: none; } }
  .face { grid-area: 1 / 1; backface-visibility: hidden; -webkit-backface-visibility: hidden; border-radius: 7px; }
  .face.back { transform: rotateX(180deg); }

  /* front face: black-glass hi-fi component */
  .unit {
    display: grid; grid-template-columns: 30px 1fr auto auto; gap: 20px; align-items: center;
    background:
      repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px),
      linear-gradient(180deg, #202127 0%, #17181d 18%, #101116 60%, #15161b 100%);
    border: 1px solid #2b2d34; border-radius: 8px;
    padding: 16px 22px 16px 62px; position: relative; height: 100%;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.07), inset 0 -1px 0 rgba(0,0,0,.6), 0 5px 14px rgba(0,0,0,.45);
  }
  /* level meter: vertical LED ladder, green -> amber -> red (lit = activity) */
  .sled {
    position: absolute; left: 32px; top: 10px; bottom: 10px; width: 12px;
    background: #0b0c0e; border: 1px solid #26282e; border-radius: 3px;
    display: flex; flex-direction: column-reverse; justify-content: space-evenly; align-items: center;
    box-shadow: inset 0 1px 3px rgba(0,0,0,.8);
  }
  .sled i { width: 6px; height: 3px; border-radius: 1px; background: #23252a; }
  .sled i.on { background: var(--green); box-shadow: 0 0 4px var(--green); }
  .sled i.on:nth-child(6), .sled i.on:nth-child(7) { background: var(--amber); box-shadow: 0 0 4px var(--amber); }
  .sled i.on:nth-child(8) { background: var(--red); box-shadow: 0 0 5px var(--red); }
  .sleeping .sled i.on, .stopped .sled i.on, .created .sled i.on { background: #4a4d55; box-shadow: none; }
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

  .pwr {
    width: 26px; height: 26px; border-radius: 50%; justify-self: center; cursor: pointer;
    background: radial-gradient(circle at 35% 30%, #2e3138, #16171b 70%);
    border: 1px solid #3a3d45; position: relative; padding: 0;
    box-shadow: inset 0 2px 3px rgba(0,0,0,.7), 0 1px 0 rgba(255,255,255,.06);
  }
  .pwr::after {
    content: ''; position: absolute; inset: 7px; border-radius: 50%;
    background: #33363e; transition: background .2s, box-shadow .2s;
  }
  .running .pwr::after { background: var(--green); box-shadow: 0 0 9px var(--green); animation: breathe 2.8s ease-in-out infinite; }
  .sleeping .pwr::after { background: var(--blue); box-shadow: 0 0 6px rgba(130,184,232,.5); }
  .error .pwr::after { background: var(--red); box-shadow: 0 0 9px var(--red); }
  .building .pwr::after { background: var(--amber); box-shadow: 0 0 9px var(--amber); animation: breathe .9s ease-in-out infinite; }
  .pwr:hover { border-color: var(--faint); }
  @keyframes breathe { 50% { opacity: .35; box-shadow: none; } }
  @media (prefers-reduced-motion: reduce) { .pwr::after { animation: none !important; } }

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
  .routes .priv { color: var(--faint); margin-right: 18px; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; border-radius: 2px; }
  .errmsg { color: var(--red); font-size: 11px; margin-top: 6px; max-width: 420px; }

  .meter { text-align: right; min-width: 130px; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .vu { display: block; }
  .vu .needle { transition: transform .8s cubic-bezier(.3,1.4,.4,1); transform-origin: 48px 46px; }
  @media (prefers-reduced-motion: reduce) { .vu .needle { transition: none; } }
  .lcd {
    background: #0a0b08; border: 1px solid #2a2c26; border-radius: 3px;
    padding: 1px 8px; font-size: 10px; letter-spacing: .12em; color: var(--accent);
    box-shadow: inset 0 1px 4px rgba(0,0,0,.85);
    text-shadow: 0 0 4px color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .meter .spark path { stroke: var(--accent); filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 45%, transparent)); }

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
<div class="deck">
  <div class="knobwrap"><button class="knob" id="knob" onclick="toggleListen()"></button><span class="klbl">listen</span></div>
  <div class="knobwrap"><button class="playbtn" onclick="playApps()">&#9654;</button><span class="klbl">play</span></div>
  <canvas id="viz" width="800" height="64"></canvas>
  <span class="lcd" id="deck-lcd">000 evt/min</span>
</div>
<div class="layout">
  <div class="spine">
    <span data-nav="status" onclick="navStatus()">S</span>
    <span data-nav="logs" onclick="navLogs()">L</span>
    <span data-nav="api — raw json" onclick="window.open('/v1/apps')">A</span>
    <span data-nav="boards — flip all" onclick="navBoards()">B</span>
  </div>
  <div id="cabinets"></div>
</div>
<footer>
  <span>ingress :${proxyPort} · api :7766</span>
  <button class="settings" onclick="openSettings()">settings</button>
  <span id="clock"></span>
</footer>
</div>
<div id="overlay" onclick="this.style.display='none'"><div class="panel" onclick="event.stopPropagation()"><h2 id="dg-title"></h2><div class="note">apps call each other along the amber wires - the dashed boundary is the system's private network - click outside to close</div><div id="dg-body"></div></div></div>
<div id="drawer"><div class="bar"><span id="dtitle"></span><span id="dapps"></span><button onclick="drawer.style.display='none'">close</button></div><div id="dbody"></div></div>
<script>
const drawer = document.getElementById('drawer')
const hist = {}          // name -> recent reqPerMin samples
const openBays = new Set()  // names of flipped-open units (persists across refresh)
let appsCache = []
let systemsCache = []
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
// Analog VU meter: needle swings with req/min (log scale). Pivot at (48,46).
function vuMeter(rpm, state) {
  const angle = -48 + Math.min(96, Math.log2(rpm + 1) * 16)   // -48deg..+48deg
  const ticks = []
  for (let t = -48; t <= 48; t += 12) {
    const rad = (t - 90) * Math.PI / 180
    const x1 = 48 + Math.cos(rad) * 34, y1 = 46 + Math.sin(rad) * 34
    const x2 = 48 + Math.cos(rad) * (t === -48 || t === 48 || t === 0 ? 28 : 30)
    const y2 = 46 + Math.sin(rad) * (t === -48 || t === 48 || t === 0 ? 28 : 30)
    ticks.push('<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + (t > 24 ? 'var(--red)' : '#5f626a') + '" stroke-width="1.2"/>')
  }
  const dead = state !== 'running'
  return '<svg class="vu" width="96" height="50" viewBox="0 0 96 50">'
    + '<rect x="1" y="1" width="94" height="48" rx="5" fill="#0d0e0a" stroke="#2a2c26"/>'
    + '<ellipse cx="48" cy="46" rx="40" ry="38" fill="color-mix(in srgb, var(--accent) ' + (dead ? '4' : '10') + '%, transparent)"/>'
    + ticks.join('')
    + '<line class="needle" x1="48" y1="46" x2="48" y2="14" stroke="' + (dead ? '#4a4d55' : 'var(--accent)') + '" stroke-width="1.6"'
    +   ' style="transform: rotate(' + (dead ? -48 : angle).toFixed(1) + 'deg)"/>'
    + '<circle cx="48" cy="46" r="3" fill="#2a2c30"/>'
    + '<text x="10" y="12" font-size="6" fill="#5f626a">VU</text>'
    + '</svg>'
}
function bayHtml(a, i) {
  const url = 'http://' + a.name + '.localhost:${proxyPort}'
  const rpm = a.reqPerMin ?? 0
  const open = openBays.has(a.name)
  const lit = a.state === 'running' ? Math.min(8, 1 + Math.ceil(Math.log2(rpm + 1))) : 1
  const sled = Array.from({ length: 8 }, (_, k) => '<i class="' + (k < lit ? 'on' : '') + '"></i>').join('')
  const priv = a.manifest.public === false
  return '<div class="bay' + (open ? ' open' : '') + '"><div class="flipper">'
    // front
    + '<div class="face"><div class="unit ' + a.state + '">'
    + '<div class="unum">U' + String(i + 1).padStart(2, '0') + '</div>'
    + '<div class="sled">' + sled + '</div>'
    + '<button class="pwr" title="' + (a.state === 'running' ? 'power off (stop)' : 'power on (start)') + '"'
    +   ' onclick="event.stopPropagation(); act(\\'' + a.name + '\\', \\'' + (a.state === 'running' ? 'stop' : 'start') + '\\')"></button>'
    + '<div class="plate" onclick="toggle(\\'' + a.name + '\\')" title="open unit">'
    +   '<div class="name">' + esc(a.name) + '<small>' + a.state + '</small><span class="hint">▸ open</span></div>'
    +   '<div class="spec"><b>' + a.manifest.type + '</b> · ' + (a.manifest.image ? esc(a.manifest.image) : 'dockerfile')
    +     (a.manifest.postgres ? ' · <b>postgres</b>' : '') + ' · v' + a.version + ' · deployed ' + rel(a.deployedAt) + '</div>'
    +   '<div class="routes" onclick="event.stopPropagation()">'
    +     (priv
              ? '<span class="priv">🔒 private — system-only</span>'
              : '<a href="' + url + '" target="_blank">' + esc(a.name) + '.localhost</a>')
    +     (a.publicUrl ? '<a class="pub" href="' + esc(a.publicUrl) + '" target="_blank">' + esc(a.publicUrl.replace('https://', '')) + '</a>' : '')
    +   '</div>'
    +   (a.error ? '<div class="errmsg">' + esc(a.error.slice(0, 140)) + '</div>' : '')
    + '</div>'
    + '<div class="meter">' + vuMeter(rpm, a.state) + '<span class="lcd">' + String(rpm).padStart(3, '0') + ' req/min</span><span class="spark">' + spark(a.name) + '</span></div>'
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
}
function cabinetHtml(title, apps, slim, sys) {
  const sub = sys
    ? '<span class="cabinfo">system - ' + sys.members.length + ' members - ' + Object.keys(sys.wires ?? {}).length + ' wires</span>'
      + '<button class="diagbtn" onclick="openDiagram(\\'' + esc(sys.name) + '\\')">&#8909; diagram</button>'
    : ''
  return '<div class="cabinet">'
    + '<div class="vents' + (slim ? ' slim' : '') + '"></div>'
    + '<div class="rack">' + apps.map((a, i) => bayHtml(a, i)).join('') + '</div>'
    + '<div class="cabmark">' + esc(title) + sub + '</div>'
    + '</div>'
}
function render() {
  const apps = appsCache
  const systems = systemsCache
  const container = document.getElementById('cabinets')
  if (!apps.length) {
    container.innerHTML = '<div class="cabinet"><div class="vents"></div>'
      + '<div class="rack"><div class="empty">rack is empty — <code>slab deploy ./yourapp</code> mounts the first unit</div></div>'
      + '<div class="cabmark">slab</div></div>'
    return
  }
  const sorted = [...systems].sort((x, y) => x.name.localeCompare(y.name))
  let html = sorted.map(s => cabinetHtml(s.name, apps.filter(a => s.members.includes(a.name)), true, s)).join('')
  const solo = apps.filter(a => !systems.some(s => s.members.includes(a.name)))
  if (solo.length) html += cabinetHtml('slab', solo, false)
  container.innerHTML = html
}
async function load() {
  const [r, rs] = await Promise.all([fetch('/v1/apps'), fetch('/v1/systems')])
  const d = await r.json()
  appsCache = d.apps ?? []
  systemsCache = []
  try { const ds = await rs.json(); systemsCache = ds.systems ?? [] } catch (e) {}
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

function nodeColor(a) {
  return a && a.state === 'running' ? '#71d68d' : a && a.state === 'sleeping' ? '#82b8e8' : a && a.state === 'error' ? '#f07f78' : '#5f626a'
}
function openDiagram(sysName) {
  const sys = systemsCache.find(s => s.name === sysName)
  if (!sys) return
  const members = sys.members.map(n => appsCache.find(a => a.name === n)).filter(Boolean)
  const pub = members.filter(a => a.manifest.public !== false)
  const priv = members.filter(a => a.manifest.public === false)
  const W = 820, NW = 158, NH = 52
  const rowY = { ingress: 30, pub: 140, priv: 268 }
  const H = priv.length ? 370 : 250
  const place = (arr, y) => arr.map((a, i) => ({ a, x: (W / (arr.length + 1)) * (i + 1) - NW / 2, y }))
  const nodes = [...place(pub, rowY.pub), ...place(priv, rowY.priv)]
  const pos = {}
  nodes.forEach(n => { pos[n.a.name] = n })
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '">'
    + '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M0 0 L10 5 L0 10 z" fill="var(--accent)"/></marker>'
    + '<marker id="arrb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M0 0 L10 5 L0 10 z" fill="#82b8e8"/></marker></defs>'
  // system boundary (the private network)
  svg += '<rect x="14" y="' + (rowY.pub - 34) + '" width="' + (W - 28) + '" height="' + (H - rowY.pub + 14) + '" rx="12" fill="none" stroke="var(--faint)" stroke-dasharray="7 6" opacity=".55"/>'
    + '<text x="30" y="' + (rowY.pub - 14) + '" fill="var(--faint)" font-size="10" letter-spacing="2">SLAB-NET-' + esc(sysName).toUpperCase() + '</text>'
  // ingress node
  if (pub.length) {
    svg += '<rect x="' + (W / 2 - 70) + '" y="' + rowY.ingress + '" width="140" height="34" rx="6" fill="#0b0c0e" stroke="#82b8e8"/>'
      + '<text x="' + (W / 2) + '" y="' + (rowY.ingress + 21) + '" fill="#82b8e8" font-size="11" text-anchor="middle">ingress :8080</text>'
    for (const n of place(pub, rowY.pub)) {
      svg += '<path d="M ' + (W / 2) + ' ' + (rowY.ingress + 34) + ' C ' + (W / 2) + ' ' + (rowY.pub - 40) + ', ' + (n.x + NW / 2) + ' ' + (rowY.pub - 44) + ', ' + (n.x + NW / 2) + ' ' + (n.y - 2) + '" fill="none" stroke="#82b8e8" stroke-width="1.6" marker-end="url(#arrb)" opacity=".7"/>'
    }
  }
  // wires: key "<caller>.<ENV>" -> value URL mentioning callee hostname
  const wires = Object.entries(sys.wires ?? {})
  for (const [k, v] of wires) {
    const caller = k.split('.')[0]
    const envKey = k.slice(caller.length + 1)
    const callee = sys.members.find(m => new RegExp('//' + m + '([:/]|$)').test(v))
    if (!pos[caller] || !callee || !pos[callee]) continue
    const c1 = pos[caller], c2 = pos[callee]
    const x1 = c1.x + NW / 2, y1 = c1.y + NH, x2 = c2.x + NW / 2, y2 = c2.y - 2
    const midY = (y1 + y2) / 2
    svg += '<path d="M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ', ' + x2 + ' ' + midY + ', ' + x2 + ' ' + y2 + '" fill="none" stroke="var(--accent)" stroke-width="2" marker-end="url(#arr)"/>'
      + '<text x="' + ((x1 + x2) / 2) + '" y="' + (midY - 6) + '" fill="var(--accent)" font-size="9" text-anchor="middle" opacity=".9">' + esc(envKey) + '</text>'
  }
  // app nodes (slab-styled)
  for (const n of nodes) {
    const a = n.a
    const priv2 = a.manifest.public === false
    svg += '<g>'
      + '<rect x="' + n.x + '" y="' + n.y + '" width="' + NW + '" height="' + NH + '" rx="7" fill="#1b1d22" stroke="' + (priv2 ? 'var(--faint)' : '#33363e') + '"' + (priv2 ? ' stroke-dasharray="4 3"' : '') + '/>'
      + '<circle cx="' + (n.x + 16) + '" cy="' + (n.y + NH / 2) + '" r="4" fill="' + nodeColor(a) + '"/>'
      + '<text x="' + (n.x + 30) + '" y="' + (n.y + 22) + '" fill="#ece9e2" font-size="12" font-weight="700">' + esc(a.name) + '</text>'
      + '<text x="' + (n.x + 30) + '" y="' + (n.y + 38) + '" fill="var(--faint)" font-size="9">' + (priv2 ? 'private - :' : ':') + a.manifest.port + ' - ' + a.manifest.type + '</text>'
      + '</g>'
  }
  svg += '</svg>'
  document.getElementById('dg-title').textContent = 'system: ' + sysName
  document.getElementById('dg-body').innerHTML = svg
  document.getElementById('overlay').style.display = 'block'
}


// ── monitor deck: live events -> spectrum visualizer + pentatonic audio ──────
const energy = {}      // app -> 0..1 bar energy
const peaks = {}       // app -> peak-hold height
let evtTimes = []      // rolling minute of event timestamps
let audioCtx = null
let listening = false
function toggleListen() {
  listening = !listening
  document.getElementById('knob').classList.toggle('on', listening)
  if (listening && !audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  if (listening && audioCtx.state === 'suspended') audioCtx.resume()
}
// pentatonic minor over two octaves — any combination harmonizes
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22]
function hashStr(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h)
}
function blip(app) {
  if (!listening || !audioCtx) return
  const semi = SCALE[hashStr(app) % SCALE.length]
  const freq = 220 * Math.pow(2, semi / 12)
  const t = audioCtx.currentTime
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.type = 'triangle'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.exponentialRampToValueAtTime(0.09, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
  osc.connect(gain).connect(audioCtx.destination)
  osc.start(t)
  osc.stop(t + 0.25)
}
function onLiveEvent(app) {
  energy[app] = Math.min(1, (energy[app] ?? 0) + 0.45)
  evtTimes.push(Date.now())
  blip(app)
}
function playApps() {
  if (!listening) toggleListen()   // user gesture — safe to start audio
  fetch('/v1/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seconds":45}' })
}
function deployChord(app) {
  if (!listening || !audioCtx) return
  const semi = SCALE[hashStr(app) % SCALE.length]
  const t = audioCtx.currentTime
  for (const off of [-12, 0]) {
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 220 * Math.pow(2, (semi + off) / 12)
    gain.gain.setValueAtTime(0.001, t)
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start(t)
    osc.stop(t + 0.85)
  }
}
const es = new EventSource('/v1/events')
es.onmessage = (m) => {
  try {
    const e = JSON.parse(m.data)
    if (e.type === 'request' && e.app) onLiveEvent(e.app)
    if (e.type === 'deploy' && e.app) { energy[e.app] = 1; deployChord(e.app) }
  } catch { /* ignore */ }
}
function accentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffb454'
}
function drawViz() {
  const cv = document.getElementById('viz')
  const ctx = cv.getContext('2d')
  const W = cv.width, H = cv.height
  // motion trails: translucent fade instead of clear (screensaver energy)
  ctx.fillStyle = 'rgba(11,12,9,0.28)'
  ctx.fillRect(0, 0, W, H)
  const apps = appsCache
  if (apps.length) {
    const bw = W / apps.length
    const ac = accentColor()
    const now = Date.now() / 1000
    apps.forEach((a, i) => {
      const name = a.name
      let e = energy[name] ?? 0
      // idle shimmer so the deck breathes even in silence
      const shimmer = a.state === 'running' ? 0.03 + 0.02 * Math.sin(now * 1.7 + i * 1.3) : 0
      const h = Math.max(2, (e + shimmer) * (H - 14))
      const x = i * bw + bw * 0.18, w = bw * 0.64
      ctx.fillStyle = ac
      ctx.globalAlpha = 0.28 + 0.72 * Math.min(1, e + shimmer)
      ctx.shadowColor = ac
      ctx.shadowBlur = e > 0.05 ? 14 : 3
      ctx.fillRect(x, H - h, w, h)
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
      // falling peak-hold cap
      const pk = Math.max(peaks[name] ?? 0, h)
      peaks[name] = pk - 0.6
      ctx.fillStyle = '#f2f6ef'
      ctx.fillRect(x, Math.max(2, H - pk - 3), w, 2)
      energy[name] = e * 0.93
    })
  }
  requestAnimationFrame(drawViz)
}
requestAnimationFrame(drawViz)
setInterval(() => {
  const now = Date.now()
  evtTimes = evtTimes.filter(t => now - t < 60_000)
  document.getElementById('deck-lcd').textContent = String(evtTimes.length).padStart(3, '0') + ' evt/min'
}, 2000)

function tick() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString()
}
const savedAccent = localStorage.getItem('slab-accent')
if (savedAccent) document.documentElement.style.setProperty('--accent', savedAccent)
function setAccent(v) {
  document.documentElement.style.setProperty('--accent', v)
  localStorage.setItem('slab-accent', v)
  const inp = document.getElementById('accent-input')
  if (inp) inp.value = v
}
function openSettings() {
  const presets = ['#ffb454', '#6ee7b7', '#82b8e8', '#f07f78', '#d8b4fe', '#e2e8f0']
  const cur = localStorage.getItem('slab-accent') ?? '#ffb454'
  document.getElementById('dtitle').textContent = 'settings'
  document.getElementById('dapps').innerHTML = ''
  document.getElementById('dbody').innerHTML =
    '<div class="setrow"><span class="k">accent color</span>'
    + '<input type="color" id="accent-input" value="' + cur + '" oninput="setAccent(this.value)">'
    + '<span class="swatches">' + presets.map(c => '<i style="background:' + c + '" onclick="setAccent(\\'' + c + '\\')"></i>').join('') + '</span>'
    + '</div>'
    + '<div class="setrow"><span class="k">state</span><span style="color:var(--faint)">~/.slab · state.json, secrets/, repos/</span></div>'
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
