// WebKit soak ≥180 s for between-songs sticker scan: a real
// music → silence → music gap must fire Scan stickers, the white fade must
// clear afterward, and a mid-scan music onset must abort and also clear.
import {webkit} from 'playwright';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {extname, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const SECONDS = Number(process.env.SOAK_SEC || 180);
const OUT = process.env.SOAK_OUT || '/tmp/nd-pr86-webkit-soak.json';
const mime = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'};
const liveHtml = (await readFile(root + 'src/pages/neural-dance/live/index.astro','utf8')).replace(/^---[\s\S]*?---\n/,'').replace(/<BaseLayout\b[^>]*\/?>\s*/g,'');
const hits404=[];
const server = createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,'http://x');
    if(url.pathname==='/neural-dance/live/'){res.writeHead(200,{'content-type':'text/html'});return res.end(liveHtml);}
    if(url.pathname==='/fonts/fonts.css'){res.writeHead(200,{'content-type':'text/css'});return res.end('/* site typography; not a show asset */');}
    if(url.pathname==='/neural-dance/version.json'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end('{"version":"soak"}\n');}
    const file=join(root, decodeURIComponent(url.pathname));
    const body=await readFile(file);
    res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});
    res.end(body);
  } catch { hits404.push(new URL(req.url,'http://x').pathname); res.writeHead(404); res.end(); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await webkit.launch();
const context=await browser.newContext({
  viewport: {width: 390, height: 844},
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2
});
const page=await context.newPage();
const errors=[], logs=[];
let reloads=0;
page.on('pageerror', e=>errors.push(String(e)));
page.on('console', m=>{ if(m.type()==='error') logs.push(m.text()); });
page.on('load', ()=>{ reloads++; });
await page.addInitScript(() => {
  const hook = (proto) => {
    if (!proto || proto.__ndSoakSaveHook) return;
    proto.__ndSoakSaveHook = true;
    const save = proto.save, restore = proto.restore;
    proto.save = function() {
      this.__ndSave = (this.__ndSave || 0) + 1;
      this.__ndDepth = (this.__ndDepth || 0) + 1;
      this.__ndMaxDepth = Math.max(this.__ndMaxDepth || 0, this.__ndDepth);
      return save.apply(this, arguments);
    };
    proto.restore = function() {
      this.__ndRestore = (this.__ndRestore || 0) + 1;
      this.__ndDepth = Math.max(0, (this.__ndDepth || 0) - 1);
      return restore.apply(this, arguments);
    };
  };
  hook(CanvasRenderingContext2D && CanvasRenderingContext2D.prototype);
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, opts) {
    const ctx = orig.call(this, type, opts);
    if (type === '2d' && ctx) hook(Object.getPrototypeOf(ctx));
    return ctx;
  };
});
await page.goto(origin+'/neural-dance/live/',{waitUntil:'domcontentloaded',timeout:30000});
await page.waitForFunction(()=>document.getElementById('nd-room-lab')?.dataset.roomReady==='1',null,{timeout:30000});
const navigations = [page.url()];
page.on('framenavigated', f=>{ if(f===page.mainFrame()) navigations.push(f.url()); });

const boot = await page.evaluate(() => {
  const root = document.getElementById('nd-room-lab');
  const nd = root.neuralDance;
  nd.setLightMode('silhouette');
  nd.setRipple({enabled:true,intensity:0.4});
  nd.seedSim();
  nd.applyShowCommand({action:'start'});

  window.__ndMusic = true;
  window.__ndLv = [0.85, 0.7, 0.6, 0.5];
  window.__ndGate = true;
  window.__ndGapReports = [];
  window.__ndSetMusic = (on) => {
    window.__ndMusic = !!on;
    window.__ndLv = on ? [0.85, 0.7, 0.6, 0.5] : [0, 0, 0, 0];
    window.__ndGate = !!on;
  };

  const origSample = nd.audioSample && nd.audioSample.bind(nd);
  nd.audioSample = function(since) {
    return {
      t: Math.round(performance.now()),
      lv: window.__ndLv.slice(),
      gate: !!window.__ndGate,
      floor: 0.02, glv: window.__ndGate ? 0.8 : 0.05, gmus: window.__ndGate ? 0.8 : 0,
      gopen: 0.3, gclose: 0.2, idle: window.__ndMusic ? 0 : 5, hush: window.__ndMusic ? 0 : 1,
      act: origSample ? (origSample(since) || {}).act : null,
      gain: 1, seq: 0, hits: null, env: null, bpm: window.__ndMusic ? 120 : 0
    };
  };
  const origMic = nd.micState && nd.micState.bind(nd);
  nd.micState = function() { return 'listening'; };

  const camRoot = document.getElementById('nd-camera-mode') || document.body.appendChild(Object.assign(document.createElement('div'), {id:'nd-camera-mode'}));
  camRoot.neuralDanceCamera = {
    grabFrame: () => ({data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2}),
    scanWhiteFrame: () => ({ok: true, count: 3, applied: true}),
    previewWhiteFrame: () => ({ok: true, points: [{x:120,y:180,id:1},{x:400,y:200,id:2},{x:700,y:190,id:3}], reason: ''}),
    applyWhiteScan: (points) => ({ok: true, applied: true, count: (points || []).length}),
    ensureCamera: async () => {},
    setStickerFlashReport() {},
    setGapScanReport(r) { window.__ndGapReports.push({t: performance.now(), ...r}); },
    gapScanOn: () => true,
    personInView: () => false
  };
  void origMic;
  return {ready: true, count: nd.debugRoom().simCount, gapReady: document.body.dataset.gapScanReady === '1'};
});

