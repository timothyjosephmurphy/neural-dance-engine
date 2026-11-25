// WebKit soak ≥180 s with 25 s music / 15 s silence cycles, plus the
// real-device paths a stage-canvas-only music soak missed: poisoned
// --background (iPhone getComputedStyle), leftover Align/scan overlays,
// an aborted sticker scan, and the ripple overlay composite (screen blend)
// that can look like a solid salmon floor while dancers still show through.
import {webkit} from 'playwright';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {extname, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const SECONDS = Number(process.env.SOAK_SEC || 180);
const OUT = process.env.SOAK_OUT || '/tmp/nd-stage-bg-webkit-soak.json';
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

  window.__ndMusic = true;
  const AC = window.AudioContext || window.webkitAudioContext;
  let audioCtx, dest, osc, gain;
  const ensureAudio = () => {
    if (audioCtx || !AC) return;
    audioCtx = new AC();
    dest = audioCtx.createMediaStreamDestination();
    osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 110;
    gain = audioCtx.createGain();
    gain.gain.value = 0.4;
    osc.connect(gain).connect(dest);
    osc.start();
  };
  window.__ndSetMusic = (on) => {
    window.__ndMusic = !!on;
    if (gain) gain.gain.value = on ? 0.4 : 0;
  };
  const origGum = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function(c) {
    const wantAudio = !c || c.audio || (c && !c.video);
    if (wantAudio) {
      ensureAudio();
      if (audioCtx && audioCtx.resume) await audioCtx.resume();
      if (dest && dest.stream) return dest.stream;
    }
    if (origGum) return origGum.apply(this, arguments);
    throw new DOMException('requested device not found', 'NotFoundError');
  };
  const origFreq = AnalyserNode.prototype.getByteFrequencyData;
  AnalyserNode.prototype.getByteFrequencyData = function(arr) {
    if (!window.__ndMusic) { arr.fill(0); return; }
    if (typeof origFreq === 'function') origFreq.call(this, arr);
    for (let i = 0; i < arr.length; i++) {
      const band = i / Math.max(1, arr.length);
      const base = band < 0.08 ? 220 : band < 0.25 ? 200 : band < 0.5 ? 170 : 140;
      arr[i] = Math.max(arr[i] || 0, base);
    }
  };
});
await page.goto(origin+'/neural-dance/live/',{waitUntil:'domcontentloaded',timeout:30000});
await page.waitForFunction(()=>document.getElementById('nd-room-lab')?.dataset.roomReady==='1',null,{timeout:30000});
const navigations = [page.url()];
page.on('framenavigated', f=>{ if(f===page.mainFrame()) navigations.push(f.url()); });
const boot = await page.evaluate(async ()=>{
  const nd=document.getElementById('nd-room-lab').neuralDance;
  nd.setLightMode('silhouette');
  nd.setRipple({enabled:true,intensity:0.6});
  nd.seedSim();
  nd.applyShowCommand({action:'start'});
  try { nd.applyShowCommand({action:'listen', gesture:true}); } catch {}
  let mic = nd.micState && nd.micState();
  if (mic !== 'listening') {
    try { await nd.resumeMic(false); } catch {}
    mic = nd.micState && nd.micState();
  }
  return {ready:true, count: nd.debugRoom().simCount, mic, ripple: nd.debugRoom().ripple};
});

const classify = null; // in-page
const t0 = Date.now();
const probes = {};

// Give Listen a moment, then start the long loop plus mid-soak device paths.
await page.waitForTimeout(800);

async function runProbe(name, fn) {
  const rec = await page.evaluate(fn);
  probes[name] = rec;
  return rec;
}

