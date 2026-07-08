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
<script>
  // theme init before first paint (no flash): saved choice, else OS preference
  document.documentElement.dataset.theme =
    localStorage.getItem('slab-theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
</script>
<style>
  :root {
    --bg: #131418; --rail: #0d0e11;
    --unit-hi: #26282f; --unit-lo: #1b1d22; --edge: #33363e; --groove: #0a0b0d;
    --text: #ece9e2; --dim: #9a9da5; --faint: #5f626a;
    --accent: #ffb454;
    --amber: var(--accent); --green: #71d68d; --red: #f07f78; --blue: #82b8e8;
    --board: #14170f; --trace: color-mix(in srgb, var(--accent) 28%, transparent);
    /* chassis palette (dark) — overridden wholesale by the light theme below */
    --unit1: #202127; --unit2: #17181d; --unit3: #101116; --unit4: #15161b;
    --cab-hi: #101114; --cab-lo: #0c0d10; --cheek: #241a12;
    --edge2: #2b2d34; --edge3: #26282e; --line: #1c1e24;
    --od: #3a3d44; --node: #1b1d22;
    --drawer-bg: #0b0c0e; --scrim: rgba(8,9,11,.82); --btn-bg: rgba(0,0,0,.25);
  }
  /* light: daylight machine room — aluminum faceplates, putty chassis, oak cheeks.
     Screens (viz, LCDs, VU meters, sleds, thumbs, PCB boards) stay dark glass. */
  :root[data-theme="light"] {
    --bg: #e9e6df; --rail: #c9c6bf;
    --unit-hi: #f2f0ea; --unit-lo: #f6f4ef; --edge: #b3b0a8; --groove: #a49f96;
    --text: #26272d; --dim: #55575e; --faint: #8b8d93;
    --accent: #c8791b;
    --unit1: #f7f5f0; --unit2: #edebe5; --unit3: #e0ded7; --unit4: #e8e6df;
    --cab-hi: #d9d6cf; --cab-lo: #c8c5be; --cheek: #b08a5c;
    --edge2: #bfbcb4; --edge3: #c8c5bd; --line: #d9d6cf;
    --od: #b5b2aa; --node: #f6f4ef;
    --drawer-bg: #f2f0ea; --scrim: rgba(120,118,112,.55); --btn-bg: rgba(255,255,255,.45);
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

  .layout { display: block; }
  .wrap { padding-left: 56px; }
  .spine { display: flex; flex-direction: column; gap: 2px; position: fixed; top: 48px; left: clamp(8px, 2vw, 40px); z-index: 200; }
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
    color: var(--accent); background: var(--drawer-bg); border: 1px solid var(--edge);
    padding: 3px 8px; border-radius: 4px; z-index: 30;
  }
  .spine span:first-child { color: var(--accent); }

  /* cabinet: matte monolith with scattered vent perforations (oxide-style) */
  .cabinet {
    background: linear-gradient(180deg, var(--cab-hi), var(--cab-lo));
    border: 1px solid var(--groove); border-radius: 12px;
    border-left: 9px solid transparent; border-right: 9px solid transparent;
    background-clip: padding-box; position: relative;
    box-shadow: 0 12px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.03);
    overflow: hidden;
  }
  .cabinet::before, .cabinet + .cabinet::before { content: none; }
  .cabinet { box-shadow: -9px 0 0 0 var(--cheek), 9px 0 0 0 var(--cheek), -9px 2px 8px rgba(0,0,0,.5), 9px 2px 8px rgba(0,0,0,.5), 0 12px 40px rgba(0,0,0,.5); }
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
  #viz { cursor: pointer; }
  .cabinet.flash { animation: flashcab 900ms ease-out; }
  @keyframes flashcab { 0%, 30% { box-shadow: -9px 0 0 0 var(--accent), 9px 0 0 0 var(--accent), 0 0 30px color-mix(in srgb, var(--accent) 40%, transparent); } 100% { box-shadow: -9px 0 0 0 var(--cheek), 9px 0 0 0 var(--cheek), 0 12px 40px rgba(0,0,0,.5); } }
  @media (prefers-reduced-motion: reduce) { .cabinet.flash { animation: none; } }
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
  .chinfo { float: right; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; margin-right: 14px; opacity: .9; }
  .diagbtn { float: right; background: none; border: 1px solid var(--edge); border-radius: 4px; color: var(--dim);
    font: inherit; font-size: 10px; padding: 2px 10px; cursor: pointer; letter-spacing: .08em; }
  .diagbtn:hover { color: var(--accent); border-color: var(--accent); }
  #overlay { position: fixed; inset: 0; display: none; background: var(--scrim); z-index: 100;
    padding: 5vh 5vw; backdrop-filter: blur(3px); }
  #overlay .panel { max-width: 860px; margin: 0 auto; background: linear-gradient(180deg, var(--cab-hi), var(--cab-lo));
    border: 1px solid var(--edge); border-radius: 12px; padding: 18px 22px; box-shadow: 0 24px 70px rgba(0,0,0,.7); }
  #overlay .panel h2 { font-size: 11px; color: var(--accent); letter-spacing: .18em; text-transform: uppercase; margin-bottom: 4px; }
  #overlay .panel .note { color: var(--faint); font-size: 10px; margin-bottom: 12px; }
  #overlay svg { width: 100%; height: auto; display: block; }
  #overlay text { font-family: ui-monospace, Menlo, monospace; }
  @keyframes cursor { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cabmark::after { animation: none; } }

  .ovbtn { background: none; border: 1px solid var(--edge); border-radius: 5px; color: var(--dim);
    font-size: 15px; width: 32px; height: 32px; cursor: pointer; align-self: center; }
  .ovbtn:hover, .ovbtn.on { color: var(--accent); border-color: var(--accent); }
  #overview { display: none; }
  body.overview #cabinets { display: none; }
  body.overview #overview { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; }
  body.overview .deck { display: none; }
  body.overview .jobdeck { display: none; }
  .otile {
    background: linear-gradient(180deg, var(--unit1), var(--unit3)); border: 1px solid var(--edge2); border-radius: 10px;
    padding: 14px; cursor: pointer; position: relative; overflow: hidden;
    box-shadow: 0 4px 12px rgba(0,0,0,.4); transition: transform .12s, border-color .12s;
  }
  .otile:hover { transform: translateY(-2px); border-color: var(--accent); }
  .otile.err { border-color: color-mix(in srgb, var(--red) 55%, var(--edge2)); }
  .otile .oname { font-size: 14px; font-weight: 800; letter-spacing: .02em; }
  .otile .otag { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); margin-top: 1px; }
  .otile .odots { display: flex; flex-wrap: wrap; gap: 5px; margin: 12px 0 10px; }
  .otile .od { width: 9px; height: 9px; border-radius: 50%; background: var(--od); }
  .otile .od.running { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .otile .od.sleeping { background: var(--blue); opacity: .7; }
  .otile .od.error { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .otile .od.priv { outline: 1px dashed var(--faint); outline-offset: 1px; }
  .otile .ofoot { display: flex; justify-content: space-between; font-size: 10px; color: var(--dim); }
  .otile .obar { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--accent); transition: width .5s; }
  .ovhead { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 12px; margin-bottom: 2px; }
  .ovhead h2 { font-size: 12px; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); }
  .ovhead span { font-size: 10px; color: var(--faint); }

  /* ── workbench slides in from the right over the rack ── */
  #cube { position: relative; }
  #face-bench {
    position: fixed; inset: 0; z-index: 60; background: var(--bg);
    overflow: auto; padding: 24px clamp(16px, 3vw, 48px) 40px 72px;
    transform: translateX(100%); transition: transform .42s cubic-bezier(.4,.0,.2,1);
    box-shadow: -24px 0 60px rgba(0,0,0,.6);
  }
  body.bench-open #face-bench { transform: translateX(0); }
  @media (prefers-reduced-motion: reduce) { #face-bench { transition: none; } }
  .bench-head { display: flex; align-items: center; gap: 18px; margin-bottom: 14px; }
  .bench-head h2 { font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: var(--accent); }
  .benchback { background: none; border: 1px solid var(--edge); border-radius: 5px; color: var(--dim);
    font: inherit; font-size: 11px; padding: 5px 14px; cursor: pointer; }
  .benchback:hover { color: var(--accent); border-color: var(--accent); }
  #bench-switch { margin-left: auto; display: flex; gap: 6px; }
  #bench-switch button { background: none; border: 1px solid var(--edge); border-radius: 4px; color: var(--dim);
    font: inherit; font-size: 10px; padding: 3px 10px; cursor: pointer; }
  #bench-switch button.active { color: var(--accent); border-color: var(--accent); }
  .bench-body { display: grid; grid-template-columns: 1fr 320px; gap: 20px; align-items: start; }
  #bench-diagram { background: linear-gradient(180deg, var(--cab-hi), var(--cab-lo)); border: 1px solid var(--groove);
    border-radius: 12px; padding: 18px; min-height: 60vh; display: flex; align-items: center; }
  #bench-diagram svg { width: 100%; height: auto; }
  #bench-diagram .node { cursor: pointer; }
  #bench-diagram .node:hover rect { stroke: var(--accent); }
  #bench-diagram .node.sel rect { stroke: var(--accent); stroke-width: 2; }
  #bench-panel { background: linear-gradient(180deg, var(--unit2), var(--unit3)); border: 1px solid var(--edge2);
    border-radius: 10px; padding: 16px; position: sticky; top: 16px; }
  .bench-hint { color: var(--faint); font-size: 11px; text-align: center; padding: 30px 0; }
  .mgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .mcard { background: var(--unit3); border: 1px solid var(--edge2); border-radius: 9px; overflow: hidden; cursor: pointer;
    transition: transform .12s, border-color .12s; }
  .mcard:hover { transform: translateY(-2px); border-color: var(--accent); }
  .mcard.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .mcshot { height: 132px; overflow: hidden; background: #fff; position: relative; }
  .mcshot iframe { width: 840px; height: 528px; border: 0; transform: scale(.25); transform-origin: top left; pointer-events: none; }
  .mcshot.off { display: flex; align-items: center; justify-content: center; background: #0b0c0e; color: var(--faint); font-size: 11px; }
  .mcname { display: flex; align-items: center; gap: 7px; padding: 9px 11px 2px; font-size: 13px; font-weight: 700; }
  .mcname .od { width: 8px; height: 8px; border-radius: 50%; background: var(--od); }
  .mcname .od.running { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .mcname .od.sleeping { background: var(--blue); } .mcname .od.error { background: var(--red); }
  .mcsub { padding: 0 11px 10px; font-size: 10px; color: var(--faint); text-transform: uppercase; letter-spacing: .1em; }
  .mdiagram { background: linear-gradient(180deg, var(--cab-hi), var(--cab-lo)); border: 1px solid var(--groove); border-radius: 12px; padding: 16px; }
  .viewport { border: 1px solid var(--edge2); border-radius: 8px; overflow: hidden; margin-bottom: 14px; background: #0b0c0e; }
  .viewport .vpbar { display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: 10px; color: #9a9da5;
    background: linear-gradient(180deg, #1c1e24, #141519); border-bottom: 1px solid #26282e; }
  .viewport .vpdot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); }
  .viewport .vpopen { margin-left: auto; color: var(--blue); text-decoration: none; }
  .viewport .vpopen:hover { text-decoration: underline; }
  .viewport iframe { width: 100%; height: 300px; border: 0; display: block; background: #fff; }
  .viewport.off { color: var(--faint); font-size: 11px; text-align: center; padding: 40px 12px; line-height: 1.7; }
  .viewport.off span { color: #45474e; font-size: 10px; }
  /* mini live thumbnail on the rack unit itself */
  .thumb { width: 132px; height: 82px; border: 1px solid var(--edge2); border-radius: 5px; overflow: hidden;
    background: #0b0c0e; position: relative; flex-shrink: 0; }
  .thumb iframe { width: 528px; height: 328px; border: 0; transform: scale(.25); transform-origin: top left;
    pointer-events: none; background: #fff; }
  .thumb .tcap { position: absolute; inset: 0; cursor: pointer; }
  .thumb.off { display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: 9px; text-align: center; padding: 6px; }
  #bench-panel .pname { font-size: 16px; font-weight: 800; margin-bottom: 2px; }
  #bench-panel .pstate { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin-bottom: 12px; }
  #bench-panel .prow { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  #bench-panel .board { min-height: 0; cursor: default; padding: 12px; }
  #bench-panel .board::after { content: none; }
  #bench-panel .pwires { margin-top: 12px; font-size: 11px; }
  #bench-panel .pwires .w { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); color: var(--dim); }
  #bench-panel .pwires .w b { color: var(--accent); font-weight: 500; }
  @media (max-width: 900px) { .bench-body { grid-template-columns: 1fr; } }

  /* monitor deck: spectrum analyzer + listen knob (a component above the cabinets) */
  .deck {
    display: grid; grid-template-columns: auto auto 1fr auto; gap: 18px; align-items: center;
    background:
      repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px),
      linear-gradient(180deg, var(--unit1) 0%, var(--unit2) 18%, var(--unit3) 60%, var(--unit4) 100%);
    border: 1px solid var(--edge2); border-radius: 8px;
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
  .playbtn { width: 40px; height: 40px; border-radius: 50%; cursor: pointer; color: #9a9da5; font-size: 13px;
    background: radial-gradient(circle at 35% 30%, #33363e, #14151a 75%); border: 1px solid #3a3d45; padding: 0;
    box-shadow: inset 0 2px 4px rgba(0,0,0,.6), 0 2px 5px rgba(0,0,0,.5); }
  .playbtn:hover { color: var(--accent); border-color: var(--accent); }
  .knob.on + .klbl { color: var(--accent); }
  #viz { width: 100%; height: 64px; display: block; background: #0b0c09; border: 1px solid #26282e; border-radius: 4px;
    box-shadow: inset 0 1px 5px rgba(0,0,0,.8); }
  .deck .lcd { align-self: center; }

  /* ── job bench: run-to-completion workloads (slab run) ── */
  .jobdeck {
    background:
      repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px),
      linear-gradient(180deg, var(--unit1) 0%, var(--unit2) 18%, var(--unit3) 60%, var(--unit4) 100%);
    border: 1px solid var(--edge2); border-radius: 8px; padding: 10px 16px; margin-bottom: 16px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.07), inset 0 -1px 0 rgba(0,0,0,.4), 0 5px 14px rgba(0,0,0,.3);
  }
  .jobdeck h3 { font-size: 9px; letter-spacing: .2em; text-transform: uppercase; color: var(--faint); margin-bottom: 2px; }
  .jobrow { display: flex; align-items: center; gap: 12px; padding: 7px 2px; font-size: 12px; }
  .jobrow + .jobrow { border-top: 1px solid var(--line); }
  .jl { width: 8px; height: 8px; border-radius: 50%; background: var(--od); flex-shrink: 0; }
  .jl.queued, .jl.building { background: var(--amber); box-shadow: 0 0 6px var(--amber); animation: breathe 1s ease-in-out infinite; }
  .jl.running { background: var(--amber); box-shadow: 0 0 6px var(--amber); animation: breathe 2s ease-in-out infinite; }
  .jl.succeeded { background: var(--green); }
  .jl.failed { background: var(--red); box-shadow: 0 0 6px var(--red); }
  @media (prefers-reduced-motion: reduce) { .jl { animation: none !important; } }
  .jid { font-weight: 700; white-space: nowrap; }
  .jcmd { color: var(--dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jmeta { color: var(--faint); font-size: 10px; letter-spacing: .06em; white-space: nowrap; }
  .jobrow button { padding: 2px 9px; font-size: 10px; }

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
    display: grid; grid-template-columns: 30px 1fr auto auto auto; gap: 18px; align-items: center;
    background:
      repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px),
      linear-gradient(180deg, var(--unit1) 0%, var(--unit2) 18%, var(--unit3) 60%, var(--unit4) 100%);
    border: 1px solid var(--edge2); border-radius: 8px;
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
    background: var(--btn-bg); color: var(--dim); border: 1px solid var(--edge); border-radius: 5px;
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
  .chip .val { font-size: 11px; color: #ece9e2; margin-top: 2px; word-break: break-all; max-width: 260px; }
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
  .setrow { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
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
    background: var(--drawer-bg); border-top: 1px solid var(--edge); padding: 14px clamp(20px, 4vw, 56px);
    overflow: auto; font-size: 12px; white-space: pre-wrap; box-shadow: 0 -14px 40px rgba(0,0,0,.6);
  }
  #drawer .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--faint);
    font-size: 10px; text-transform: uppercase; letter-spacing: .16em; margin-bottom: 10px;
    position: sticky; top: 0; background: var(--drawer-bg); padding-bottom: 6px; }
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
<div class="spine" id="spine">
  <span data-nav="status" onclick="navStatus()">S</span>
  <span data-nav="logs" onclick="navLogs()">L</span>
  <span data-nav="api — raw json" onclick="window.open('/v1/apps')">A</span>
  <span data-nav="boards — flip all" onclick="navBoards()">B</span>
</div>
<div id="cube"><div id="face-rack">
<div class="wrap">
<header>
  <h1>the localhost <b>hyperscaler</b></h1>
  <div class="stats">
    <div class="stat"><b id="s-apps">–</b><span>apps</span></div>
    <div class="stat"><b id="s-run">–</b><span>running</span></div>
    <div class="stat"><b id="s-rpm">–<em>/m</em></b><span>requests</span></div>
    <button class="ovbtn" id="ovbtn" onclick="toggleOverview()" title="overview (zoom out)">&#9638;</button>
    <button class="ovbtn" id="thbtn" onclick="toggleTheme()" title="light / dark">&#9681;</button>
  </div>
</header>
<div class="deck">
  <div class="knobwrap"><button class="knob" id="knob" onclick="toggleListen()"></button><span class="klbl">listen</span></div>
  <div class="knobwrap"><button class="playbtn" onclick="playApps()">&#9654;</button><span class="klbl">play</span></div>
  <canvas id="viz" width="800" height="64"></canvas>
  <span class="lcd" id="deck-lcd">000 evt/min</span>
</div>
<div class="jobdeck" id="jobs" style="display:none"></div>
<div class="layout">
  <div id="cabinets"></div>
  <div id="overview"></div>
</div>
<footer>
  <span>ingress :${proxyPort} · api :7766</span>
  <button class="settings" onclick="openSettings()">settings</button>
  <span id="clock"></span>
</footer>
</div>
<div id="overlay" onclick="this.style.display='none'"><div class="panel" onclick="event.stopPropagation()"><h2 id="dg-title"></h2><div class="note">apps call each other along the amber wires - the dashed boundary is the system's private network - click outside to close</div><div id="dg-body"></div></div></div>
</div><div id="face-bench">
  <div class="bench-head">
    <button class="benchback" onclick="exitBench()">&#9666; rack</button>
    <h2 id="bench-title"></h2>
    <span id="bench-switch"></span>
  </div>
  <div class="bench-body">
    <div id="bench-diagram"></div>
    <div id="bench-panel"><div class="bench-hint">click a node to work on it</div></div>
  </div>
</div></div>
<div id="drawer"><div class="bar"><span id="dtitle"></span><span id="dapps"></span><button onclick="drawer.style.display='none'">close</button></div><div id="dbody"></div></div>
<script>
const drawer = document.getElementById('drawer')
const hist = {}          // name -> recent reqPerMin samples
const openBays = new Set()  // names of flipped-open units (persists across refresh)
let appsCache = []
let systemsCache = []
let jobsCache = []
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = t
  localStorage.setItem('slab-theme', t)
}
function toggle() {
  // one gesture, whole rack: flip every board together
  if (openBays.size) openBays.clear()
  else for (const a of appsCache) openBays.add(a.name)
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
function vuAngle(rpm, state) {
  return state !== 'running' ? -48 : -48 + Math.min(96, Math.log2(rpm + 1) * 16)
}
function vuMeter(rpm, state, name) {
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
  return '<svg class="vu" data-app="' + (name ?? '') + '" width="96" height="50" viewBox="0 0 96 50">'
    + '<rect x="1" y="1" width="94" height="48" rx="5" fill="#0d0e0a" stroke="#2a2c26"/>'
    + '<ellipse cx="48" cy="46" rx="40" ry="38" fill="color-mix(in srgb, var(--accent) ' + (dead ? '4' : '10') + '%, transparent)"/>'
    + ticks.join('')
    + '<line class="needle" x1="48" y1="46" x2="48" y2="14" stroke="' + (dead ? '#4a4d55' : 'var(--accent)') + '" stroke-width="1.6"'
    +   ' style="transform: rotate(' + (dead ? -48 : angle).toFixed(1) + 'deg)"/>'
    + '<circle cx="48" cy="46" r="3" fill="#2a2c30"/>'
    + '<text x="10" y="12" font-size="6" fill="#5f626a">VU</text>'
    + '</svg>'
}
// tiny live thumbnail — only for running public apps (a scaled, inert iframe)
function thumb(a) {
  if (a.state === 'running' && a.manifest.public !== false && a.hostPort != null) {
    const u = 'http://' + a.name + '.localhost:${proxyPort}/'
    return '<div class="thumb"><iframe src="' + u + '" loading="lazy" scrolling="no" sandbox="allow-scripts allow-same-origin"></iframe>'
      + '<a class="tcap" href="' + u + '" target="_blank" title="open ' + esc(a.name) + '"></a></div>'
  }
  return '<div class="thumb off">' + (a.manifest.public === false ? '🔒' : a.state === 'sleeping' ? '● zzz' : '○') + '</div>'
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
    + '<div class="sled" data-app="' + a.name + '">' + sled + '</div>'
    + '<button class="pwr" title="' + (a.state === 'running' ? 'power off (stop)' : 'power on (start)') + '"'
    +   ' onclick="event.stopPropagation(); act(\\'' + a.name + '\\', \\'' + (a.state === 'running' ? 'stop' : 'start') + '\\')"></button>'
    + '<div class="plate" onclick="toggle()" title="flip all boards">'
    +   '<div class="name">' + esc(a.name) + '<small>' + a.state + '</small><span class="hint">▸ flip</span></div>'
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
    + thumb(a)
    + '<div class="meter">' + vuMeter(rpm, a.state, a.name) + '<span class="lcd" data-app="' + a.name + '">' + String(rpm).padStart(3, '0') + ' req/min</span><span class="spark" data-app="' + a.name + '">' + spark(a.name) + '</span></div>'
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
    + '<div class="face back"><div class="board" onclick="toggle()">' + boardHtml(a) + '</div></div>'
    + '</div></div>'
}
function channelInfo(rackKey) {
  const racks = rackOrder()
  const idx = Math.max(0, racks.indexOf(rackKey))
  const pan = racks.length > 1 ? -0.8 + (1.6 * idx) / (racks.length - 1) : 0
  const pos = pan < -0.2 ? 'L' : pan > 0.2 ? 'R' : 'C'
  return '<span class="chinfo" style="color:' + rackColor(idx) + '">ch' + (idx + 1) + ' - ' + pos + ' - ' + RACK_WAVES[idx % RACK_WAVES.length] + '</span>'
}
function cabinetHtml(title, apps, slim, sys) {
  const rackKey = sys ? sys.name : null
  const cabId = 'cab-' + (sys ? sys.name : 'slab')
  const sub = (sys
    ? '<span class="cabinfo">system - ' + sys.members.length + ' members - ' + Object.keys(sys.wires ?? {}).length + ' wires</span>'
      + '<button class="diagbtn" onclick="openDiagram(\\'' + esc(sys.name) + '\\')">&#8909; diagram</button>'
    : '') + channelInfo(rackKey)
  return '<div class="cabinet" id="' + cabId + '">'
    + '<div class="vents' + (slim ? ' slim' : '') + '"></div>'
    + '<div class="rack">' + apps.map((a, i) => bayHtml(a, i)).join('') + '</div>'
    + '<div class="cabmark">' + esc(title) + sub + '</div>'
    + '</div>'
}
// A structural signature: everything that changes the DOM SHAPE (not live
// metrics). If unchanged, we skip innerHTML rebuild so iframes never reload —
// live metrics get patched in place by updateDynamics() instead.
function structSig() {
  return JSON.stringify(appsCache.map(a => [a.name, a.state, a.manifest.public, a.exposed, a.hostPort != null, rackOf(a.name), openBays.has(a.name)]))
    + '|' + JSON.stringify(systemsCache.map(s => [s.name, s.members]))
}
let lastStructSig = ''
function updateDynamics() {
  for (const a of appsCache) {
    const rpm = a.reqPerMin ?? 0
    const lcd = document.querySelector('.lcd[data-app="' + a.name + '"]')
    if (lcd) lcd.textContent = String(rpm).padStart(3, '0') + ' req/min'
    const needle = document.querySelector('.vu[data-app="' + a.name + '"] .needle')
    if (needle) needle.style.transform = 'rotate(' + vuAngle(rpm, a.state).toFixed(1) + 'deg)'
    const sledEl = document.querySelector('.sled[data-app="' + a.name + '"]')
    if (sledEl) {
      const lit = a.state === 'running' ? Math.min(8, 1 + Math.ceil(Math.log2(rpm + 1))) : 1
      ;[...sledEl.children].forEach((el, k) => el.classList.toggle('on', k < lit))
    }
    const sp = document.querySelector('.spark[data-app="' + a.name + '"]')
    if (sp) sp.innerHTML = spark(a.name)
  }
}
// ── job bench ────────────────────────────────────────────────────────────────
function jobDur(j) {
  if (!j.startedAt) return ''
  const end = j.finishedAt ? new Date(j.finishedAt).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(j.startedAt).getTime()) / 1000))
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60 ? (s % 60) + 's' : '')
}
async function jobAct(id, verb) {
  await fetch('/v1/jobs/' + id + '/' + verb, { method: 'POST' })
  load()
}
async function jobRm(id) {
  await fetch('/v1/jobs/' + id, { method: 'DELETE' })
  load()
}
async function showJobLogs(id) {
  document.getElementById('dtitle').textContent = 'job — ' + id
  document.getElementById('dapps').innerHTML = ''
  document.getElementById('dbody').textContent = 'loading…'
  drawer.style.display = 'block'
  const r = await fetch('/v1/jobs/' + id + '/logs?tail=500')
  const d = await r.json()
  document.getElementById('dbody').textContent = d.logs ?? d.error ?? ''
}
function renderJobs() {
  const el = document.getElementById('jobs')
  if (!jobsCache.length) { el.style.display = 'none'; el.innerHTML = ''; return }
  const live = new Set(['queued', 'building', 'running'])
  const rows = jobsCache.slice(0, 8).map(j => {
    const cmd = j.command.length ? j.command.join(' ') : (j.image ? j.image + ' (default cmd)' : 'default cmd')
    const meta = j.state
      + (j.exitCode != null ? ' · exit ' + j.exitCode : '')
      + (jobDur(j) ? ' · ' + jobDur(j) : '')
      + ' · ' + rel(j.createdAt)
    const acts = live.has(j.state)
      ? '<button class="warn" onclick="jobAct(\\'' + j.id + '\\',\\'cancel\\')">cancel</button>'
      : '<button onclick="showJobLogs(\\'' + j.id + '\\')">logs</button>'
        + '<button class="warn" onclick="jobRm(\\'' + j.id + '\\')">rm</button>'
    return '<div class="jobrow"><span class="jl ' + j.state + '"></span>'
      + '<span class="jid">' + esc(j.id) + '</span>'
      + '<span class="jcmd" title="' + esc(j.error ?? cmd) + '">' + esc(cmd) + (j.error ? ' — ' + esc(j.error.slice(0, 80)) : '') + '</span>'
      + '<span class="jmeta">' + esc(meta) + '</span>'
      + acts + '</div>'
  })
  el.innerHTML = '<h3>job bench — slab run</h3>' + rows.join('')
  el.style.display = 'block'
}
function render() {
  const apps = appsCache
  const systems = systemsCache
  const container = document.getElementById('cabinets')
  if (!apps.length) {
    container.innerHTML = '<div class="cabinet"><div class="vents"></div>'
      + '<div class="rack"><div class="empty">rack is empty — <code>slab deploy ./yourapp</code> mounts the first unit</div></div>'
      + '<div class="cabmark">slab</div></div>'
    lastStructSig = ''
    return
  }
  const sig = structSig()
  if (sig === lastStructSig) { updateDynamics(); return }   // no structural change — keep iframes alive
  lastStructSig = sig
  const sorted = [...systems].sort((x, y) => x.name.localeCompare(y.name))
  let html = sorted.map(s => cabinetHtml(s.name, apps.filter(a => s.members.includes(a.name)), true, s)).join('')
  const solo = apps.filter(a => !systems.some(s => s.members.includes(a.name)))
  if (solo.length) html += cabinetHtml('slab', solo, false)
  container.innerHTML = html
}
async function load() {
  const [r, rs, rj] = await Promise.all([fetch('/v1/apps'), fetch('/v1/systems'), fetch('/v1/jobs')])
  const d = await r.json()
  appsCache = d.apps ?? []
  systemsCache = []
  try { const ds = await rs.json(); systemsCache = ds.systems ?? [] } catch (e) {}
  jobsCache = []
  try { const dj = await rj.json(); jobsCache = dj.jobs ?? [] } catch (e) {}
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
  renderJobs()
  if (benchSys) benchRender()
  if (overviewOn) renderOverview()
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
function openDiagram(sysName) { enterBench(sysName) }
function diagramSvg(sys, clickable) {
  if (!sys) return ''
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
    + '<text x="30" y="' + (rowY.pub - 14) + '" fill="var(--faint)" font-size="10" letter-spacing="2">SLAB-NET-' + esc(sys.name).toUpperCase() + '</text>'
  // ingress node
  if (pub.length) {
    svg += '<rect x="' + (W / 2 - 70) + '" y="' + rowY.ingress + '" width="140" height="34" rx="6" fill="var(--node)" stroke="#82b8e8"/>'
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
    const cls = 'node' + (benchSel === a.name ? ' sel' : '')
    svg += clickable
      ? '<g class="' + cls + '" onclick="benchSelect(\\'' + a.name + '\\')">'
      : '<g>'
      + '<rect x="' + n.x + '" y="' + n.y + '" width="' + NW + '" height="' + NH + '" rx="7" fill="var(--node)" stroke="' + (priv2 ? 'var(--faint)' : 'var(--edge)') + '"' + (priv2 ? ' stroke-dasharray="4 3"' : '') + '/>'
      + '<circle cx="' + (n.x + 16) + '" cy="' + (n.y + NH / 2) + '" r="4" fill="' + nodeColor(a) + '"/>'
      + '<text x="' + (n.x + 30) + '" y="' + (n.y + 22) + '" fill="var(--text)" font-size="12" font-weight="700">' + esc(a.name) + '</text>'
      + '<text x="' + (n.x + 30) + '" y="' + (n.y + 38) + '" fill="var(--faint)" font-size="9">' + (priv2 ? 'private - :' : ':') + a.manifest.port + ' - ' + a.manifest.type + '</text>'
      + '</g>'
  }
  svg += '</svg>'
  return svg
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
// each rack (system cabinet) gets its own stereo position + waveform
const RACK_WAVES = ['triangle', 'sine', 'square', 'sawtooth']
function rackOrder() {
  const names = [...systemsCache].sort((a, b) => a.name.localeCompare(b.name)).map(s => s.name)
  const solo = appsCache.some(a => !systemsCache.some(s => s.members.includes(a.name)))
  return solo ? [...names, null] : names   // null = the standalone "slab" rack
}
function rackOf(appName) {
  const sys = [...systemsCache].sort((a, b) => a.name.localeCompare(b.name)).find(s => s.members.includes(appName))
  return sys ? sys.name : null
}
function hueShift(hex, deg) {
  const n = parseInt(hex.replace('#', ''), 16)
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255
  const l = (max + min) / 2, d = max - min
  let h = 0
  const s2 = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d) {
    const rr = r / 255, gg = g / 255, bb = b / 255
    h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4
    h *= 60
  }
  h = (h + deg + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s2, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  const [r2, g2, b2] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return '#' + to(r2) + to(g2) + to(b2)
}
function rackColor(rackIdx) {
  return hueShift(accentColor(), rackIdx * 42)
}
function rackChannel(appName) {
  const racks = rackOrder()
  const idx = Math.max(0, racks.indexOf(rackOf(appName)))
  const pan = racks.length > 1 ? -0.8 + (1.6 * idx) / (racks.length - 1) : 0
  return { pan, wave: RACK_WAVES[idx % RACK_WAVES.length] }
}
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
  const ch = rackChannel(app)
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.type = ch.wave
  osc.frequency.value = freq
  const vol = ch.wave === 'square' || ch.wave === 'sawtooth' ? 0.05 : 0.09
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
  let tail = gain
  if (audioCtx.createStereoPanner) {
    const panner = audioCtx.createStereoPanner()
    panner.pan.value = ch.pan
    gain.connect(panner)
    tail = panner
  }
  tail.connect(audioCtx.destination)
  osc.connect(gain)
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
    if (e.type === 'job') load()   // job state changed — refresh the bench promptly
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
  const racks = rackOrder()
  const apps = racks.flatMap(r => appsCache.filter(a => rackOf(a.name) === r))
  const bounds = []
  let acc = 0
  for (const r of racks) {
    acc += appsCache.filter(a => rackOf(a.name) === r).length
    bounds.push(acc)
  }
  if (apps.length) {
    const bw = W / apps.length
    const now = Date.now() / 1000
    apps.forEach((a, i) => {
      const name = a.name
      const rIdx = Math.max(0, rackOrder().indexOf(rackOf(name)))
      const ac = rackColor(rIdx)
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
    // rack channel separators + labels
    ctx.fillStyle = '#3a3d45'
    for (const b of bounds.slice(0, -1)) ctx.fillRect(b * bw - 1, 4, 2, H - 8)
    ctx.font = '8px ui-monospace'
    let start = 0
    racks.forEach((r, ri) => {
      ctx.fillStyle = rackColor(ri)
      ctx.globalAlpha = 0.85
      ctx.fillText((r ?? 'slab') + ' - ch' + (ri + 1), start * bw + 5, 11)
      ctx.globalAlpha = 1
      start = bounds[ri]
    })
  }
  requestAnimationFrame(drawViz)
}
requestAnimationFrame(drawViz)
document.getElementById('viz').addEventListener('click', (e) => {
  const cv = e.currentTarget
  const racks = rackOrder()
  const total = appsCache.length
  if (!total) return
  const rel = (e.offsetX / cv.clientWidth) * total    // which app-column index
  let acc = 0, hitRack = racks[0]
  for (const r of racks) {
    acc += appsCache.filter(a => rackOf(a.name) === r).length
    if (rel < acc) { hitRack = r; break }
  }
  const el = document.getElementById('cab-' + (hitRack ?? 'slab'))
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900) }
})
setInterval(() => {
  const now = Date.now()
  evtTimes = evtTimes.filter(t => now - t < 60_000)
  document.getElementById('deck-lcd').textContent = String(evtTimes.length).padStart(3, '0') + ' evt/min'
}, 2000)


// ── workbench (compiz cube face 2) ───────────────────────────────────────────
let benchSys = null
let benchSel = null
function setHalfW() {
  document.documentElement.style.setProperty('--halfw', (window.innerWidth / 2) + 'px')
}
function enterBench(sysName) {
  benchSys = sysName
  benchSel = null
  benchRender()
  requestAnimationFrame(() => document.body.classList.add('bench-open'))
}
function exitBench() {
  document.body.classList.remove('bench-open')
  setTimeout(() => { benchSys = null }, 420)
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('bench-open')) exitBench()
  else if (e.key === 'Escape' && overviewOn) toggleOverview()
})
function benchSelect(name) {
  benchSel = name
  benchRender()
}
let benchShellKey = ''
function memberCard(a) {
  const canView = a.state === 'running' && a.manifest.public !== false && a.hostPort != null
  const u = 'http://' + a.name + '.localhost:${proxyPort}/'
  const preview = canView
    ? '<div class="mcshot"><iframe src="' + u + '" loading="lazy" scrolling="no" sandbox="allow-scripts allow-same-origin"></iframe></div>'
    : '<div class="mcshot off">' + (a.manifest.public === false ? '🔒 private' : a.state === 'sleeping' ? '● sleeping' : '○ ' + a.state) + '</div>'
  return '<div class="mcard' + (benchSel === a.name ? ' sel' : '') + '" onclick="benchSelect(\\'' + a.name + '\\')">'
    + preview
    + '<div class="mcname"><span class="od ' + a.state + '"></span>' + esc(a.name) + '</div>'
    + '<div class="mcsub">' + a.manifest.type + (a.manifest.public === false ? ' · private' : '') + '</div>'
    + '</div>'
}
function benchRender() {
  if (!benchSys) return
  const sys = systemsCache.find(s => s.name === benchSys)
  if (!sys) return
  const members = sys.members.map(n => appsCache.find(x => x.name === n)).filter(Boolean)
  // Rebuild the thumbnail grid + diagram ONLY when structure changes, so the
  // live iframes never reload mid-view.
  const shellKey = benchSys + '|' + structSig() + '|' + benchSel
  if (shellKey !== benchShellKey) {
    benchShellKey = shellKey
    document.getElementById('bench-title').textContent = 'workbench — ' + sys.name
    document.getElementById('bench-switch').innerHTML = ''
    document.getElementById('bench-diagram').innerHTML =
      '<div class="mgrid">' + members.map(memberCard).join('') + '</div>'
      + '<div class="mdiagram">' + diagramSvg(sys, true) + '</div>'
  }
  const panel = document.getElementById('bench-panel')
  const a = benchSel ? appsCache.find(x => x.name === benchSel) : null
  if (!a) {
    if (panel.dataset.sel !== '') { panel.dataset.sel = ''; panel.innerHTML = '<div class="bench-hint">click an app to work on it</div>' }
    return
  }
  // Only rebuild the panel when the selected app OR its structural state
  // changes — otherwise the preview iframe would reload every poll.
  const panelKey = a.name + '|' + a.state + '|' + a.exposed
  if (panel.dataset.key === panelKey) {
    const live = panel.querySelector('.pstate')
    if (live) live.textContent = a.state + ' - ' + a.manifest.type + (a.manifest.public === false ? ' - private' : '') + ' - ' + (a.reqPerMin ?? 0) + ' req/min'
    return
  }
  panel.dataset.key = panelKey
  panel.dataset.sel = a.name
  const rpm = a.reqPerMin ?? 0
  const wires = Object.entries(sys.wires ?? {}).filter(([k, v]) =>
    k.startsWith(a.name + '.') || new RegExp('//' + a.name + '([:/]|$)').test(v))
  // live viewport: iframe the app itself when it's public + running
  const canView = a.state === 'running' && a.manifest.public !== false && a.hostPort != null
  const viewUrl = 'http://' + a.name + '.localhost:${proxyPort}/'
  const viewport = canView
    ? '<div class="viewport"><div class="vpbar"><span class="vpdot"></span>' + esc(a.name) + '.localhost'
        + '<a href="' + viewUrl + '" target="_blank" class="vpopen">open ↗</a></div>'
        + '<iframe src="' + viewUrl + '" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>'
    : a.manifest.public === false
      ? '<div class="viewport off">🔒 private — no preview<br><span>reachable only inside ' + esc(benchSys) + '</span></div>'
      : '<div class="viewport off">' + (a.state === 'sleeping' ? '● sleeping — start to preview' : '○ ' + a.state + ' — no preview') + '</div>'
  panel.innerHTML =
    '<div class="pname">' + esc(a.name) + '</div>'
    + '<div class="pstate">' + a.state + ' - ' + a.manifest.type + (a.manifest.public === false ? ' - private' : '') + ' - ' + rpm + ' req/min</div>'
    + viewport
    + '<div class="prow">'
    +   '<button onclick="act(\\'' + a.name + '\\',\\'deploy\\')">deploy</button>'
    +   (a.state === 'running'
          ? '<button class="warn" onclick="act(\\'' + a.name + '\\',\\'stop\\')">stop</button>'
          : '<button onclick="act(\\'' + a.name + '\\',\\'start\\')">start</button>')
    +   '<button onclick="showLogs(\\'' + a.name + '\\')">logs</button>'
    +   (a.manifest.public === false ? ''
        : a.exposed
          ? '<button class="warn" onclick="act(\\'' + a.name + '\\',\\'hide\\')">hide</button>'
          : '<button class="hot" onclick="act(\\'' + a.name + '\\',\\'expose\\')">expose</button>')
    + '</div>'
    + '<div class="board">' + boardHtml(a) + '</div>'
    + (wires.length
        ? '<div class="pwires">' + wires.map(([k, v]) => '<div class="w"><b>' + esc(k) + '</b><span>' + esc(v) + '</span></div>').join('') + '</div>'
        : '')
}


// ── overview: zoom out to a tile per system (scales to a wall of racks) ───────
let overviewOn = false
function toggleOverview() {
  overviewOn = !overviewOn
  document.body.classList.toggle('overview', overviewOn)
  document.getElementById('ovbtn').classList.toggle('on', overviewOn)
  if (overviewOn) renderOverview()
}
function flyTo(cabId) {
  overviewOn = false
  document.body.classList.remove('overview')
  document.getElementById('ovbtn').classList.remove('on')
  requestAnimationFrame(() => {
    const el = document.getElementById(cabId)
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900) }
  })
}
function tileHtml(title, cabId, apps, isSys) {
  const running = apps.filter(a => a.state === 'running').length
  const err = apps.some(a => a.state === 'error')
  const rpm = apps.reduce((n, a) => n + (a.reqPerMin ?? 0), 0)
  const maxrpm = Math.max(1, ...appsCache.map(a => a.reqPerMin ?? 0))
  const dots = apps.map(a =>
    '<span class="od ' + a.state + (a.manifest.public === false ? ' priv' : '') + '" title="' + esc(a.name) + ' - ' + a.state + '"></span>'
  ).join('')
  return '<div class="otile' + (err ? ' err' : '') + '" onclick="flyTo(\\'' + cabId + '\\')">'
    + '<div class="oname">' + esc(title) + '</div>'
    + '<div class="otag">' + (isSys ? 'system' : 'standalone') + ' - ' + running + '/' + apps.length + ' up</div>'
    + '<div class="odots">' + dots + '</div>'
    + '<div class="ofoot"><span>' + rpm + ' req/min</span><span>' + apps.length + ' apps</span></div>'
    + '<div class="obar" style="width:' + Math.round((rpm / (maxrpm * Math.max(1, apps.length))) * 100) + '%"></div>'
    + '</div>'
}
function renderOverview() {
  const sorted = [...systemsCache].sort((a, b) => a.name.localeCompare(b.name))
  const solo = appsCache.filter(a => !systemsCache.some(s => s.members.includes(a.name)))
  let html = '<div class="ovhead"><h2>overview</h2><span>' + systemsCache.length + ' systems - ' + appsCache.length + ' apps - click a tile to fly in</span></div>'
  html += sorted.map(sys => tileHtml(sys.name, 'cab-' + sys.name, appsCache.filter(a => sys.members.includes(a.name)), true)).join('')
  if (solo.length) html += tileHtml('slab', 'cab-slab', solo, false)
  document.getElementById('overview').innerHTML = html
}

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
    ['GET', '/v1/jobs', 'all jobs (newest first)'],
    ['POST', '/v1/jobs', '{ sourceDir?|gitUrl?, image?, command?, env?, timeout? }'],
    ['GET', '/v1/jobs/:id', 'one job'],
    ['GET', '/v1/jobs/:id/logs?tail=100', 'job logs'],
    ['POST', '/v1/jobs/:id/cancel', 'cancel a running job'],
    ['DELETE', '/v1/jobs/:id', 'remove job'],
    ['GET', '/v1/health', 'daemon status'],
  ]
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>slab api — ${path}</title>
<script>
  document.documentElement.dataset.theme =
    localStorage.getItem('slab-theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
</script>
<style>
  :root { --bg: #131418; --text: #ece9e2; --dim: #9a9da5; --faint: #5f626a; --well: #0b0c0e;
    --edge: #2c2f36; --line: #1c1e24; --accent: #ffb454; --blue: #82b8e8; }
  :root[data-theme="light"] { --bg: #e9e6df; --text: #26272d; --dim: #55575e; --faint: #8b8d93; --well: #f4f2ec;
    --edge: #bfbcb4; --line: #d9d6cf; --accent: #c8791b; --blue: #2f6ea8; }
  body { font: 13px/1.6 ui-monospace, Menlo, monospace; background: var(--bg); color: var(--text); padding: 40px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 13px; color: var(--accent); letter-spacing: .1em; margin-bottom: 4px; }
  .note { color: var(--faint); font-size: 11px; margin-bottom: 22px; }
  pre { background: var(--well); border: 1px solid var(--edge); border-radius: 8px; padding: 16px; overflow: auto; font-size: 12px; margin-bottom: 26px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td { padding: 5px 14px 5px 0; border-bottom: 1px solid var(--line); color: var(--dim); }
  td:first-child { color: var(--blue); width: 60px; }
  td:nth-child(2) { color: var(--text); }
  a { color: var(--blue); }
</style></head><body>
<h1>slab api — ${path}</h1>
<div class="note">You're seeing HTML because your client sent <b>Accept: text/html</b>. Agents and curl get raw JSON from the same URL. Dashboard: <a href="/">/</a></div>
<pre>${JSON.stringify(data, null, 2).replace(/</g, '&lt;')}</pre>
<table>${routes.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table>
</body></html>`
}