const t0 = Date.now();
const result = await page.evaluate(async (SECONDS) => {
  const nd = document.getElementById('nd-room-lab').neuralDance;
  const root = document.getElementById('nd-room-lab');
  const canvas = root.querySelector('[data-stage]');
  const ctx = canvas && canvas.getContext('2d');
  const flash = document.querySelector('[data-align-flash]');
  const start = performance.now();
  const events = [];
  const kinds = {};
  let sampleN = 0, stuckRun = 0, maxStuck = 0, musicFrames = 0, silenceFrames = 0, err = null;
  let sawCompleteScan = false, completeCleared = false;
  let sawAbortScan = false, abortCleared = false;
  let phase = 'music1';
  let flashWasUp = false;
  let completeStartedAt = null, abortStartedAt = null;

  const overlayClear = () => {
    const ds = root.dataset || {};
    const hidden = !flash || flash.hidden || getComputedStyle(flash).display === 'none';
    const opacity = !flash || !flash.style.opacity || flash.style.opacity === '' || flash.style.opacity === '0';
    return hidden && opacity && !ds.ndStickerScan && !ds.ndAlignFlash && !ds.ndScanFlash && !(+ds.ndAlignFlashAlpha > 0);
  };
  const classify = (r, g, b) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 45 && (max - min) < 40) return 'dark';
    if (min > 210) return 'white';
    if ((max - min) < 22 && lum > 130 && lum < 210) return 'gray';
    if (r > 140 && r >= g && r > b + 20 && g > 40 && g < 0.92 * r && b < 0.85 * r) return 'salmon-pink';
    if (lum > 80 && (max - min) > 40) return 'vivid';
    return 'other';
  };
  const flashUp = () => !!(flash && !flash.hidden && getComputedStyle(flash).display !== 'none');

  // Timeline (rate limit is 60 s between starts):
  // 0-22 music, 22-40 silence (scan completes, white clears),
  // 40-85 music, 85 silence until flash comes up then abort with music,
  // then music through 140, silence 140-155, music 155-end.
  const desiredMusic = (t, flashing) => {
    if (t < 22) return true;
    if (t < 40) return false;
    if (t < 85) return true;
    if (phase === 'wait-abort-flash' || phase === 'silence2') return false;
    if (phase === 'abort-music' || phase === 'music3') return true;
    if (t < 140) return true;
    if (t < 155) return false;
    return true;
  };

  window.__ndSetMusic(true);
  await new Promise((resolve) => {
    function tick() {
      try {
        const now = performance.now();
        const t = (now - start) / 1000;
        const flashing = flashUp();
        if (flashing) flashWasUp = true;

        if (phase === 'music1' && t >= 22) {
          phase = 'silence1';
          window.__ndSetMusic(false);
          events.push({t, phase});
        } else if (phase === 'silence1') {
          if (flashing && !completeStartedAt) completeStartedAt = t;
          if (completeStartedAt && !flashing && overlayClear()) {
            sawCompleteScan = true;
            completeCleared = true;
            events.push({t, phase: 'complete-cleared'});
            if (t >= 40) { phase = 'music2'; window.__ndSetMusic(true); events.push({t, phase}); }
          } else if (t >= 40) {
            phase = 'music2';
            window.__ndSetMusic(true);
            events.push({t, phase, completeStartedAt, completeCleared});
          }
        } else if (phase === 'music2' && t >= 85) {
          phase = 'wait-abort-flash';
          window.__ndSetMusic(false);
          events.push({t, phase});
        } else if (phase === 'wait-abort-flash') {
          if (flashing) {
            abortStartedAt = t;
            phase = 'abort-music';
            window.__ndSetMusic(true);
            events.push({t, phase, abort: true});
          } else if (t >= 120) {
            phase = 'music3';
            window.__ndSetMusic(true);
            events.push({t, phase, missedAbortFlash: true});
          }
        } else if (phase === 'abort-music') {
          if (abortStartedAt && !flashing && overlayClear()) {
            sawAbortScan = true;
            abortCleared = true;
            events.push({t, phase: 'abort-cleared'});
            phase = 'music3';
          } else if (t >= 140) {
            phase = 'silence3';
            window.__ndSetMusic(false);
            events.push({t, phase, abortCleared});
          }
        } else if (phase === 'music3') {
          if (t >= 140) { phase = 'silence3'; window.__ndSetMusic(false); events.push({t, phase}); }
        } else if (phase === 'silence3') {
          if (t >= 155) { phase = 'music4'; window.__ndSetMusic(true); events.push({t, phase}); }
        }

        const music = !!window.__ndMusic;
        if (music) musicFrames++; else silenceFrames++;

        if (ctx && canvas && (sampleN === 0 || t * 3 >= sampleN || t >= SECONDS)) {
          const w = canvas.width, h = canvas.height;
          let rS=0,gS=0,bS=0,n=0;
          for (const xf of [0.12,0.5,0.88]) for (const yf of [0.12,0.5,0.88]) {
            const p = ctx.getImageData(Math.round(xf*w), Math.round(yf*h), 1, 1).data;
            rS+=p[0]; gS+=p[1]; bS+=p[2]; n++;
          }
          const kind = classify(rS/n, gS/n, bS/n);
          kinds[kind] = (kinds[kind] || 0) + 1;
          sampleN++;
          const requested = flashing || !!(root.dataset && root.dataset.ndStickerScan);
          const bad = (kind === 'salmon-pink' || (kind === 'white' && !requested) || (kind === 'gray' && !requested));
          if (bad) { stuckRun++; if (stuckRun > maxStuck) maxStuck = stuckRun; }
          else stuckRun = 0;
        }

        if (t >= SECONDS) return resolve();
        requestAnimationFrame(tick);
      } catch (e) { err = String(e && e.message || e); resolve(); }
    }
    requestAnimationFrame(tick);
  });

  const reports = (window.__ndGapReports || []).map(r => ({t: r.t && ((r.t)/1000), state: r.state, reason: r.reason, applied: r.applied, count: r.count}));
  const save = ctx ? {save: ctx.__ndSave||0, restore: ctx.__ndRestore||0, maxDepth: ctx.__ndMaxDepth||0, depth: ctx.__ndDepth||0} : null;
  const ds = root.dataset || {};
  return {
    err, sampleN, kinds, maxStuckRun: maxStuck, musicFrames, silenceFrames,
    elapsedMs: performance.now() - start,
    sawCompleteScan, completeCleared, completeStartedAt,
    sawAbortScan, abortCleared, abortStartedAt,
    overlayClearEnd: overlayClear(),
    flagsEnd: {ndStickerScan: ds.ndStickerScan||'', ndAlignFlash: ds.ndAlignFlash||'', ndScanFlash: ds.ndScanFlash||'', flashHidden: !flash || flash.hidden},
    reports, events, canvasSave: save, phase,
    room: nd.debugRoom()
  };
}, SECONDS);