// Poisoned CSS background (iPhone getComputedStyle / inherited viz color).
await runProbe('poisonBackground', () => {
  const root = document.getElementById('nd-room-lab');
  const nd = root.neuralDance;
  document.body.style.setProperty('--background', '#FF9A85');
  document.body.style.background = '#FF9A85';
  root.style.setProperty('--background', '#ff927d');
  if (nd.retint) nd.retint();
  nd.redraw();
  const canvas = root.querySelector('[data-stage]');
  const ctx = canvas.getContext('2d');
  const samples = [];
  for (const [xf, yf] of [[0.12,0.12],[0.5,0.12],[0.88,0.12],[0.12,0.5],[0.88,0.5]]) {
    const p = ctx.getImageData(Math.round(xf*canvas.width), Math.round(yf*canvas.height), 1, 1).data;
    samples.push([p[0],p[1],p[2]]);
  }
  const locked = getComputedStyle(root).getPropertyValue('--background').trim();
  const bad = samples.filter(([r,g,b]) => r > 140 && r >= g && r > b + 20 && g > 40);
  return {locked, samples, salmonPixels: bad.length, ok: bad.length === 0};
});

// Leftover Align flash / pattern with no active Align — draw() must hide them.
await runProbe('strayOverlay', () => {
  const root = document.getElementById('nd-room-lab');
  const flash = document.querySelector('[data-align-flash]');
  const pattern = document.querySelector('[data-cal-pattern]');
  if (flash) { flash.hidden = false; flash.style.opacity = '1'; flash.dataset.mode = 'white'; }
  if (pattern) pattern.hidden = false;
  root.neuralDance.redraw();
  const flashHidden = !flash || flash.hidden || flash.getAttribute('hidden') != null && getComputedStyle(flash).display === 'none';
  const patHidden = !pattern || pattern.hidden || getComputedStyle(pattern).display === 'none';
  return {flashHidden, patHidden, ok: flashHidden && patHidden};
});