const crashed = await page.evaluate(()=>document.readyState);
await browser.close();
server.close();
const save = result.canvasSave || {};
const saveOk = !save.save || (save.save === save.restore && (save.depth||0) === 0);
const gapOk = !!(result.sawCompleteScan && result.completeCleared && result.sawAbortScan && result.abortCleared && result.overlayClearEnd);
const bgOk = (result.maxStuckRun||0) < 15;
const showAsset404s=[...new Set(hits404)].filter(p=> (p==='/neural-dance'||p.startsWith('/neural-dance/')) && p!=='/neural-dance/version.json');
const elapsed = (Date.now()-t0)/1000;
const out = {
  ok: errors.length===0 && !result.err && crashed==='complete' && navigations.length<=2 && saveOk && bgOk && gapOk && showAsset404s.length===0 && elapsed>=SECONDS,
  seconds: SECONDS,
  elapsedMs: Date.now()-t0,
  boot,
  result,
  errors,
  consoleErrors: logs.slice(0,20),
  reloads: Math.max(0, reloads-1),
  navigations,
  showAsset404s,
  saveOk, bgOk, gapOk
};
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  ok: out.ok, samples: result.sampleN, kinds: result.kinds, maxStuckRun: result.maxStuckRun,
  complete: {saw: result.sawCompleteScan, cleared: result.completeCleared, at: result.completeStartedAt},
  abort: {saw: result.sawAbortScan, cleared: result.abortCleared, at: result.abortStartedAt},
  overlayClearEnd: result.overlayClearEnd, save: result.canvasSave, errors: errors.slice(0,5),
  elapsedMs: out.elapsedMs, reports: (result.reports||[]).slice(-8), events: result.events
}, null, 2));
if (!out.ok) process.exit(1);