const result = await page.evaluate(async (SECONDS)=>{
  const nd=document.getElementById('nd-room-lab').neuralDance;
  const root=document.getElementById('nd-room-lab');
  const canvas=root.querySelector('[data-stage]');
  const ctx=canvas && canvas.getContext('2d');
  const calPat=document.querySelector('[data-cal-pattern]');
  const alignFlash=document.querySelector('[data-align-flash]');
  let frames=0, err=null, musicFrames=0, silenceFrames=0, sampleN=0;
  const bgStuck=[], layerHits={}, compositeHits={};
  let stuckRun=0, maxStuck=0;
  const start=performance.now();
  const isMusic = (t) => (t % 40) < 25;
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
  const screenBlend = (sr,sg,sb,rr,rg,rb,ra) => {
    const a = ra / 255;
    // CSS mix-blend-mode:screen over the floor, then over-opaque by alpha.
    const r = sr * (1 - a) + (255 - ((255-sr)*(255-rr))/255) * a;
    const g = sg * (1 - a) + (255 - ((255-sg)*(255-rg))/255) * a;
    const b = sb * (1 - a) + (255 - ((255-sb)*(255-rb))/255) * a;
    return [r,g,b];
  };
  const sample = (t, music) => {
    if (!ctx || !canvas) return null;
    const w = canvas.width, h = canvas.height;
    const ripple = document.querySelector('[data-ripple-layer]');
    const rctx = ripple && ripple.getContext && ripple.getContext('2d');
    const xs = [0.12, 0.35, 0.5, 0.65, 0.88];
    const ys = [0.12, 0.35, 0.5, 0.65, 0.88];
    const kinds={}, ckinds={};
    let rS=0,gS=0,bS=0,cS=0,n=0,cn=0;
    for (const xf of xs) for (const yf of ys) {
      const x = Math.round(xf * w), y = Math.round(yf * h);
      let pix;
      try { pix = ctx.getImageData(x, y, 1, 1).data; } catch { return null; }
      rS += pix[0]; gS += pix[1]; bS += pix[2]; n++;
      const k = classify(pix[0], pix[1], pix[2]);
      kinds[k] = (kinds[k] || 0) + 1;
      if (rctx) {
        let rp;
        try { rp = rctx.getImageData(x, y, 1, 1).data; } catch { rp = [0,0,0,0]; }
        const [cr,cg,cb] = screenBlend(pix[0],pix[1],pix[2],rp[0],rp[1],rp[2],rp[3]);
        const ck = classify(cr,cg,cb);
        ckinds[ck] = (ckinds[ck] || 0) + 1;
        cS++;
      }
    }
    const r = rS / n, g = gS / n, b = bS / n;
    const meanKind = classify(r, g, b);
    const ds = root.dataset || {};
    const body = document.body && document.body.classList;
    const flags = {
      stagePattern: ds.stagePattern === '1',
      ndAlignOwn: ds.ndAlignOwn === '1',
      ndAlignFlash: ds.ndAlignFlash || '',
      ndScanUntil: +(ds.ndScanUntil || 0) > performance.now(),
      aligning: !!(body && (body.contains('nd-live-aligning') || body.contains('nd-live-pattern'))),
      calPatternVisible: !!(calPat && !calPat.hidden && getComputedStyle(calPat).display !== 'none'),
      alignFlashVisible: !!(alignFlash && !alignFlash.hidden && getComputedStyle(alignFlash).display !== 'none')
    };
    const requested = flags.stagePattern || flags.ndAlignOwn || flags.aligning || flags.ndScanUntil || !!flags.ndAlignFlash;
    const overlayStuck = (flags.calPatternVisible || flags.alignFlashVisible) && !requested;
    const stageCalib = overlayStuck || meanKind === 'salmon-pink' || meanKind === 'white' || meanKind === 'gray' || (kinds['salmon-pink'] || 0) >= 8;
    const compCalib = (ckinds['salmon-pink'] || 0) >= 8 || (ckinds['white'] || 0) >= 8;
    const rec = {t, music, mean:[Math.round(r),Math.round(g),Math.round(b)], meanKind, stageCalib, compCalib, requested, overlayStuck};
    const bad = (stageCalib || compCalib) && !requested;
    if (bad) { stuckRun++; if (stuckRun > maxStuck) maxStuck = stuckRun; if (stuckRun === 15) bgStuck.push({...rec, run: stuckRun}); }
    else { if (stuckRun >= 15) bgStuck.push({t, ended: rec.meanKind, run: stuckRun}); stuckRun = 0; }
    return rec;
  };

  // Mid-loop: abort a sticker scan (throwing camera) and confirm the white clears.
  let scanAbort = null;
  const maybeAbortScan = async (t) => {
    if (scanAbort || t < 55 || t > 70) return;
    scanAbort = {started: t};
    const {scanStickersNow} = await import('/neural-dance/live-show.js');
    const camRoot = document.getElementById('nd-camera-mode');
    const prev = camRoot.neuralDanceCamera;
    camRoot.neuralDanceCamera = {
      grabFrame: () => ({data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2}),
      scanWhiteFrame: () => { throw new Error('soak scan boom'); },
      ensureCamera: async () => {},
      setStickerFlashReport() {},
      personInView: () => false
    };
    try { await scanStickersNow(document).catch(() => {}); }
    finally { camRoot.neuralDanceCamera = prev; }
    const flash = document.querySelector('[data-align-flash]');
    const ds = root.dataset || {};
    scanAbort = {
      started: t,
      ended: (performance.now()-start)/1000,
      flashHidden: !flash || flash.hidden,
      opacity: flash && flash.style ? flash.style.opacity : '',
      ndStickerScan: ds.ndStickerScan || '',
      ndAlignFlash: ds.ndAlignFlash || '',
      ndScanFlash: ds.ndScanFlash || ''
    };
    scanAbort.ok = scanAbort.flashHidden && !scanAbort.ndStickerScan && !scanAbort.ndAlignFlash && !scanAbort.ndScanFlash;
  };

  await new Promise((resolve)=>{
    function tick(){
      const now=performance.now();
      const t=(now-start)/1000;
      try{
        const music=isMusic(t);
        if (typeof window.__ndSetMusic === 'function') window.__ndSetMusic(music);
        if (music) musicFrames++; else silenceFrames++;
        frames++;
        if (frames % 8 === 0 || t >= SECONDS) {
          const rec = sample(t, music);
          if (rec) {
            sampleN++;
            layerHits[rec.meanKind] = (layerHits[rec.meanKind] || 0) + 1;
            if (rec.compCalib) compositeHits.salmon = (compositeHits.salmon || 0) + 1;
          }
        }
        if (t >= 55 && t < 71 && !scanAbort) {
          maybeAbortScan(t).then(() => { if (t>=SECONDS) resolve(); }).catch(e => { err=String(e&&e.message||e); resolve(); });
        }
        if(t>=SECONDS) return resolve();
        requestAnimationFrame(tick);
      }catch(e){ err=String(e&&e.message||e); resolve(); }
    }
    requestAnimationFrame(tick);
  });
  if (stuckRun >= 15) bgStuck.push({t:(performance.now()-start)/1000, run: stuckRun, open:true});
  const room=nd.debugRoom();
  const save = ctx ? {save: ctx.__ndSave||0, restore: ctx.__ndRestore||0, maxDepth: ctx.__ndMaxDepth||0, depth: ctx.__ndDepth||0} : null;
  const ds = root.dataset || {};
  return {
    frames, err, sampleN, silenceFrames, musicFrames, elapsedMs: performance.now()-start,
    room, canvasSave: save, scanAbort, kinds: layerHits, compositeHits, stuck: bgStuck, maxStuckRun: maxStuck,
    flagsEnd: {stagePattern: ds.stagePattern||'', ndAlignOwn: ds.ndAlignOwn||'', ndAlignFlash: ds.ndAlignFlash||'', ndStickerScan: ds.ndStickerScan||'', calHidden: !calPat || calPat.hidden, flashHidden: !alignFlash || alignFlash.hidden}
  };
}, SECONDS);

const crashed = await page.evaluate(()=>document.readyState);
await browser.close();
server.close();
const save = result.canvasSave || {};
const saveOk = !save.save || (save.save === save.restore && (save.depth||0) === 0);
const bgOk = (result.maxStuckRun||0) < 15 && !(result.stuck||[]).length;
const probeOk = Object.values(probes).every(p => p && p.ok !== false);
const scanOk = !result.scanAbort || result.scanAbort.ok === true;
const showAsset404s=[...new Set(hits404)].filter(p=> (p==='/neural-dance'||p.startsWith('/neural-dance/')) && p!=='/neural-dance/version.json');
const elapsed = (Date.now()-t0)/1000;
const out = {
  ok: errors.length===0 && !result.err && crashed==='complete' && navigations.length<=2 && saveOk && bgOk && probeOk && scanOk && showAsset404s.length===0 && elapsed>=SECONDS && (result.sampleN||0)>0,
  seconds: SECONDS,
  elapsedMs: Date.now()-t0,
  boot,
  probes,
  result: {
    frames: result.frames, sampleN: result.sampleN, musicFrames: result.musicFrames, silenceFrames: result.silenceFrames,
    kinds: result.kinds, compositeHits: result.compositeHits, stuck: result.stuck, maxStuckRun: result.maxStuckRun,
    canvasSave: result.canvasSave, scanAbort: result.scanAbort, flagsEnd: result.flagsEnd, err: result.err,
    frameError: result.room && result.room.frameError, frameRecoveries: result.room && result.room.frameRecoveries
  },
  errors,
  consoleErrors: logs.slice(0,20),
  reloads: Math.max(0, reloads-1),
  navigations,
  showAsset404s,
  saveOk, bgOk, probeOk, scanOk
};
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ok: out.ok, samples: result.sampleN, kinds: result.kinds, maxStuckRun: result.maxStuckRun, save: result.canvasSave, scanAbort: result.scanAbort, probes: Object.fromEntries(Object.entries(probes).map(([k,v])=>[k,!!v.ok])), errors: errors.slice(0,5), elapsedMs: out.elapsedMs, boot: boot.mic}, null, 2));
if (!out.ok) process.exit(1);
