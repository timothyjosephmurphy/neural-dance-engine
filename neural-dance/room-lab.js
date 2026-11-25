// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Room music runtime shared by /neural-dance/ and /neural-dance/live/.
// One WASM instance, mic Listen, display AGC, and the marker hook camera mode calls.
// Slider values stay in this browser under nd-room-lab.

import {createBeatClock} from './beat-clock.js';
import {createBandOnsets, listenBandsHz, meterBandsHz, trackMicTopHz} from './src/band-onsets.js';
import {createMelodyPadAnalyzer} from './src/melody-pad.js';
import {BAND_SENS_RECOMMENDED} from './src/band-onsets.js';
import {createListenPattern, createCoupler, bandLabel, ratioText} from './src/listen-pattern.js';
import {createGlobalTempo, createBandAgreement} from './src/global-tempo.js';
import {createBreakdownDetector} from './src/breakdown-detect.js';
import {createBeatEntrain} from './src/beat-entrain.js';
import {createSongTempoLock} from './src/song-tempo-lock.js';
import {createNnListen, nnListenOn} from './nn/nn-listen.js';
import {createNnDrive} from './src/nn-drive.js';
import {createGrooveLearner} from './src/groove-learn.js';
import {createGrooveWire} from './src/groove-wire.js';
import {createSilhouetteShow, sanitizeContour} from './src/silhouette.js';
import {resetBodyDynamics, resetTravel, resetSpineFlex} from './src/skeleton-motion.js';
import {paintLatencyOverlay} from './src/latency-code.js';
import {spreadPositions, nextSeedBatch, DANCER_LIMIT} from './src/sim-layout.js';
import {linkRadiusFor,LINK_R_MIN} from './src/link-radius.js';
import {projectorFrame, stageFillStyle, STAGE_BACKGROUND, isUniformForbiddenWash} from './src/projector-hold.js';
import {createWaterRipple, crowdScaleStomps, stompRippleAmount, parseHexRgb, RIPPLE_DEFAULT_INTENSITY} from './src/water-ripple.js';
import {PERSPECTIVE_DEFAULT, clampPerspective, drawSacredFloor, floorHomography, savedPerspective, savePerspective, screenToFloorUV} from './src/perspective-floor.js';
import {dancerRippleRgb} from './src/dancer-hue.js';
import {pulseVisibility} from './src/pulse-visibility.js';
import {MIC_BLOCKED, MIC_NEEDS_GESTURE, micReadySaved, pressShowControl, writeMicReady} from './src/show-commands.js';

export const ROOM_KEY = 'nd-room-lab';
export const MARKER_ID_BASE = 100000;
export const DANCER_CAP = DANCER_LIMIT;
export const RIPPLE_MASK_FIGURES = false;

export function paintAlignmentPattern(ctx, width, height) {
  if (!ctx || !(width > 0) || !(height > 0)) return;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = Math.max(2, width / 280);
  const cells = 8;
  for (let i = 1; i < cells; i++) {
    const x = width * i / cells;
    const y = height * i / cells;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  const marks = [
    {x: 0.18, y: 0.18, fill: '#ff2a2a', label: '1 RED'},
    {x: 0.82, y: 0.18, fill: '#00e5a8', label: '2 TEAL'},
    {x: 0.82, y: 0.82, fill: '#2f6bff', label: '3 BLUE'},
    {x: 0.18, y: 0.82, fill: '#ffe14a', label: '4 YELLOW'}
  ];
  const size = Math.min(width, height) * 0.16;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 ' + Math.max(18, size * 0.22) + 'px sans-serif';
  for (const mark of marks) {
    const x = mark.x * width;
    const y = mark.y * height;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - size * 0.62, y - size * 0.62, size * 1.24, size * 1.24);
    ctx.fillStyle = mark.fill;
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.fillStyle = mark.fill === '#2f6bff' ? '#fff' : '#111';
    ctx.fillText(mark.label, x, y);
  }
  ctx.restore();
}

export function markerStickerId(id) {
  const n = Math.abs(id | 0);
  return MARKER_ID_BASE + (n > 0 ? n : 1);
}

// Simulated dancers keep their own ids. Camera markers are offset so a later
// sticker frame cannot replace a tap-added dancer, or the other way around.
// Ring radius for one engine dancer. In silhouette mode every dancer, sim or
// sticker, keeps the resting sticker size: sims wander, so their activity (and
// the old ring, up to ~90 px) was several times a sticker's (TJ, 4:02 PM).
export const DANCER_RING_REST = 8;
export function dancerRingRadius(q, boost, silhouette) {
  if (silhouette) return DANCER_RING_REST;
  return DANCER_RING_REST + 14 * (+q || 0) * (+boost || 0);
}

// Sim dancers as silhouette markers (template figure, sized like the stickers).
export function simSilhouetteMarkers(sim) {
  const out = [];
  for (const d of sim || []) {
    if (!d || !Number.isFinite(+d.x) || !Number.isFinite(+d.y)) continue;
    out.push({id: d.id | 0, x: +d.x, y: +d.y, type: ((d.type | 0) % 4 + 4) % 4, kind: 'sim'});
  }
  return out;
}

export function combineDancerStickers(sim, markers, limit = DANCER_CAP) {
  const cap = Math.max(0, limit | 0);
  const out = [];
  const seen = new Set();
  // Sims first so a sticker latch never displaces an existing sim (TJ 4:37 PM).
  for (const dancer of sim || []) {
    if (!dancer || out.length >= cap) continue;
    const id = dancer.id | 0;
    if (!(id > 0) || id >= MARKER_ID_BASE || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      x: +dancer.x || 0,
      y: +dancer.y || 0,
      type: ((dancer.type | 0) % 4 + 4) % 4,
      kind: 'sim'
    });
  }
  for (const marker of markers || []) {
    if (!marker || out.length >= cap) continue;
    const id = markerStickerId(marker.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      x: +marker.x || 0,
      y: +marker.y || 0,
      type: ((marker.type | 0) % 4 + 4) % 4,
      kind: marker.kind === 'sticker' ? 'sticker' : 'pink'
    });
  }
  return out;
}

function simEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id | 0;
  const x = +item.x;
  const y = +item.y;
  if (!(id > 0) || id >= MARKER_ID_BASE || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {id, x, y, type: ((item.type | 0) % 4 + 4) % 4};
}

export function simListFromSettings(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.sim)) return data.sim.map(simEntry).filter(Boolean).slice(0, DANCER_CAP);
  if (data.simDancers === false) return [];
  return null;
}

function memoryOf(storage) {
  try {
    return storage || (typeof localStorage === 'undefined' ? null : localStorage);
  } catch {
    return null;
  }
}

function roomNumber(value, lo, hi) {
  const n = +value;
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

// One-time show migration (Nov 9): phones that saved sim dancers before the
// default flipped off keep a stale sim list. Drop it once; later explicit
// Seed choices persist normally.
// Light mode: silhouette by default (TJ, Nov 9 3:34 PM). The phone's choice
// persists; a saved 'dot' from before the default flipped is switched once.
export const LIGHT_MODE_KEY = 'nd.lightMode.v1';
export const LIGHT_SILHOUETTE_MIGRATED_KEY = 'nd.lightSilhouetteDefault.v1';
export const LIGHT_MODE_DEFAULT = 'silhouette';
export function readLightMode(storage) {
  const box = memoryOf(storage);
  try {
    const saved = box && box.getItem(LIGHT_MODE_KEY);
    return saved === 'dot' || saved === 'silhouette' ? saved : LIGHT_MODE_DEFAULT;
  } catch {
    return LIGHT_MODE_DEFAULT;
  }
}
export function writeLightMode(storage, mode) {
  const box = memoryOf(storage);
  if (!box || (mode !== 'dot' && mode !== 'silhouette')) return false;
  try { box.setItem(LIGHT_MODE_KEY, mode); return true; } catch { return false; }
}
export function migrateLightSilhouetteDefault(storage) {
  const box = memoryOf(storage);
  if (!box) return false;
  try {
    if (box.getItem(LIGHT_SILHOUETTE_MIGRATED_KEY) === '1') return false;
    if (box.getItem(LIGHT_MODE_KEY) === 'dot') box.setItem(LIGHT_MODE_KEY, 'silhouette');
    box.setItem(LIGHT_SILHOUETTE_MIGRATED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export const SIM_DEFAULT_OFF_KEY = 'nd.simDefaultOff.v1';

export const RIPPLE_PREF_KEY = 'nd.ripple.v1';
// Legacy builds auto-wrote 0.85 here on first load and then ignored it, so a
// saved 0.85 without user:true is the old default, not a choice.
export const RIPPLE_LEGACY_AUTO = 0.85;
export function migrateRippleDefaultOn(storage) {
  const box = memoryOf(storage);
  if (!box) return true;
  try {
    const raw = box.getItem(RIPPLE_PREF_KEY);
    if (raw == null) {
      box.setItem(RIPPLE_PREF_KEY, JSON.stringify({enabled: true, intensity: RIPPLE_DEFAULT_INTENSITY}));
      return true;
    }
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enabled === false) return false;
    return true;
  } catch {
    return true;
  }
}

// Saved ripple intensity (TJ 11:31 AM: saved values win over the new 0.20
// default). Returns {intensity, user} or null when nothing was chosen.
export function savedRippleIntensity(storage) {
  const box = memoryOf(storage);
  if (!box) return null;
  try {
    const data = JSON.parse(box.getItem(RIPPLE_PREF_KEY) || 'null');
    if (!data || !Number.isFinite(+data.intensity)) return null;
    const v = Math.max(0, Math.min(1, +data.intensity));
    if (data.user === true) return {intensity: v, user: true};
    // Legacy record: any value other than the old auto-written 0.85 was set
    // on purpose (debug slider / command), so keep it.
    if (Math.abs(v - RIPPLE_LEGACY_AUTO) > 1e-6 && Math.abs(v - RIPPLE_DEFAULT_INTENSITY) > 1e-6) return {intensity: v, user: true};
    return null;
  } catch { return null; }
}
// Hue spread is saved only when someone moves the slider (live or debug).
export const HUE_SPREAD_PREF_KEY = 'nd.hueSpread.v1';
export function savedHueSpread(storage) {
  const box = memoryOf(storage);
  if (!box) return null;
  try {
    const raw = box.getItem(HUE_SPREAD_PREF_KEY);
    if (raw == null || raw === '') return null;
    const v = +raw;
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
  } catch { return null; }
}
export function saveHueSpread(storage, value) {
  const box = memoryOf(storage);
  if (!box || !Number.isFinite(+value)) return false;
  try { box.setItem(HUE_SPREAD_PREF_KEY, String(Math.max(0, Math.min(1, +value)))); return true; } catch { return false; }
}

// One-time band sens reset (TJ 8:12 PM): saved sliders were tuned for the old
// fixed-floor detector, so the first load of the level-adaptive build drops
// them and the recommended defaults apply. Key bump = run once per device.
export const BAND_SENS_DEFAULTS_KEY = 'nd.bandSensDefaults.v2';
// Peak hold default moved 2.8 s -> 5 s (TJ Nov 11). A phone that still has the
// old default saved gets the new one once; a deliberately different value stays.
export const PEAK_HOLD_DEFAULT = 5;
const PEAK_HOLD_DEFAULTS_KEY = 'nd.peakHold.v5';
export function migratePeakHoldDefault(storage) {
  const box = memoryOf(storage);
  if (!box) return false;
  try {
    if (box.getItem(PEAK_HOLD_DEFAULTS_KEY) === '1') return false;
    const raw = box.getItem(ROOM_KEY);
    let changed = false;
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && (data.peak == null || Math.abs(+data.peak - 2.8) < 1e-6)) {
        data.peak = PEAK_HOLD_DEFAULT;
        box.setItem(ROOM_KEY, JSON.stringify(data));
        changed = true;
      }
    }
    box.setItem(PEAK_HOLD_DEFAULTS_KEY, '1');
    return changed;
  } catch {
    return false;
  }
}

export function migrateBandSensDefaults(storage) {
  const box = memoryOf(storage);
  if (!box) return false;
  try {
    if (box.getItem(BAND_SENS_DEFAULTS_KEY) === '1') return false;
    const raw = box.getItem(ROOM_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        data.sens = BAND_SENS_RECOMMENDED.slice();
        box.setItem(ROOM_KEY, JSON.stringify(data));
      }
    }
    box.setItem(BAND_SENS_DEFAULTS_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function migrateSimDefaultOff(storage) {
  const box = memoryOf(storage);
  if (!box) return false;
  try {
    if (box.getItem(SIM_DEFAULT_OFF_KEY) === '1') return false;
    const raw = box.getItem(ROOM_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        data.sim = [];
        data.simDancers = false;
        box.setItem(ROOM_KEY, JSON.stringify(data));
      }
    }
    box.setItem(SIM_DEFAULT_OFF_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function readRoomSettings(storage) {
  const box = memoryOf(storage);
  if (!box) return null;
  let data;
  try {
    const raw = box.getItem(ROOM_KEY);
    if (!raw) return null;
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const sens = [0, 1, 2, 3].map(i => {
    const n = Array.isArray(data.sens) ? roomNumber(data.sens[i], 0, 3) : null;
    return n == null ? 1 : n;
  });
  return {
    gravity: roomNumber(data.gravity, 0, 6),
    wander: roomNumber(data.wander, 0, 0.8),
    threshold: roomNumber(data.threshold, 1, 1.9),
    peak: roomNumber(data.peak, 1, 8),
    type: roomNumber(data.type, 0, 3),
    quiet: roomNumber(data.quiet, 0, 0.4),
    sens,
    sim: simListFromSettings(data),
    simDancers: Array.isArray(data.sim) ? data.sim.length > 0 : data.simDancers === true
  };
}

// "25 dancers (24 sim, 1 sticker)" — sim is the stage minus live camera tracks.
// Stickers stay singular only at 1. Pink notes and dancer silhouettes both count.
// Pulse trails from the WASM pulse view (per pulse: k at +2, head at +5/+6,
// trail length at +7, trail points from +8). Returns the segments stroked.
// TJ 8:45 PM: once released, a pulse is a free particle in stage space. The
// trail is its actual past positions and is not remapped when dancers move.
// Homing toward the target's current head is done in the engine (nd_heads).
// On contact the front is clipped to that head and the tail collapses into it.
// Pinpoint traveling pulses (TJ 8:31 PM): a 2–3 stage-px core, a faint
// small halo, and a short thin trail that stays readable on the projector.
export const PULSE_CORE_R = 1.4;
export const PULSE_HALO_R = 4.2;
export const PULSE_IMPACT_R = 6.5;
export const PULSE_TRAIL_W = 1.15;
export const PULSE_TRAIL_GLOW_W = 3.1;
export const PULSE_TRAIL_SPAN = 32;
export const PULSE_TRAIL_MAX = 10;

export function pulseAnchor(anchor,ai,bi,xy){
  const A=anchor.pos(ai),B=anchor.pos(bi),oa=anchor.off(ai)||{dx:0,dy:0},ob=anchor.off(bi)||{dx:0,dy:0};
  if(!A||!B)return xy;
  const vx=B.x-A.x,vy=B.y-A.y,L2=vx*vx+vy*vy||1;
  const Ah={x:A.x+oa.dx,y:A.y+oa.dy},Bh={x:B.x+ob.dx,y:B.y+ob.dy};
  const wx=Bh.x-Ah.x,wy=Bh.y-Ah.y,w2=wx*wx+wy*wy||1;
  return (x,y)=>{
    const u=Math.max(0,Math.min(1,((x-A.x)*vx+(y-A.y)*vy)/L2));
    const px=x+oa.dx+(ob.dx-oa.dx)*u,py=y+oa.dy+(ob.dy-oa.dy)*u;
    // Offset blend uses u in [0,1], but a stale or gravity-bent point can still
    // sit past the live target head. Clip so nothing is drawn beyond it.
    const s=((px-Ah.x)*wx+(py-Ah.y)*wy)/w2;
    if(s>1)return xy(Bh.x,Bh.y);
    return xy(px,py);
  };
}
export function pulseTargetHead(anchor,bi,xy){
  if(!anchor||typeof anchor.pos!=='function')return null;
  const B=anchor.pos(bi);if(!B)return null;
  const ob=(anchor.off&&anchor.off(bi))||{dx:0,dy:0};
  return xy(B.x+ob.dx,B.y+ob.dy);
}

// Feed each dancer's current head (stage px) to the pulse engine so particles
// home toward the live head instead of the hip. Falls back to the hip when a
// figure has not been painted yet.
export function writePulseHeadAims(api, floats, figureHeights, markerId){
  if(!api||typeof api.nd_heads!=='function'||typeof api.nd_set_heads!=='function')return 0;
  const n=api.nd_count()|0;
  if(n<=0)return 0;
  const f=floats||(api.memory?new Float32Array(api.memory.buffer):null);
  if(!f)return 0;
  const base=api.nd_dancers()>>>2, ds=api.nd_dancer_stride(), heads=api.nd_heads()>>>2;
  const byId=new Map();
  const idOf=typeof markerId==='function'?markerId:null;
  for(const g of figureHeights||[]){
    if(!g||!g.head||!Number.isFinite(+g.head.x)||!Number.isFinite(+g.head.y))continue;
    let id;
    if(idOf)id=idOf(g);
    else id=g.kind==='sim'?(g.id|0):null;
    if(id==null||!Number.isFinite(+id))continue;
    byId.set(id|0,g.head);
  }
  for(let i=0;i<n;i++){
    const hipx=f[base+i*ds], hipy=f[base+i*ds+1], id=f[base+i*ds+5]|0;
    const h=byId.get(id);
    f[heads+i*2]=h?+h.x:hipx;
    f[heads+i*2+1]=h?+h.y:hipy;
  }
  return api.nd_set_heads(n);
}
function stageScale(xy){
  if(typeof xy!=='function')return 1;
  const a=xy(0,0),b=xy(1,0);
  const s=Math.hypot((b.x-a.x),(b.y-a.y));
  return s>0&&Number.isFinite(s)?s:1;
}
function shortenTrail(pts,maxLen){
  if(!pts||pts.length<2||!(maxLen>0))return pts&&pts.length? [pts[pts.length-1]] : [];
  const last=pts[pts.length-1];
  const out=[last];
  let acc=0;
  for(let i=pts.length-2;i>=0;i--){
    const d=Math.hypot(pts[i].x-pts[i+1].x,pts[i].y-pts[i+1].y);
    if(!(d>0))continue;
    if(acc+d>=maxLen){
      const u=(maxLen-acc)/d;
      out.unshift({x:pts[i+1].x+(pts[i].x-pts[i+1].x)*u,y:pts[i+1].y+(pts[i].y-pts[i+1].y)*u});
      break;
    }
    acc+=d;
    out.unshift(pts[i]);
  }
  return out;
}
// Head anchors for pulse trails from the last painted figures (stage px).
export function headAnchor(f,base,ds,n,figs){
  const heads=new Map();
  for(const g of figs||[]){if(g&&g.head&&Number.isFinite(+g.x)&&Number.isFinite(+g.y)){const id=g.kind==='sim'?(g.id|0):markerStickerId(g.id);heads.set(id,{dx:g.head.x-g.x,dy:g.head.y-g.y});}}
  const pos=i=>i>=0&&i<n?{x:f[base+i*ds],y:f[base+i*ds+1]}:null;
  const off=i=>i>=0&&i<n?heads.get(f[base+i*ds+5]|0)||null:null;
  return {pos,off};
}
// Silhouette-mode pulse trails follow the bloom slider (TJ 11:22 AM): at 0
// a crisp thin trail and a small head, no glow pass or halo disc.
export function pulseFineStyle(tune){
  const t=tune||{};const on=t.bloomEnabled!==false;const b=on?Math.max(0,+t.bloomIntensity||0):0;
  const g=Math.min(1.5,b/0.18);
  return {coreR:1.1,haloR:g>0?1.1+1.6*g:0,impactR:g>0?1.1+2.6*g:0,trailW:0.9,glowW:g>0?0.9*(1+1.2*g):0,span:PULSE_TRAIL_SPAN};
}
export function paintPulseTrails(ctx,f,pb,pc,ps,xy,colors,low,anchor,style){
  let segs=0;
  const scale=stageScale(xy);
  const coreR=(style&&Number.isFinite(+style.coreR)?+style.coreR:PULSE_CORE_R)*scale;
  const haloR=(style&&Number.isFinite(+style.haloR)?+style.haloR:PULSE_HALO_R)*scale;
  const impactR=(style&&Number.isFinite(+style.impactR)?+style.impactR:PULSE_IMPACT_R)*scale;
  const trailW=(style&&Number.isFinite(+style.trailW)?+style.trailW:PULSE_TRAIL_W)*scale;
  const glowW=(style&&Number.isFinite(+style.glowW)?+style.glowW:PULSE_TRAIL_GLOW_W)*scale;
  const span=(style&&Number.isFinite(+style.span)?+style.span:PULSE_TRAIL_SPAN)*scale;
  ctx.save();ctx.globalCompositeOperation='lighter';
  for(let i=0;i<pc;i++){
    const o=pb+i*ps,k=f[o+2]|0,ai=f[o]|0,bi=f[o+1]|0,age=+f[o+3]||0,dur=+f[o+4]||0,trail=f[o+7]|0;
    const t=dur>0?Math.max(0,Math.min(1,age/dur)):1;
    const arrived=t>=1;
    const target=anchor?pulseTargetHead(anchor,bi,xy):null;
    const raw=[];
    for(let j=0;j<trail;j++) raw.push(xy(f[o+8+j*2],f[o+9+j*2]));
    let head=xy(f[o+5],f[o+6]);
    // Clip only the front onto the live target head on contact. Earlier
    // trail points stay at their world positions so the tail can curve.
    if(arrived&&target) head=target;
    if(raw.length) raw[raw.length-1]=head;
    else raw.push(head);
    const vis=pulseVisibility(colors[k]);
    const cR=coreR*vis.coreScale,tW=trailW*vis.trailScale,gW=glowW>0?glowW*vis.trailScale:0,sp=span*vis.spanScale;
    const pts=shortenTrail(raw,arrived?sp*Math.max(0,(trail-1)/Math.max(1,PULSE_TRAIL_MAX-1)):sp);
    ctx.strokeStyle=vis.css;
    ctx.lineCap='round';
    ctx.lineJoin='round';
    for(let j=1;j<pts.length;j++){
      const a=pts[j-1],b=pts[j];
      const fade=j/pts.length;
      if(!low&&gW>0){ctx.globalAlpha=Math.min(1,.14*fade*vis.alphaScale);ctx.lineWidth=gW;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
      ctx.globalAlpha=Math.min(1,(.45+.35*fade)*vis.alphaScale);segs++;ctx.lineWidth=tW;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    }
    ctx.fillStyle=vis.css;
    const hr=(arrived?impactR:haloR)*(glowW>0||impactR>0&&arrived?vis.coreScale:1);
    if(hr>cR){ctx.globalAlpha=Math.min(1,(arrived?.4:.28)*vis.alphaScale);ctx.beginPath();ctx.arc(head.x,head.y,hr,0,Math.PI*2);ctx.fill();}
    ctx.globalAlpha=1;
    ctx.beginPath();ctx.arc(head.x,head.y,cR,0,Math.PI*2);ctx.fill();
  }
  ctx.restore();return segs;
}
export function formatDancerCount(total, markerCount) {
  const dancers = Math.max(0, Math.round(+total) || 0);
  const stickers = Math.max(0, Math.round(+markerCount) || 0);
  const sim = Math.max(0, dancers - stickers);
  const stickerLabel = stickers + ' ' + (stickers === 1 ? 'sticker' : 'stickers');
  return dancers + ' dancers (' + sim + ' sim, ' + stickerLabel + ')';
}

// Visible floor dot for a latched sticker or Post-it. Gold and cool white stay
// off the pink detector, and the center is filled so the mark reads on a dark floor.
export function paintStageMarkers(ctx, markers, xy, size) {
  if (!ctx || !markers || !markers.length || typeof xy !== 'function') return;
  const scale = Number.isFinite(+size) && +size > 0 ? +size : 1;
  const s = scale;
  for (const m of markers) {
    if (!m || !Number.isFinite(+m.x) || !Number.isFinite(+m.y)) continue;
    const p = xy(+m.x, +m.y);
    const sticker = m.kind === 'sticker';
    const halo = ctx.createRadialGradient(p.x, p.y, 2 * s, p.x, p.y, 36 * s);
    halo.addColorStop(0, sticker ? 'rgba(255,214,140,.42)' : 'rgba(244,251,255,.5)');
    halo.addColorStop(.55, sticker ? 'rgba(255,196,110,.5)' : 'rgba(186,230,255,.42)');
    halo.addColorStop(1, 'rgba(255,196,140,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 36 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = sticker ? '#ffe7b0' : '#f4fbff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12*scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = sticker ? 'rgba(255,196,110,.95)' : 'rgba(186,230,255,.95)';
    ctx.lineWidth = Math.max(2, 2.5 * s);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 18 * s, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function writeRoomSettings(storage, settings) {
  const box = memoryOf(storage);
  if (!box || !settings) return false;
  try {
    box.setItem(ROOM_KEY, JSON.stringify({
      v: 1,
      gravity: settings.gravity,
      wander: settings.wander,
      threshold: settings.threshold,
      peak: settings.peak,
      type: settings.type,
      quiet: settings.quiet,
      sens: settings.sens,
      sim: Array.isArray(settings.sim) ? settings.sim.slice(0, DANCER_CAP) : undefined,
      simDancers: Array.isArray(settings.sim) ? settings.sim.length > 0 : settings.simDancers === true
    }));
    return true;
  } catch {
    return false;
  }
}

// Room-music lab: its own WASM instance on the original prototype stage
// (dark canvas, sacred-geometry field, colored dancers and links).
// nd_set_clock(0) stays off, so the built-in beat never runs. Dancers move
// only from live microphone bands. No synth is connected to the speakers.
// The silence gate measures a noise floor for Listen and for this stage.
// Near that floor the auto-gain is capped and the spectrum is withheld, so
// silence and background noise are not boosted into dancer motion. Above the
// quiet threshold the live bytes reach the onset detector unchanged.
// While Listening, a ring around each dancer draws that band's waveform.
let root, canvas, ctx, spectrum, sctx, el, play, listenButton, alignButton, status, micStatus, W, H, R, linkR, positions, legacyPositions, sim, nextSimId, api, running, low, allowMap, mapper, timer, raf, last, started, slow, lastReport, ac, colors, foreground, background, rings, silhouetteShow, waterRipple, rippleEnabled, floorWarp, rippleCanvas, rippleUserSet, beatClock, beatReadout, micState, micPending, micStream, micSource, analyser, spec, pointer, lastLevels, driveOpen, bandSens, bandOnsets, melodyPad, lastPadFeatures, globalTempo, gtState, nnDrive, nnGrid, songTempo, breakdownDet, breakdownOut, sectionLog, entrain, entrainOut, bandCoupler, bandAgree, coupled, coupledLocked, grooveWire, envFeedUntil, envRing, listenPattern, patternState, nnListen, bandBeatCount, bandHitLog, bandHitSeq, micTopHz, HUSH_AFTER_MS, silentSince, lastOnsetAt, hotUntil, MIC, gate, AUDIO_RESUME_MS, frameRecoveries, lastFrameError, MIC_RECOVER_MAX, micRecoverTries, micRecoverTimer, micRecoveries, frameErrors, typeInput;
function legacyPrototypePositions(){
  let seed=0x5eed;
  const rand=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
  const CX=500,CY=310,SX=1.18,SY=.72,out=[];
  for(let i=0;i<24;i++){const a=rand()*Math.PI*2,r=50+rand()*260;out.push([CX+Math.cos(a)*r*SX*.94,CY+Math.sin(a)*r*SY*.94,i%4]);}
  return out;
}
function prototypePositions(){return spreadPositions();}
function isLegacySeed(list){return Array.isArray(list)&&list.length===legacyPositions.length&&list.every((d,i)=>d&&Math.abs(+d.x-legacyPositions[i][0])<0.5&&Math.abs(+d.y-legacyPositions[i][1])<0.5);}
function applyFloorPerspective(value,how){
  const v=clampPerspective(value);
  floorWarp=floorHomography(v);
  try{if(waterRipple.setWarp)waterRipple.setWarp(floorWarp);}catch{}
  if(!(how&&how.boot)){try{savePerspective(memoryOf(null),v);}catch{}}
  const input=el('[data-control="floor-perspective"]');
  if(input&&+input.value!==v)input.value=String(v);
  const out=el('[data-value="floor-perspective"]');
  if(out)out.textContent=v.toFixed(2);
  return v;
}
function ensureRippleCanvas(){
  if(rippleCanvas&&rippleCanvas.isConnected)return rippleCanvas;
  const host=document.getElementById('nd-room-projector');
  if(!host)return null;
  let node=host.querySelector('[data-ripple-layer]');
  if(!node){
    node=document.createElement('canvas');
    node.setAttribute('data-ripple-layer','');
    node.width=1000;node.height=620;
    node.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;mix-blend-mode:screen';
    host.appendChild(node);
  }
  rippleCanvas=node;
  return node;
}
function applyRippleSettings(opts,how){
  const o=opts||{};
  if(!(how&&how.boot)&&Number.isFinite(+o.intensity))rippleUserSet=true;
  if(o.enabled===true||o.enabled===false){rippleEnabled=o.enabled;waterRipple.setEnabled(rippleEnabled);}
  if(Number.isFinite(+o.intensity))waterRipple.setIntensity(+o.intensity);
  if(!rippleEnabled){const c=ensureRippleCanvas();if(c){const x=c.getContext('2d');if(x)x.clearRect(0,0,c.width,c.height);}waterRipple.clear();}
  try{const box=memoryOf(null);if(box)box.setItem(RIPPLE_PREF_KEY,JSON.stringify({enabled:rippleEnabled,intensity:waterRipple.intensity(),user:rippleUserSet}));}catch{}
  return {enabled:rippleEnabled,intensity:waterRipple.intensity(),backend:waterRipple.backend,webglAvailable:!!waterRipple.webglAvailable};
}
function paintRipples(layer,dancers,env){
  const canvas=ensureRippleCanvas();
  if(!canvas)return;
  if(!rippleEnabled||layer!=='simulation'){
    const x=canvas.getContext('2d');
    if(x)x.clearRect(0,0,canvas.width,canvas.height);
    // Hide only. Transient dark/scan frames used to wipe the field, so the
    // ripples vanished and slowly rebuilt (TJ 6:09 PM). Disabled still wipes.
    if(!rippleEnabled)waterRipple.clear();
    return;
  }
  const list=dancers||[];
  const figs=silhouetteShow.figureHeights()||[];
  const crowd=crowdScaleStomps(Math.max(list.length, figs.length));
  const nowMs=typeof performance!=='undefined'?performance.now():0;
  // Hue spread slider, read every frame so ripples follow it live (TJ 11:10 AM).
  const hueSpread=(silhouetteShow.tuning()||{}).hueSpread;
  // Stomp-only (TJ 1:54 PM): one hit per foot-plant edge, at that foot,
  // sized by the stomp. No shared-envelope splash, activity trickle, or idle drip.
  // Walk figureHeights directly so a live sticker and a sim that share raw
  // id 1..n both ripple (engine/sticker ids are 100000+n; the old map keyed
  // only on raw id dropped sticker plants) (TJ Nov 10 3:04 PM).
  const hushAll=silhouetteShow.hush(nowMs);
  for(const fig of figs){
    if(!fig||!(hushAll>0))continue;
    const plants=Array.isArray(fig.plants)?fig.plants:[];
    if(!plants.length)continue;
    const figHush=Number.isFinite(+fig.hush)?Math.min(hushAll,Math.max(0,+fig.hush)):hushAll;
    if(!(figHush>0))continue;
    const id=fig.kind==='sim'?(fig.id|0):markerStickerId(fig.id);
    const band=((fig.band!=null?fig.band:(fig.type|0))%4+4)%4;
    // Distinct hue per dancer so overlaps mix into rainbows (TJ 5:16 PM).
    const rgb=id>0?dancerRippleRgb(id,band,hueSpread):parseHexRgb((colors&&colors[band])||'#5ce1e6');
    for(const p of plants){
      if(!p||!(+p.amount>0))continue;
      const px=Number.isFinite(+p.x)?+p.x:(Number.isFinite(+fig.x)?+fig.x:0);
      const py=Number.isFinite(+p.y)?+p.y:(Number.isFinite(+fig.y)?+fig.y:0);
      const uv=screenToFloorUV(px,py,floorWarp,W,H);
      // Clap rings: paler tint (mixed toward white) so they read apart from stomps.
      const c=p.kind==='clap'&&rgb?{r:rgb.r+(1-rgb.r)*0.5,g:rgb.g+(1-rgb.g)*0.5,b:rgb.b+(1-rgb.b)*0.5}:rgb;
      waterRipple.hit(uv.x,uv.y,stompRippleAmount(p.amount,crowd,figHush),c);
    }
  }
  if(canvas.width!==1000)canvas.width=1000;
  if(canvas.height!==620)canvas.height=620;
  waterRipple.step(canvas);
  // A uniform salmon/cal wash on this overlay screens over the dark floor and
  // looks like a solid pink stage, while maskFigures still punches the dancers
  // through (TJ 12:17 PM). Headless soaks that only sampled the stage canvas
  // missed it. Drop a near-solid forbidden field rather than leave it up.
  try{
    const x=canvas.getContext('2d');
    if(x){
      let probe=canvas.__ndWashProbe;
      if(!probe||!probe.canvas){
        const c=document.createElement('canvas');c.width=20;c.height=12;
        probe={canvas:c,ctx:c.getContext('2d')};canvas.__ndWashProbe=probe;
      }
      if(probe.ctx){
        probe.ctx.clearRect(0,0,20,12);
        probe.ctx.drawImage(canvas,0,0,20,12);
        if(isUniformForbiddenWash(probe.ctx.getImageData(0,0,20,12))){
          x.clearRect(0,0,canvas.width,canvas.height);
          try{waterRipple.clear();}catch{}
        }
      }
    }
  }catch{}
  // No figure cut-out of the ripple overlay any more (TJ Nov 11 3:16 PM): the
  // bodies are see-through now, and the punched-out holes read as dark
  // 'shadow' dancers on the bright ripples, offset where the overlay and the
  // stage map differ. maskFigures stays available for an opaque-body look.
  if(RIPPLE_MASK_FIGURES){try{if(silhouetteShow&&silhouetteShow.mode()==='silhouette')silhouetteShow.maskFigures(canvas.getContext('2d'),0.8);}catch{}}
}
function silhouetteBloomStyle(pulse,defaults){return {bloomStroke:false,alpha:0.06,stroke:'rgba(180,210,255,0.2)',fill:'rgba(0,0,0,0)',lineWidth:1.5,composite:'lighter',low:true};}
function listenLegacy(){try{if(/[?&]listen=legacy\b/.test(location.search))return true;return localStorage.getItem('nd.listen.legacy')==='1';}catch{return false;}}
function listenPatternOn(){try{if(/[?&]listen=(perband|per-band|legacy)\b/.test(location.search))return false;if(/[?&]listen=pattern\b/.test(location.search))return true;return localStorage.getItem('nd.listen.pattern')!=='0';}catch{return true;}}
function entrainOn(){try{if(/[?&]entrain=0\b/.test(location.search))return false;return localStorage.getItem('nd.entrain')!=='0';}catch{return true;}}
function sectionsOn(){try{if(/[?&]sections=0\b/.test(location.search))return false;return localStorage.getItem('nd.sections')!=='0';}catch{return true;}}
function grooveFlag(k){try{if(new RegExp('[?&]'+k+'=0\\b').test(location.search))return false;return localStorage.getItem('nd.'+k)!=='0';}catch{return true;}}
function grooveOff(){const w=grooveWire;grooveWire=null;if(entrain&&entrain.setDownbeat)entrain.setDownbeat(-1);if(w){try{w.reset();}catch{}}}
function tempoReset(){songTempo.reset();if(entrain)entrain.reset();entrainOut=null;if(nnDrive){try{nnDrive.reset();}catch{}}if(globalTempo)globalTempo.reset();gtState=null;bandCoupler.reset();bandAgree.reset();for(let b=0;b<4;b++){coupled.ratio[b]=0;coupled.period[b]=0;coupled.free[b]=false;coupledLocked[b]=false;}if(typeof silhouetteShow.setGlobalTempo==='function')silhouetteShow.setGlobalTempo(0);}
function nnOff(){const n=nnListen;nnListen=null;nnGrid=null;if(n){try{n.stop();}catch{}}}
function patternLabels(p){for(let b=0;b<4;b++){silhouetteShow.setBandMeter(b,p&&p.meter?p.meter:'');if(typeof silhouetteShow.setBandRatio==='function')silhouetteShow.setBandRatio(b,coupled.ratio[b]>0?ratioText(coupled.ratio[b]):'');}}
function listenPatternTiming(){const pat=listenPattern?listenPattern.snapshot():null;const gt=globalTempo?globalTempo.snapshot():null;return {tempo:gt,coupled:[0,1,2,3].map(b=>({ratio:coupled.ratio[b]>0?ratioText(coupled.ratio[b]):null,period:Math.round(coupled.period[b]),conf:Math.round(bandAgree.conf[b]*100)/100,locked:coupledLocked[b]})),pattern:pat,meter:pat?pat.meter:'',patternBpm:pat?pat.bpm:0,ratio:pat?pat.ratio:null,labels:listenPattern?[0,1,2,3].map(b=>bandLabel(listenPattern.state,b)):null,songTempo:songTempo.snapshot(),entrain:entrain?entrain.snapshot():null,section:breakdownDet?{...breakdownDet.snapshot(),out:breakdownOut?{state:breakdownOut.state,progress:breakdownOut.progress,bars:breakdownOut.bars,predictedDropAt:Math.round(breakdownOut.predictedDropAt)}:null,log:sectionLog.slice()}:null};}
function envTake(){envFeedUntil=performance.now()+1500;if(!envRing.length)return null;const out=envRing.slice();envRing.length=0;return out;}
function patternOff(){listenPattern=null;patternState=null;patternLabels(null);}
function floats(){return new Float32Array(api.memory.buffer);}
function theme(){
  const live=root.dataset.markersLive==='1';
  try{root.style.setProperty('--background',STAGE_BACKGROUND);if(document.body)document.body.style.setProperty('--background',STAGE_BACKGROUND);}catch{}
  if(live){root.style.setProperty('--viz-series-1','#ffd166');root.style.setProperty('--viz-series-2','#5ce1e6');}
  else{root.style.removeProperty('--viz-series-1');root.style.removeProperty('--viz-series-2');}
  const resolver=document.createElement('span');root.appendChild(resolver);
  function color(token){resolver.style.color='var('+token+')';return getComputedStyle(resolver).color;}
  colors=[1,2,3,4].map(i=>color('--viz-series-'+i));foreground=color('--foreground');background=stageFillStyle(color('--background'));resolver.remove();
  if(live){colors[0]='#ff6b6b';colors[1]='#ffd166';colors[2]='#4ade80';colors[3]='#60a5fa';}
  for(let k=0;k<4;k++){const leg=el('[data-legend="'+k+'"]');if(leg)leg.style.color=colors[k];}
  still();
}
function rememberSim(list){sim=(list||[]).map(d=>({id:d.id|0,x:+d.x||0,y:+d.y||0,type:((d.type|0)%4+4)%4}));nextSimId=sim.reduce((max,d)=>Math.max(max,d.id),0)+1;if(nextSimId<1)nextSimId=1;}
function seedSimList(){rememberSim(positions.map(([x,y,type],i)=>({id:i+1,x,y,type})));}
function seedSimBatch(){const markers=Array.isArray(root._markers)?root._markers:[];const total=combineDancerStickers(sim,markers,1e9).length;const next=nextSeedBatch(sim.length,total,DANCER_CAP);let id=sim.reduce((m,d)=>Math.max(m,d.id|0),0);for(const [x,y,type] of next.positions)sim.push({id:++id,x,y,type:((type|0)%4+4)%4});nextSimId=id+1;if(next.truncated)capReached(next.positions.length);return next;}
function capReached(added){const text=DANCER_CAP+'-dancer limit reached'+(added?' · added '+added:'');report(text);try{root.dispatchEvent(new CustomEvent('nd-dancer-cap',{bubbles:true,detail:{cap:DANCER_CAP,added,text}}));}catch{}}
function syncStickers(){const list=combineDancerStickers(sim,Array.isArray(root._markers)?root._markers:[]);const n=Math.min(list.length,DANCER_CAP);if(n){const buf=new Float32Array(api.memory.buffer,api.nd_sticker_in(),n*4);for(let i=0;i<n;i++){const s=list[i];buf[i*4]=s.id;buf[i*4+1]=s.x;buf[i*4+2]=s.y;buf[i*4+3]=s.type|0;}}api.nd_set_stickers(n);linkR=linkRadiusFor(list.slice(0,n));if(typeof api.nd_set_link_radius==='function')api.nd_set_link_radius(linkR);root.dataset.linkRadius=String(linkR);}
function reportCount(prefix){const text=formatDancerCount(api.nd_count(),markerCount())+' · '+api.nd_pulse_count()+' pulses';report(prefix?prefix+text:text);}
function paintSimButtons(){root.querySelectorAll('[data-action="sim-dancers"],[data-sim-clear]').forEach(btn=>{btn.textContent='Clear sim dancers';btn.disabled=sim.length===0;});root.querySelectorAll('[data-action="sim-seed"]').forEach(btn=>{btn.textContent='Seed 24 sim dancers';btn.disabled=false;});}
function clearSim(){sim=[];saveRoomSettings();syncStickers();paintSimButtons();reportCount();still();}
function seedSim(){const next=seedSimBatch();saveRoomSettings();syncStickers();paintSimButtons();if(!next.truncated)reportCount();still();return next.positions.length;}
function addSimAt(x,y,type){const markers=Array.isArray(root._markers)?root._markers:[];if(combineDancerStickers(sim,markers).length>=DANCER_CAP){capReached(0);return 0;}const id=nextSimId++;sim.push({id,x,y,type:((type|0)%4+4)%4});saveRoomSettings();syncStickers();paintSimButtons();reportCount();still();return id;}
function report(text){status.textContent=text;}
function onscreen(){const r=canvas.getBoundingClientRect();return !document.hidden&&r.bottom>0&&r.top<innerHeight&&r.left<innerWidth&&r.right>0&&root.isConnected;}
function cancel(){clearTimeout(timer);cancelAnimationFrame(raf);timer=raf=0;}
function stop(text='Paused', releaseMic=false){running=false;cancel();if(releaseMic)disarmMic();else if(ac&&micState!=='listening')ac.suspend().catch(()=>{});play.textContent='Start';report(text);}
function start(){if(running||!onscreen()||!api)return;cancel();running=true;last=performance.now();started=last;slow=0;play.textContent='Pause';report('Running');if(ac&&micState==='listening')ac.resume().catch(()=>{});schedule(0);}
function schedule(delay){if(running)timer=setTimeout(()=>{timer=0;raf=requestAnimationFrame(frame);},delay);}
function still(){if(running||raf||!api)return;raf=requestAnimationFrame(()=>{raf=0;draw();drawSpectrum();});}
function boundedResume(p){return new Promise((res,rej)=>{const t=setTimeout(()=>rej(Object.assign(new Error('audio resume timeout'),{name:'AbortError'})),AUDIO_RESUME_MS);Promise.resolve(p).then(v=>{clearTimeout(t);res(v);},e=>{clearTimeout(t);rej(e);});});}
function noteFrameError(err){const msg=String(err&&err.message||err).slice(0,200);const first=!lastFrameError||lastFrameError.msg!==msg;lastFrameError={msg,stack:String(err&&err.stack||'').split('\n').slice(0,4).join(' | ').slice(0,600),at:Math.round(performance.now()),count:(lastFrameError&&lastFrameError.msg===msg?lastFrameError.count:0)+1};if(first)try{console.error('[nd] frame error: '+msg);}catch{}}
function scheduleMicRecover(){if(micRecoverTimer||micRecoverTries>=MIC_RECOVER_MAX)return;micRecoverTries++;micRecoverTimer=setTimeout(async()=>{micRecoverTimer=0;if(document.hidden||micState==='listening'||micPending)return;micPending=true;try{await startListen();}catch{}finally{micPending=false;}if(micState==='listening'){micRecoveries++;}else scheduleMicRecover();},600*micRecoverTries);}
function ensureGraph(){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw new Error('no audio');if(!ac){ac=new AC();watchAudioContext(ac);}return ac.resume();}
function watchAudioContext(ctx){if(!ctx||typeof ctx.addEventListener!=='function')return;ctx.addEventListener('statechange',()=>{if(ctx.state!=='running'&&ctx.state!=='closed'&&micState==='listening'&&running)ctx.resume().catch(()=>{});});}
function micStreamLive(stream){if(!stream||typeof stream.getAudioTracks!=='function')return false;return stream.getAudioTracks().some(t=>t.readyState!=='ended');}
function holdClock(){api.nd_set_clock(0);}
function applyMicState(state,text){micState=state;const m=MIC[state];listenButton.textContent=m.label;listenButton.dataset.state=state;listenButton.setAttribute('aria-pressed',m.pressed?'true':'false');root.dataset.mic=state;micStatus.textContent=text||m.status;holdClock();agcReset();if(bandOnsets)bandOnsets.reset();if(listenPattern){listenPattern.reset();patternLabels(null);}patternState=null;tempoReset();if(melodyPad)melodyPad.reset();lastPadFeatures=null;if(state!=='listening'){for(let k=0;k<4;k++){const bar=el('[data-meter="'+k+'"]');if(bar)bar.style.transform='scaleX(0)';const leg=el('[data-legend="'+k+'"]');if(leg)leg.classList.remove('is-hot');}}}
function releaseMicHardware(){if(nnListen){try{nnListen.stop();}catch{}}const stream=micStream;micStream=null;rings.release();try{micSource&&micSource.disconnect();}catch{}micSource=null;analyser=null;spec=null;if(stream)stream.getTracks().forEach(t=>{try{t.stop();}catch{}});}
function disarmMic(){const was=micState;releaseMicHardware();if(was!=='unavailable')applyMicState('off');if(ac)ac.suspend().catch(()=>{});}
function watchMic(stream){for(const track of stream.getAudioTracks()){track.addEventListener('ended',()=>{if(micStream!==stream)return;const was=micState==='listening';releaseMicHardware();applyMicState('unavailable','No microphone');report('No microphone');if(was)scheduleMicRecover();});}}
function requestMic(){const md=navigator.mediaDevices;if(!md||!md.getUserMedia)return Promise.reject(Object.assign(new Error('no mic'),{name:'NotFoundError'}));return md.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}).catch(err=>{if(err&&err.name==='OverconstrainedError')return md.getUserMedia({audio:true});throw err;});}
function micFailure(err){const denied=err&&(err.name==='NotAllowedError'||err.name==='SecurityError'||err.name==='PermissionDeniedError');applyMicState('unavailable',denied?'Microphone blocked':'No microphone');report(denied?'Microphone blocked':'No microphone');}
async function startListen(){start();if(!running)return;holdClock();let graph;try{graph=ensureGraph();}catch{applyMicState('unavailable','No microphone');return;}micStatus.textContent='Asking for the microphone';const pending=requestMic();try{await boundedResume(graph);}catch(err){micFailure(err);try{(await pending).getTracks().forEach(t=>t.stop());}catch{}return;}let stream;try{stream=await pending;}catch(err){micFailure(err);return;}if(!running){stream.getTracks().forEach(t=>t.stop());return;}releaseMicHardware();analyser=ac.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=0;analyser.minDecibels=-96;analyser.maxDecibels=-24;spec=new Uint8Array(analyser.frequencyBinCount);micSource=ac.createMediaStreamSource(stream);micSource.connect(analyser);if(nnListen){try{nnListen.start(ac,micSource);}catch{try{nnListen.stop();}catch{}nnListen=null;}}micStream=stream;watchMic(stream);writeMicReady(localStorage,true);applyMicState('listening');}
async function listenCommand(gesture){if(micState==='listening')return true;if(micState==='muted'&&micStreamLive(micStream)){setMicMuted(false);if(ac)ac.resume().catch(()=>{});return true;}if(micStream&&!micStreamLive(micStream)){releaseMicHardware();applyMicState('off');}if(!gesture&&!micReadySaved(localStorage)&&!micStream){applyMicState('needs-gesture',MIC_NEEDS_GESTURE);return false;}if(micPending)return false;micPending=true;try{await startListen();}finally{micPending=false;}if(micState==='listening')return true;if(!gesture){writeMicReady(localStorage,false);applyMicState('blocked',MIC_BLOCKED);}return false;}
function stopListenCommand(){if(micStream){setMicMuted(true);return;}if(micState==='listening'||micState==='muted'||micState==='needs-gesture')applyMicState(micReadySaved(localStorage)?'muted':'off');}
function setMicMuted(muted){if(!micStream){applyMicState('off');return;}for(const track of micStream.getAudioTracks())track.enabled=!muted;applyMicState(muted?'muted':'listening');if(!muted)start();}
async function toggleListen(){micRecoverTries=0;if(micPending)return;if(micState==='listening'){setMicMuted(true);return;}if(micState==='muted'&&micStreamLive(micStream)){setMicMuted(false);if(ac)ac.resume().catch(()=>{});return;}if(micStream&&!micStreamLive(micStream)){releaseMicHardware();applyMicState('off');}micPending=true;try{await startListen();}finally{micPending=false;}}
function agcReset(){ndSilenceGate.reset(gate);}
function agcKnee(x){return ndSilenceGate.knee(x);}
function agcScale(raw,dt,idle){return ndSilenceGate.scale(gate,raw,dt,idle);}
function paintFloor(listening){const floorEl=el('[data-floor]');if(!floorEl)return;floorEl.textContent=listening?'noise floor '+gate.noiseFloor.toFixed(2)+(gate.open?'':' · quiet'):'noise floor —';}
function wasmActivation(){const f=floats(),base=api.nd_dancers()>>>2,ds=api.nd_dancer_stride(),n=api.nd_count();let mx=0,sum=0;for(let i=0;i<n;i++){const a=+f[base+i*ds+2]||0;sum+=a;if(a>mx)mx=a;}return {max:Math.round(mx*1000)/1000,mean:n?Math.round(sum/n*1000)/1000:0};}
function rawLevels(){const f=floats(),base=api.nd_levels()>>>2;return [0,1,2,3].map(k=>f[base+k]||0);}
function paintMeters(now,levels){for(let k=0;k<4;k++){const bar=el('[data-meter="'+k+'"]');if(bar)bar.style.transform='scaleX('+(levels[k]||0).toFixed(3)+')';el('[data-legend="'+k+'"]').classList.toggle('is-hot',hotUntil[k]>now);}}
function drawSpectrum(levels){const w=spectrum.width,h=spectrum.height;sctx.fillStyle='#05060a';sctx.fillRect(0,0,w,h);const names=['Kick','Bass','Mid','Treble'],cols=colors.length?colors:['#ffd166','#5ce1e6','#7fe8b3','#81b7fc'];if(micState!=='listening'||!spec){sctx.fillStyle='#9da5b8';sctx.font='14px sans-serif';sctx.fillText(micState==='muted'?'Muted':'Mic off',12,h/2);return;}
 const lv=levels||rawLevels(),gap=10,bw=(w-gap*5)/4;sctx.font='13px sans-serif';sctx.textAlign='center';
 for(let k=0;k<4;k++){const v=lv[k]||0,x=gap+k*(bw+gap),track=h-28,bh=Math.max(2,v*track);sctx.fillStyle='#171b27';sctx.fillRect(x,8,bw,track);sctx.fillStyle=cols[k];sctx.fillRect(x,8+track-bh,bw,bh);sctx.fillText(names[k],x+bw/2,h-6);}sctx.textAlign='left';
}
function shape(k,p,r){ctx.beginPath();if(k===0)ctx.arc(p.x,p.y,r,0,Math.PI*2);else if(k===1){ctx.moveTo(p.x,p.y-r);ctx.lineTo(p.x+r,p.y);ctx.lineTo(p.x,p.y+r);ctx.lineTo(p.x-r,p.y);ctx.closePath();}else if(k===2)ctx.rect(p.x-r*.8,p.y-r*.8,r*1.6,r*1.6);else{ctx.moveTo(p.x,p.y-r);ctx.lineTo(p.x+r,p.y+r);ctx.lineTo(p.x-r,p.y+r);ctx.closePath();}ctx.fill();}
function sacred(xy){drawSacredFloor(ctx,xy,floorWarp);}
function scanCover(){const until=+(root.dataset.ndScanUntil||0);if(!(until>performance.now()))return false;const mode=root.dataset.ndScanMode;ctx.fillStyle=mode==='white'?'#ffffff':mode==='gray'?'#a8a8a8':'#000000';ctx.fillRect(0,0,canvas.width,canvas.height);return true;}
function paintLatency(){if(root.dataset.latencyTest!=='1')return false;paintLatencyOverlay(ctx,canvas.width,canvas.height,{frame:+root.dataset.latencyFrame||0,ms:+root.dataset.latencyMs||0});return true;}
function draw(){const f=floats(),base=api.nd_dancers()>>>2,ds=api.nd_dancer_stride(),n=api.nd_count();const scale=canvas.width/W,vx=0,vy=canvas.height/2-H*scale/2;const xy=(x,y)=>({x:vx+x*scale,y:vy+y*scale});
 const aligning=(root.dataset.ndAlignOwn==='1')||(document.body&&document.body.classList.contains('nd-live-aligning'));
 const layer=projectorFrame({aligning,flash:root.dataset.ndAlignFlash||'',pattern:root.dataset.stagePattern==='1',scan:(+(root.dataset.ndScanUntil||0)>performance.now())?root.dataset.ndScanMode:'',latency:root.dataset.latencyTest==='1'});
 try{ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';}catch{}
 ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=stageFillStyle(background)||STAGE_BACKGROUND;ctx.fillRect(0,0,canvas.width,canvas.height);
 // Simulation frame: a leftover Align/scan overlay must not sit on the floor
 // (TJ 12:17 PM: solid salmon/pink stage with dancers still showing).
 if(layer==='simulation'){
  const flashing=root.dataset.ndStickerScan==='1'||root.dataset.ndScanFlash==='1'||(+root.dataset.ndAlignFlashAlpha>0);
  if(!aligning&&!flashing){
    const flash=root.querySelector&&root.querySelector('[data-align-flash]')||document.querySelector('[data-align-flash]');
    if(flash&&!flash.hidden){flash.hidden=true;flash.style.opacity='';flash.removeAttribute('data-mode');}
    const pattern=root.querySelector&&root.querySelector('[data-cal-pattern]')||document.querySelector('[data-cal-pattern]');
    if(pattern&&!pattern.hidden)pattern.hidden=true;
  }
 }
 if(layer==='pattern'){paintAlignmentPattern(ctx,canvas.width,canvas.height);paintRipples(layer,[],0);return;}
 if(layer==='black'||layer==='white'||layer==='gray'){ctx.fillStyle=layer==='white'?'#ffffff':layer==='gray'?'#a8a8a8':'#000000';ctx.fillRect(0,0,canvas.width,canvas.height);paintRipples(layer,[],0);return;}
 if(layer==='latency'){paintLatencyOverlay(ctx,canvas.width,canvas.height,{frame:+root.dataset.latencyFrame||0,ms:+root.dataset.latencyMs||0});paintRipples(layer,[],0);return;}
 if(layer==='scan'){scanCover();paintRipples(layer,[],0);return;}
 if(performance.now()<+(root.dataset.ndDarkUntil||0)){paintRipples('dark',[],0);return;}
 sacred(xy);
 ctx.lineWidth=1.5;ctx.strokeStyle=foreground;
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const ia=base+i*ds,ib=base+j*ds,ax=f[ia],ay=f[ia+1],bx=f[ib],by=f[ib+1];if(Math.hypot(ax-bx,ay-by)>linkR)continue;const activity=Math.min(f[ia+2],f[ib+2]);if(activity<.25)continue;ctx.globalAlpha=.08+.15*Math.min(1,activity);const p=xy(ax,ay),q=xy(bx,by),amp=Math.min(18,Math.abs(bx-ax)*.15),mid=xy(ax+(bx-ax)*.5,ay+(by-ay)*.5-amp);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.quadraticCurveTo(mid.x,mid.y-(p.y+q.y)/2+mid.y,q.x,q.y);ctx.stroke();}
 ctx.globalAlpha=1;
 const beatNow=typeof performance!=='undefined'?performance.now():0;
 // TJ 4:14 PM: on the live projection, no circle markers or number labels
 // around stickers. Silhouette mode keeps only the figure (+ subtle bloom);
 // dot mode still draws the rings. Debug overlays keep their own markers.
 const silMode=silhouetteShow.mode()==='silhouette';
 if(!silMode){
  for(let i=0;i<n;i++){const o=base+i*ds,p=xy(f[o],f[o+1]),a=f[o+2],rest=f[o+3],k=f[o+4]|0,q=Math.min(1,a/1.4),boost=Math.min(2.4,Math.max(0,Number.isFinite(bandSens[k])?bandSens[k]:1)),radius=dancerRingRadius(q,boost,false);const flash=beatClock.flash(k,beatNow);ctx.globalAlpha=rest>0?.4:1;rings.stroke(ctx,p.x,p.y,radius*2.15,k,colors[k],low);ctx.strokeStyle=colors[k];ctx.lineWidth=2;if(rings.rippling){ctx.globalAlpha*=.42;ctx.lineWidth=1.2;}ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.stroke();if(flash>0){ctx.save();ctx.globalCompositeOperation='lighter';ctx.globalAlpha=0.45+0.55*flash;ctx.fillStyle=colors[k]||'#fff';ctx.beginPath();ctx.arc(p.x,p.y,radius*(1.05+0.7*flash),0,Math.PI*2);ctx.fill();ctx.restore();}ctx.globalAlpha=rest>0?.4:1;ctx.fillStyle=colors[k];shape(k,p,4+2*q);if(!low){ctx.globalAlpha=.92;ctx.fillStyle='#f4f6fb';ctx.font='700 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(beatClock.label(k),p.x,p.y-radius-2);ctx.textAlign='left';ctx.textBaseline='alphabetic';}}
 }
 ctx.globalAlpha=1;
 if((root._markers||(silMode&&typeof sim!=="undefined"&&sim&&sim.length))&&(root.dataset.markersLive==='1'||silMode)){
  if(silMode)silhouetteShow.paint(ctx,(root._markers||[]).concat(simSilhouetteMarkers(typeof sim!=="undefined"?sim:null)),{xy,now:performance.now(),crowd:(root._markers?root._markers.length:0)+(typeof sim!=="undefined"&&sim?sim.length:0),levels:lastLevels,songOpen:(micState==='listening'&&gate.open)||driveOpen,network:stageDancers(),waveform:band=>typeof rings.waveform==='function'?rings.waveform(band):null,style:root._silhouetteStyle||null,idTags:!(document.body&&document.body.classList.contains('nd-painting')),paintDots:list=>paintStageMarkers(ctx,(list||[]).filter(m=>m&&m.kind==='pink'),xy,scale)});
  else paintStageMarkers(ctx,root._markers,xy,scale);
 }
 // Pulse trails after the figures so head anchors are the current pose and
 // the pinpoint lands on (not under / past) the receiver's head.
 paintPulseTrails(ctx,f,api.nd_pulses()>>>2,api.nd_pulse_count(),api.nd_pulse_stride(),xy,colors,low,silMode?headAnchor(f,base,ds,n,silhouetteShow.figureHeights()):null,silMode?pulseFineStyle(silhouetteShow.tuning()):null);
 // Ripples on their own overlay (not this canvas) so stage-echo never samples them.
 // After the figures so stomp plants and maskFigures use this frame's feet (TJ 1:54 PM).
 const rippleDancers=[];for(let i=0;i<n;i++){const o=base+i*ds;rippleDancers.push({id:f[o+5]|0,x:f[o],y:f[o+1],activity:f[o+2],type:f[o+4]|0});}
 const simRipples=(typeof sim!=='undefined'&&sim?sim:[]).map(d=>({id:d.id|0,x:+d.x||0,y:+d.y||0,activity:0.55,type:((d.type|0)%4+4)%4}));
 paintRipples(layer,rippleDancers.concat(simRipples),silhouetteShow.envelope(typeof performance!=='undefined'?performance.now():0));
}
function markerCount(){const feed=root._feed;if(!feed||typeof feed.sample!=='function')return 0;let sample;try{sample=feed.sample();}catch{return 0;}if(!Array.isArray(sample))return 0;let n=0;for(let i=0;i<sample.length&&i<48;i++)if(sample[i])n++;return n;}
function consumeFeed(){if(!root._feed)return;try{const sample=root._feed.sample();if(!Array.isArray(sample))return;syncStickers();}catch{}}
function isLiveShowPage(){try{return /\/neural-dance\/live\b/.test(location.pathname)||!!document.querySelector('.nd-live-shell,[data-live-show]');}catch{return false;}}
function writePulseAims(){
  try{
    writePulseHeadAims(api, floats(), silhouetteShow.figureHeights(), g=>g.kind==='sim'?(g.id|0):markerStickerId(g.id));
  }catch{}
}
function frame(now){raf=0;if(!running)return;if(!onscreen()){stop('Paused while out of view',true);return;}const begin=performance.now(),gap=now-last;last=now;
 try{
  consumeFeed();
  const listening=micState==='listening';
  holdClock();
  let bins=0;
  let levels=rawLevels();
  let bandHits=0,bandInfo=null;
  if(listening&&analyser&&spec){
    analyser.getByteFrequencyData(spec);
    const sr=ac?ac.sampleRate:48000;micTopHz=trackMicTopHz(micTopHz,spec,sr,analyser.fftSize,gap/1000);const bandsHz=listenBandsHz(sr,micTopHz);
    const peaks=ndSilenceGate.bandPeaks(spec,sr,analyser.fftSize,meterBandsHz(sr,micTopHz));
    levels=agcScale(peaks,gap/1000,bandOnsets?(now-lastOnsetAt)/1000:undefined);
    if(bandOnsets){
      try{bandInfo=bandOnsets.process(spec,sr,analyser.fftSize,now,gate.open,bandSens,bandsHz);if(bandInfo.onsets)lastOnsetAt=now;bandHits=bandInfo.beats|0;if(globalTempo){try{gtState=globalTempo.process(now,bandInfo.flux,gate.open,bandInfo);bandCoupler.update(bandInfo.period,now,gtState.locked?gtState.period:0,coupled);const ac2=bandAgree.update(bandInfo,gtState,coupled.ratio);for(let b=0;b<4;b++)coupledLocked[b]=!!bandInfo.locked[b]||(coupled.ratio[b]>0&&ac2[b]>=0.5);}catch{globalTempo=null;gtState=null;}}songTempo.update(now,gtState&&gtState.locked?gtState.bpm:0,!!gate.open,{kick:!!((bandInfo.onsets|0)&1),drop:false,onset:!!((bandInfo.onsets|0)&3)});if(breakdownDet){try{const bd=breakdownDet.process({t:now,lv:levels,onsets:gate.open?bandInfo.onsets|0:0,gate:!!gate.open,glv:+gate.smooth||0,bpm:songTempo.state.locked?songTempo.state.bpm:0,flux:bandInfo.flux});breakdownOut=bd;if(bd.event){songTempo.sectionEvent(now,bd.event);sectionLog.push({t:Math.round(now),type:bd.event.type,how:bd.event.how||bd.event.reason||'',big:!!bd.event.big,bars:bd.event.bars});if(sectionLog.length>12)sectionLog.shift();}silhouetteShow.section(now,bd);}catch(e){breakdownDet=null;}}if(typeof api.nd_set_emit_bpm==='function')api.nd_set_emit_bpm(songTempo.state.locked?songTempo.state.bpm:0);if(typeof silhouetteShow.setGlobalTempo==='function')silhouetteShow.setGlobalTempo(songTempo.state.locked?60000/songTempo.state.bpm:(gtState&&gtState.locked?gtState.period:0));if(envFeedUntil>now){envRing.push(Math.round(now),Math.round(bandInfo.flux[0]*10),Math.round(bandInfo.flux[1]*10),Math.round(bandInfo.flux[2]*10),Math.round(bandInfo.flux[3]*10));if(envRing.length>600)envRing.splice(0,envRing.length-600);}if(listenPattern){try{patternState=listenPattern.process(bandInfo,now,bandSens);bandHits=patternState.beats|0;patternLabels(patternState);}catch{patternOff();}}if(!gate.open)bandHits=0;entrainOut=null;if(entrain){try{entrainOut=entrain.step(now,{bpm:songTempo.state.locked?songTempo.state.bpm:0,gateOpen:!!gate.open,onsets:gate.open?bandInfo.onsets|0:0,heard:bandHits,period:gtState&&gtState.locked?coupled.period:(patternState?patternState.period:bandInfo.period)});}catch{entrain=null;entrainOut=null;}}const onBeat=entrainOut&&gate.open&&typeof api.nd_hit_on_beat==='function'?entrainOut.onBeat|0:0;for(let k=0;k<4;k++){if(onBeat&(1<<k))api.nd_hit_on_beat(k);else if(bandHits&(1<<k))api.nd_hit(k);}}
      catch{bandOnsets=null;bandHits=0;bandInfo=null;}
    }
    if(grooveWire){try{grooveWire.feed(now,{gateOpen:!!gate.open,bandInfo,gt:gtState,entrainActive:!!(entrainOut&&entrainOut.active)});}catch{grooveOff();}}
    if(nnListen){try{const gp=gtState&&gtState.locked?gtState.period:0;const g=nnListen.tick(now,gp);nnGrid=g;if(!gp&&g&&g.locked&&g.own&&typeof silhouetteShow.setGlobalTempo==='function')silhouetteShow.setGlobalTempo(g.period);}catch{nnOff();}}
    if(!bandOnsets){
      bins=Math.min(spec.length,api.nd_spectrum_cap());
      new Uint8Array(api.memory.buffer,api.nd_spectrum(),bins).set(ndSilenceGate.mask(gate,spec.subarray(0,bins)));
    }
    lastPadFeatures=null;
    if(melodyPad){
      try{
        if(!gate.open){melodyPad.reset();lastPadFeatures=null;}
        else{
          const dt=Math.max(0.001,Math.min(0.1,gap/1000));
          lastPadFeatures=melodyPad.processBytes(spec,sr,analyser.fftSize,dt);
        }
      }catch{melodyPad=null;lastPadFeatures=null;}
    }
  } else {
    lastPadFeatures=null;
  }
  if(typeof silhouetteShow.setPadFeatures==='function')silhouetteShow.setPadFeatures(lastPadFeatures);
  lastLevels=levels;
  {const quiet=listening&&!gate.open;if(quiet){if(silentSince<0)silentSince=now;}else silentSince=-1;silhouetteShow.setHush(quiet&&now-silentSince>=HUSH_AFTER_MS,now);}
  writePulseAims();
  const tones=api.nd_update(Math.min(.067,gap/1000),listening?1:0,bins,ac?ac.sampleRate:48000,analyser?analyser.fftSize:2048,now);
  // Hushed (TJ 8:32 PM): activation and in-flight pulses settle within ~1 s.
  if(listening&&silentSince>=0&&now-silentSince>=HUSH_AFTER_MS&&typeof api.nd_settle==='function')api.nd_settle(Math.min(.067,gap/1000));
  // Per-band path: each band's own beats drive its dancers' clocks (the wasm
  // tone mask also carries pulse-network fires from other bands).
  // Soak (Nov 9): no beats at all while Listen hears silence (gate closed),
  // whichever path produced them (pattern ticks, wasm pulse-network fires).
  let beatMask=listening&&!gate.open?0:(bandInfo?bandHits:tones);
  let beatInfo=bandInfo?(gtState&&gtState.locked?{period:coupled.period,locked:coupledLocked}:{period:patternState?patternState.period:bandInfo.period,locked:bandInfo.locked}):undefined;
  if(nnDrive&&listening&&bandInfo){try{const d=nnDrive.step(now,{gateOpen:gate.open,grid:nnListen?nnGrid:null,patternMask:beatMask,patternInfo:beatInfo,ratio:gtState&&gtState.locked?coupled.ratio:null,gtPeriod:gtState&&gtState.locked?gtState.period:0});beatMask=listening&&!gate.open?0:d.mask;beatInfo=d.info;}catch{nnDrive=null;}}
  // Entrained: once the song tempo locks, each band steps on its predicted beats (nn grid keeps priority when it drives).
  // Groove (ND Listen v2): accents + phrase start on the entrain beat info, only while confident (else unchanged).
  if(grooveWire&&entrainOut&&entrainOut.active&&listening){try{grooveWire.decorate(now,entrainOut);}catch{grooveOff();}}
  if(entrainOut&&entrainOut.active&&listening&&!(nnDrive&&nnDrive.state.source==='nn')){beatMask=gate.open?entrainOut.mask:0;beatInfo=entrainOut.info;}
  if(beatMask)beatClock.note(beatMask,now);
  if(bandInfo&&gate.open&&(bandInfo.onsets|0))silhouetteShow.onsets(now,bandInfo.onsets|0);
  if(beatMask)silhouetteShow.beat(now,beatMask,beatInfo);
  if(beatReadout){const text=beatClock.readout(now);if(beatReadout.textContent!==text)beatReadout.textContent=text;}
  if(listening){for(let k=0;k<4;k++)if(beatMask&(1<<k)){hotUntil[k]=now+180;bandBeatCount[k]++;const log=bandHitLog[k];log.push(Math.round(now));if(log.length>16)log.shift();bandHitSeq++;}paintMeters(now,levels);paintFloor(true);}else paintFloor(false);
  if(listening&&micSource&&ac)rings.connect(ac,micSource);else rings.release();
  rings.sample(gap/1000);
  draw();drawSpectrum(levels);
  frameErrors=0;
 }catch(err){
  // Crash guard (TJ 6:36 PM): one bad frame must not stop the show. Skip it;
  // only pause after many consecutive failures.
  frameErrors++;try{ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';}catch{}
  noteFrameError(err);
  // TJ 9:08 PM "seems to crash": 30 bad frames in a row used to Pause the
  // stage (and with it Listen). On the projector, reset the per-dancer motion
  // state and keep going instead; elsewhere keep the old pause.
  if(frameErrors>=30){if(!isLiveShowPage()){stop('Paused');return;}frameRecoveries++;frameErrors=0;try{resetBodyDynamics();resetTravel();resetSpineFlex();}catch{}}
 }
 const cost=performance.now()-begin;slow=cost>25||gap>150?slow+1:Math.max(0,slow-1);
 // On the projector, never stop the show for slowness: drop to low quality and keep going.
 if(cost>150||slow>=12){if(!low){low=true;api.nd_set_low(1);}if(!isLiveShowPage()){stop('Paused to keep the browser responsive');return;}slow=0;}
 if(now-lastReport>1000){const floorNote=micState==='listening'?' · noise floor '+gate.noiseFloor.toFixed(2)+(gate.open?'':' · quiet'):'';report((micState==='listening'?'Listening · ':'')+formatDancerCount(api.nd_count(),markerCount())+' · '+api.nd_pulse_count()+' pulses'+floorNote);lastReport=now;}
 schedule(Math.max(0,1000/30-cost));
}
function projectorLayout(layer){const r=layer.getBoundingClientRect(),w=r.width,h=r.height;layer.dataset.pinWidth=String(Math.round(w));return {id:'nd-room-projector',sourcePoints:[[0,0],[w,0],[w,h],[0,h]],targetPoints:[[r.left,r.top],[r.right,r.top],[r.right,r.bottom],[r.left,r.bottom]]};}
function enterMapping(layout){allowMap=true;const layer=document.getElementById('nd-room-projector');layer.style.position='fixed';layer.style.display='block';layer.style.top='0px';layer.style.left='0px';layer.style.margin='0px';layer.style.padding='0px';layer.style.width=layer.dataset.pinWidth+'px';mapper.setLayout([layout]);mapper.setConfigEnabled(true);root.classList.add('is-mapping');alignButton.setAttribute('aria-pressed','true');alignButton.textContent='Mapping';}
function exitMapping(){allowMap=false;if(mapper)mapper.setConfigEnabled(false);const layer=document.getElementById('nd-room-projector');layer.style.position='';layer.style.top='';layer.style.left='';layer.style.margin='';layer.style.padding='';layer.style.display='';layer.style.width='';layer.style.transform='';root.classList.remove('is-mapping');alignButton.setAttribute('aria-pressed','false');alignButton.textContent='Align projector';}
function toggleAlign(){if(!window.maptastic||!window.maptastic.Maptastic){report('Projector align unavailable');return;}const layer=document.getElementById('nd-room-projector');if(alignButton.getAttribute('aria-pressed')==='true'){exitMapping();return;}const layout=projectorLayout(layer);if(!mapper){try{mapper=new maptastic.Maptastic({autoSave:false,autoLoad:false,labels:false,layers:['nd-room-projector']});const open=mapper.setConfigEnabled.bind(mapper);mapper.setConfigEnabled=on=>{if(on&&!allowMap)return;open(on);};}catch{report('Projector align unavailable');return;}}enterMapping(layout);}
function mapping(){return alignButton.getAttribute('aria-pressed')==='true';}
function pointerWorld(e){const r=canvas.getBoundingClientRect(),scale=canvas.width/W,vx=0,vy=canvas.height/2-H*scale/2;const cx=(e.clientX-r.left)*canvas.width/Math.max(1,r.width),cy=(e.clientY-r.top)*canvas.height/Math.max(1,r.height);return {x:(cx-vx)/scale,y:(cy-vy)/scale};}
function dancerAt(p){const f=floats(),base=api.nd_dancers()>>>2,ds=api.nd_dancer_stride(),n=api.nd_count();let id=0,best=18;for(let i=0;i<n;i++){const o=base+i*ds,d=Math.hypot(f[o]-p.x,f[o+1]-p.y);if(d<best){id=f[o+5]|0;best=d;}}return id;}
function loadRoomSettings(){
  let saved=null;
  try{migrateSimDefaultOff(null);}catch{}
try{const on=migrateRippleDefaultOn(null);const kept=savedRippleIntensity(null);rippleUserSet=!!kept;applyRippleSettings({enabled:on!==false,intensity:kept?kept.intensity:RIPPLE_DEFAULT_INTENSITY},{boot:true});}catch{}
  try{const hs=savedHueSpread(null);const input=el('[data-control="hue-spread"]');if(hs!=null&&input)input.value=String(hs);}catch{}
  try{applyFloorPerspective(savedPerspective(memoryOf(null)),{boot:true});}catch{applyFloorPerspective(PERSPECTIVE_DEFAULT,{boot:true});}
  try{migratePeakHoldDefault(null);}catch{}
  try{migrateBandSensDefaults(null);}catch{}
  try{saved=readRoomSettings(memoryOf(null));}catch{saved=null;}
  // Show default: no sim dancers. Seed only via the explicit Seed button / debug.
  if(saved&&Array.isArray(saved.sim)&&saved.sim.length&&saved.simDancers!==false){if(isLegacySeed(saved.sim))seedSimList();else rememberSim(saved.sim);}
  else rememberSim([]);
  if(!saved){saveRoomSettings();return;}
  for(const name of ['gravity','wander','threshold','peak','quiet']){const input=el('[data-control="'+name+'"]');if(input&&Number.isFinite(saved[name]))input.value=String(saved[name]);}
  const type=el('[data-control="type"]');if(type&&Number.isFinite(saved.type))type.value=String(saved.type);
  if(Array.isArray(saved.sens))root.querySelectorAll('[data-control="sens"]').forEach(input=>{const band=+input.dataset.band;if(Number.isFinite(+saved.sens[band]))input.value=String(saved.sens[band]);});
}
function saveRoomSettings(){
  try{
    const sens=[0,1,2,3].map(band=>{const input=root.querySelector('[data-control="sens"][data-band="'+band+'"]');return input?+input.value:1;});
    const type=el('[data-control="type"]');
    writeRoomSettings(memoryOf(null),{
      gravity:+el('[data-control="gravity"]').value,
      wander:+el('[data-control="wander"]').value,
      threshold:+el('[data-control="threshold"]').value,
      peak:+el('[data-control="peak"]').value,
      quiet:+(el('[data-control="quiet"]')||{value:0.08}).value,
      type:type?+type.value:1,
      sens,
      sim:sim.map(d=>({id:d.id,x:d.x,y:d.y,type:d.type})),
      simDancers:sim.length>0
    });
  }catch{}
}
function bindSlider(name,apply,format){const input=el('[data-control="'+name+'"]'),out=el('[data-value="'+name+'"]');const sync=draw=>{const v=+input.value;apply(v);if(out)out.textContent=format(v);saveRoomSettings();if(draw)still();};input.addEventListener('input',()=>sync(true));sync(false);}
function stageDancers(){const hotFn=typeof api.nd_dancer_hot==='function'?api.nd_dancer_hot:null,f=floats(),base=api.nd_dancers()>>>2,ds=api.nd_dancer_stride(),n=api.nd_count(),rec=typeof api.nd_received==='function'?api.nd_received()>>>2:-1,out=[];for(let i=0;i<n;i++){const o=base+i*ds;out.push({id:f[o+5]|0,x:f[o],y:f[o+1],type:f[o+4]|0,activity:+f[o+2]||0,received:rec>=0?(+f[rec+i]||0):0,rest:+f[o+3]>0,hot:hotFn?!!hotFn(i):false});}return out;}
function paintLightMode(){const mode=silhouetteShow.mode();root.dataset.lightMode=mode;document.querySelectorAll('button[data-light-mode]').forEach(button=>{button.textContent=mode==='silhouette'?'Light: silhouette':'Light: dot';button.setAttribute('aria-pressed',mode==='silhouette'?'true':'false');});}
function bootRoomLab(){
(async()=>{
root=document.getElementById('nd-room-lab');
if(!root||root.dataset.roomBoot==='1')return;
root.dataset.roomBoot='1';
canvas=root.querySelector('[data-stage]'),ctx=canvas.getContext('2d');
spectrum=root.querySelector('[data-spectrum]'),sctx=spectrum.getContext('2d');
el=s=>root.querySelector(s);
play=el('[data-action="play"]'),listenButton=el('[data-action="listen"]'),alignButton=el('[data-action="align"]'),status=el('[data-status]'),micStatus=el('[data-mic]');
W=1000,H=620,R=82;linkR=LINK_R_MIN;


positions=prototypePositions();
legacyPositions=legacyPrototypePositions();
// Saved rooms seeded with the old random clump move to the spread layout.

sim=[];
nextSimId=1;
api=null,running=false,low=false,allowMap=false,mapper=null;
timer=0,raf=0,last=0,started=0,slow=0,lastReport=0;
ac=null;
colors=[],foreground='',background='';
rings=(typeof NeuralDanceRings==='undefined'?null:NeuralDanceRings.createSession())||{connect(){},release(){},sample(){},stroke(){},waveform(){return null;}};
silhouetteShow=createSilhouetteShow();
// nd.ripple.sw=1 lets software GL run the GPU field (tests/renders only).
waterRipple=createWaterRipple({allowSoftware:(()=>{try{return localStorage.getItem('nd.ripple.sw')==='1';}catch{return false;}})()});
try{waterRipple.setIntensity(RIPPLE_DEFAULT_INTENSITY);}catch{}
rippleEnabled=true;
floorWarp=floorHomography(PERSPECTIVE_DEFAULT);
try{if(waterRipple.setWarp)waterRipple.setWarp(floorWarp);}catch{}

rippleCanvas=null;

rippleUserSet=false;


try{migrateLightSilhouetteDefault(null);}catch{}
silhouetteShow.setMode(root.dataset.lightMode==='silhouette'||root.dataset.lightMode==='dot'?root.dataset.lightMode:readLightMode(null));

root._silhouetteStyle=silhouetteBloomStyle;
beatClock=createBeatClock({now:typeof performance!=='undefined'?performance.now():0});
beatReadout=el('[data-beat]');
micState='off',micPending=false,micStream=null,micSource=null,analyser=null,spec=null,pointer=null,lastLevels=[0,0,0,0];
driveOpen=false;
bandSens=BAND_SENS_RECOMMENDED.slice();
// Per-band Listen timing (TJ 6:45 PM): each band has its own onset detector and
// beat tracker (src/band-onsets.js). It reads the same analyser bytes; no audio
// nodes change. ?listen=legacy (or localStorage nd.listen.legacy=1) restores the
// wasm detector; any error in the new path also falls back to it for the session.

bandOnsets=null;try{if(!listenLegacy())bandOnsets=createBandOnsets();}catch{bandOnsets=null;}
melodyPad=null;try{melodyPad=createMelodyPadAnalyzer();}catch{melodyPad=null;}
lastPadFeatures=null;
// Listen v2 pattern learning: ON by default since TJ 7:44 PM ("I'd turn the
// flag on"). Opt out with ?listen=perband (or legacy), or localStorage
// nd.listen.pattern=0. Any error drops back to per-band beats.

// Global song tempo (TJ 7:43 PM): one stable BPM from the summed onset
// envelope; band tempos snap to simple ratios of it (coupler) and band
// confidence is how often that band's hits land on the shared grid.
globalTempo=null,gtState=null,nnDrive=null,nnGrid=null;songTempo=createSongTempoLock();
// Beat entrainment (TJ Nov 11 2:29 PM): steps on predicted beats of the locked song tempo. Off: ?entrain=0 or nd.entrain=0.

// Breakdown / build / drop labels (TJ Nov 11 4:12 PM): drive section motion and the BPM re-check when a breakdown ends. Off: ?sections=0 or nd.sections=0.

breakdownDet=null,breakdownOut=null;sectionLog=[];try{breakdownDet=sectionsOn()?createBreakdownDetector():null;}catch{breakdownDet=null;}
entrain=null,entrainOut=null;try{entrain=entrainOn()?createBeatEntrain():null;}catch{entrain=null;}bandCoupler=createCoupler(),bandAgree=createBandAgreement();
coupled={ratio:new Float64Array(4),free:[false,false,false,false],period:new Float32Array(4)};coupledLocked=[false,false,false,false];
try{if(bandOnsets)globalTempo=createGlobalTempo();}catch{globalTempo=null;}
// ND Listen v2 (TJ Nov 12): beat-pattern learning (src/groove-learn.js) on the entrained clock: meter, downbeat,
// per-band groove, phrases. Drives the dancers' bar / accents / phrase starts only while confident; below that
// the entrain output is untouched. Off: ?groove=0 or nd.groove=0 (phrase realign only: ?groovePhrase=0).

grooveWire=null;try{if(entrain&&grooveFlag('groove'))grooveWire=createGrooveWire({groove:createGrooveLearner(),entrain,phrase:grooveFlag('groovePhrase')});}catch{grooveWire=null;}


// Per-frame onset envelope for the debug feed (TJ 7:46 PM), only while a
// viewer pulls audio samples: [t, kick, bass, mid, hat] flux x10, ints.
envFeedUntil=0;envRing=[];
listenPattern=null,patternState=null;try{if(bandOnsets&&listenPatternOn())listenPattern=createListenPattern();}catch{listenPattern=null;}
// Listen nn (TJ 8:29 PM): Beat This! (MIT) beat/downbeat network in a worker
// (nn/nn-listen.js). Additive only: gives the beat grid and a tempo before
// the global tempo locks. ?listen=pattern or localStorage nd.listen.nn=0 = off.
nnListen=null;
// Drop the nn observer for the session; never touches the mic or AudioContext.

try{if(listenPattern&&typeof location!=='undefined'&&nnListenOn(location,typeof localStorage!=='undefined'?localStorage:null))nnListen=createNnListen();}catch{nnListen=null;}
// Beat This! drives the dancers when confident (TJ 9:49 PM); else the pattern tracker.
try{if(nnListen)nnDrive=createNnDrive();}catch{nnDrive=null;}
// Inset tempo line: meter + tempo ratio of the shared beat, e.g. 'High · 240 BPM (×2) · 4/4'.




bandBeatCount=[0,0,0,0];
// Last 16 beat times per band (performance.now ms) for the debug feed.
bandHitLog=[[],[],[],[]];bandHitSeq=0;
// Highest analyser bin that carried signal recently: a phone mic with a low
// effective bandwidth gets its hat band moved below that edge (iPhone hat=0).
micTopHz=0;
// True silence (TJ 7:25 PM): Listen on + silence gate closed for HUSH_AFTER_MS
// → dancers ease to a still, planted pose; the gate opening resumes at once.
HUSH_AFTER_MS=300;silentSince=-1;lastOnsetAt=-1e9;
hotUntil=[0,0,0,0];
MIC={off:{label:'Listen',status:'Mic off',pressed:false},listening:{label:'Listening',status:'Mic on',pressed:true},muted:{label:'Muted',status:'Muted',pressed:false},unavailable:{label:'No mic',status:'No microphone',pressed:false},'needs-gesture':{label:'Listen',status:MIC_NEEDS_GESTURE,pressed:false},blocked:{label:'Mic blocked',status:MIC_BLOCKED,pressed:false}};
try{
  if(!globalThis.ndSilenceGate)throw new Error('gate');
  const res=await fetch('/neural-dance/neural-dance.wasm');
  if(!res.ok)throw new Error('missing');
  api=(await WebAssembly.instantiate(await res.arrayBuffer())).instance.exports;
  if(typeof api.nd_set_clock!=='function'||typeof api.nd_add!=='function'||typeof api.nd_set_gravity!=='function'||typeof api.nd_set_wander!=='function'||typeof api.nd_set_threshold!=='function'||typeof api.nd_set_peak_hold!=='function'||typeof api.nd_set_band_sens!=='function')throw new Error('exports');
}catch{status.textContent='Room music unavailable';play.disabled=listenButton.disabled=alignButton.disabled=true;return;}
gate=ndSilenceGate.create();
rings.gate=gate;
// A zeroed band slider mutes onsets. The ring stays at unity so that band is still visible.
// A zeroed band slider mutes that band (ringSens(0) → 0); only a missing value falls back to unity.
rings.sensAt=band=>{const s=+bandSens[band];return Number.isFinite(s)?Math.max(0,s):undefined;};




// Seed press: ADD the next batch of 24 (TJ Nov 11 3:12 PM), up to DANCER_CAP
// total dancers; at the cap, say so (status + toast event for /live/).















// Soak test (Nov 9): a resume() that never settles (no gesture after a screen
// lock, or an iOS interruption) left micPending stuck, so Listen ignored taps.
// Give up after AUDIO_RESUME_MS; the Resume button / a Listen tap retries.
AUDIO_RESUME_MS=4000;

frameRecoveries=0,lastFrameError=null;

// TJ 9:08 PM "Listen cuts out": iOS can end the mic track (camera restart
// for Align, route change, interruption). Re-acquire it a few times while we
// were listening and the page is visible, instead of staying "No microphone".
MIC_RECOVER_MAX=5;micRecoverTries=0,micRecoverTimer=0,micRecoveries=0;


// Safe Listen recovery (TJ 6:03 PM): if iOS suspends/interrupts the context
// while we are listening, only resume it. Never stop, replace or re-acquire a
// working stream here (513af6a's auto-recover dropped audio).





























frameErrors=0;
// The live show never self-pauses for slowness (it drops to low quality instead).














loadRoomSettings();
bindSlider('gravity',v=>api.nd_set_gravity(v),v=>v.toFixed(1)+'×');
bindSlider('wander',v=>api.nd_set_wander(v),v=>v.toFixed(2));
bindSlider('threshold',v=>api.nd_set_threshold(v),v=>(+v).toFixed(2));
bindSlider('peak',v=>api.nd_set_peak_hold(v),v=>v.toFixed(1)+' s');
bindSlider('quiet',v=>{ndSilenceGate.setQuiet(gate,v);silhouetteShow.setTuning({quiet:+v});},v=>(+v).toFixed(2));
if(el('[data-control="hue-spread"]')){bindSlider('hue-spread',v=>silhouetteShow.setTuning({hueSpread:+v}),v=>(+v).toFixed(2));el('[data-control="hue-spread"]').addEventListener('input',e=>saveHueSpread(null,+e.target.value));}
if(el('[data-control="floor-perspective"]')){bindSlider('floor-perspective',v=>applyFloorPerspective(v),v=>(+v).toFixed(2));}
if(el('[data-control="hip-eight"]'))bindSlider('hip-eight',v=>silhouetteShow.setTuning({hipEight:+v}),v=>(+v).toFixed(2));
if(el('[data-control="shoulder-eight"]'))bindSlider('shoulder-eight',v=>silhouetteShow.setTuning({shoulderEight:+v}),v=>(+v).toFixed(2));
if(el('[data-control="hip-twist"]'))bindSlider('hip-twist',v=>silhouetteShow.setTuning({hipTwist:+v}),v=>(+v).toFixed(2));
if(el('[data-control="shoulder-twist"]'))bindSlider('shoulder-twist',v=>silhouetteShow.setTuning({shoulderTwist:+v}),v=>(+v).toFixed(2));
if(el('[data-control="max-body-turn"]'))bindSlider('max-body-turn',v=>silhouetteShow.setTuning({maxBodyTurn:+v}),v=>(+v).toFixed(0)+'°');
if(el('[data-control="turn-freq"]'))bindSlider('turn-freq',v=>silhouetteShow.setTuning({turnFreq:+v}),v=>(+v).toFixed(2));
if(el('[data-control="eight-depth"]'))bindSlider('eight-depth',v=>silhouetteShow.setTuning({eightDepth:+v}),v=>(+v).toFixed(2));
if(el('[data-control="eight-vert"]'))bindSlider('eight-vert',v=>silhouetteShow.setTuning({eightVert:+v}),v=>(+v).toFixed(2));
if(el('[data-control="arm-pad-sense"]'))bindSlider('arm-pad-sense',v=>silhouetteShow.setTuning({armPadSense:+v}),v=>(+v).toFixed(2));
if(el('[data-control="rave-moves"]'))bindSlider('rave-moves',v=>silhouetteShow.setTuning({raveMoves:+v}),v=>(+v).toFixed(2));
if(el('[data-control="inner-bones"]'))bindSlider('inner-bones',v=>silhouetteShow.setTuning({innerBones:+v}),v=>['Off','Stage','All'][Math.max(0,Math.min(2,Math.round(+v)))]);
if(el('[data-control="head-look"]'))bindSlider('head-look',v=>silhouetteShow.setTuning({headLook:+v>=0.5}),v=>(+v>=0.5?'On':'Off'));
root.querySelectorAll('[data-control="sens"]').forEach(input=>{const band=+input.dataset.band;const out=el('[data-value="sens-'+band+'"]');const sync=draw=>{const v=+input.value;bandSens[band]=v;api.nd_set_band_sens(band,v);silhouetteShow.setTuning({sens:bandSens.slice()});if(out)out.textContent=v.toFixed(2)+'×';saveRoomSettings();if(draw)still();};input.addEventListener('input',()=>sync(true));sync(false);});
typeInput=el('[data-control="type"]');if(typeInput)typeInput.addEventListener('change',()=>saveRoomSettings());
canvas.addEventListener('pointerdown',e=>{if(root.dataset.stagePattern==='1')return;if(e.target!==canvas||!api||mapping())return;const p=pointerWorld(e);if(p.x<0||p.y<0||p.x>W||p.y>H)return;const near=dancerAt(p);if(e.shiftKey){if(near&&sim.some(d=>d.id===near)){sim=sim.filter(d=>d.id!==near);saveRoomSettings();syncStickers();paintSimButtons();reportCount();still();}return;}pointer={id:near&&sim.some(d=>d.id===near)?near:0,x:e.clientX,y:e.clientY,moved:false};try{canvas.setPointerCapture(e.pointerId);}catch{}});
canvas.addEventListener('pointermove',e=>{if(!pointer||!api)return;pointer.moved=pointer.moved||Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>3;if(pointer.id&&pointer.moved){const p=pointerWorld(e);const x=Math.max(0,Math.min(W,p.x)),y=Math.max(0,Math.min(H,p.y));const dancer=sim.find(d=>d.id===pointer.id);if(dancer){dancer.x=x;dancer.y=y;}api.nd_move(pointer.id,x,y);still();}});
canvas.addEventListener('pointerup',e=>{if(!pointer||!api)return;const dragged=pointer.id&&pointer.moved;if(!pointer.id&&!pointer.moved){const p=pointerWorld(e);if(p.x>=0&&p.x<=W&&p.y>=0&&p.y<=H){const kind=+el('[data-control="type"]').value||0;addSimAt(p.x,p.y,kind);}}else if(dragged)saveRoomSettings();pointer=null;still();});
canvas.addEventListener('pointercancel',()=>{pointer=null;});
play.onclick=()=>root.neuralDance.applyShowCommand({action:running?'pause':'start'});listenButton.onclick=()=>root.neuralDance.applyShowCommand(pressShowControl('listen','phone',{listening:micState==='listening'}));alignButton.onclick=toggleAlign;
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(alignButton.getAttribute('aria-pressed')==='true'){exitMapping();e.stopImmediatePropagation();e.preventDefault();}},true);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('Paused while out of view',true);});
window.addEventListener('pagehide',()=>{stop();disarmMic();});
if('IntersectionObserver' in window)new IntersectionObserver(()=>{if(running&&!onscreen())stop('Paused while out of view',true);}).observe(canvas);
theme();syncStickers();holdClock();still();paintSimButtons();report('Ready · '+formatDancerCount(api.nd_count(),markerCount())+' · mic off');
root.querySelectorAll('[data-action="sim-dancers"],[data-sim-clear]').forEach(btn=>{btn.addEventListener('click',()=>{root.neuralDance.applyShowCommand({action:'clear-sim'});});});
root.querySelectorAll('[data-action="sim-seed"]').forEach(btn=>{btn.addEventListener('click',()=>{root.neuralDance.applyShowCommand({action:'sim-seed'});});});


root.neuralDance={
  formatDancerCount,
  setStickerFeed(feed){root._feed=feed&&typeof feed.sample==='function'?feed:null;},
  hit(type){api.nd_hit(type|0);},
  // marker hook. Fluorescent markers in projection pixels, or null to keep the current dancers.
  markers(){return root._markers||null;},
  setMarkers(list){root._markers=Array.isArray(list)?list.slice(0,48).map(m=>{const marker={id:+m.id||0,x:+m.x||0,y:+m.y||0,type:((m.type|0)%4+4)%4,kind:m.kind==='sticker'?'sticker':'pink'};if(m.manual)marker.manual=true;if(m.roam){marker.roam=true;if(+m.calm>0)marker.calm=Math.min(1,+m.calm);}if(Number.isFinite(+m.projectedHeight)&&+m.projectedHeight>0)marker.projectedHeight=+m.projectedHeight;const contour=sanitizeContour(m.contour);if(contour)marker.contour=contour;return marker;}):null;if(!root._markerFeed)root._markerFeed={sample(){return root._markers;}};if(root._markers)root._feed=root._markerFeed;else if(root._feed===root._markerFeed)root._feed=null;syncStickers();still();return root._markers;},
  lightMode(){return silhouetteShow.mode();},
  drawMode(){return typeof silhouetteShow.drawMode==='function'?silhouetteShow.drawMode():'full';},
  setDrawMode(mode){const next=typeof silhouetteShow.setDrawMode==='function'?silhouetteShow.setDrawMode(mode):'full';root.dataset.drawMode=next;still();return next;},
  setLightMode(mode){const next=silhouetteShow.setMode(mode);root.dataset.lightMode=next;writeLightMode(null,next);paintLightMode();still();return next;},
  bodyMotionSlowdown(){return typeof silhouetteShow.bodyMotionSlowdown==='function'?silhouetteShow.bodyMotionSlowdown():4;},
  setBodyMotionSlowdown(v){const next=typeof silhouetteShow.setBodyMotionSlowdown==='function'?silhouetteShow.setBodyMotionSlowdown(v):4;still();return next;},
  toggleLightMode(){const next=silhouetteShow.toggle();root.dataset.lightMode=next;writeLightMode(null,next);paintLightMode();still();return next;},
  setSilhouetteStyle(style){root._silhouetteStyle=typeof style==='function'?style:null;still();return !!root._silhouetteStyle;},
  poke(){consumeFeed();still();},
  retint(){theme();},
  redraw(){draw();},
  clearSim(){clearSim();return sim.length;},
  seedSim(){seedSim();return sim.length;},
  addSim(x,y,type){return addSimAt(+x||0,+y||0,type|0);},
  simList(){return sim.map(d=>({id:d.id,x:d.x,y:d.y,type:d.type}));},
  stageDancers(){return stageDancers();},
  simDancers(){return sim.length>0;},
  debugAudio(){const listening=micState==='listening';const lv=listening?lastLevels:[0,0,0,0];const detail=micStatus&&micStatus.textContent?micStatus.textContent:'';const mic=micState==='unavailable'&&/block/i.test(detail)?'blocked':micState;return {source:listening?'mic':'silent',kick:+lv[0]||0,bass:+lv[1]||0,snare:+lv[2]||0,hat:+lv[3]||0,envelopes:{kick:+lv[0]||0,bass:+lv[1]||0,snare:+lv[2]||0,hat:+lv[3]||0,pad:lastPadFeatures&&listening?+(lastPadFeatures.env)||0:0},pad:lastPadFeatures&&listening?lastPadFeatures:null,silenceGate:!listening||!gate.open,noiseFloor:+gate.noiseFloor||0,open:!!(listening&&gate.open),micGain:+gate.gain||0,mic,micDetail:detail};},
  debugRoom(){return {frameRecoveries,frameError:lastFrameError,micRecoveries,running,simDancers:sim.length>0,simCount:sim.length,dancers:api.nd_count(),pulses:api.nd_pulse_count(),stickers:markerCount(),markersLive:root.dataset.markersLive==='1',lightMode:silhouetteShow.mode(),drawMode:typeof silhouetteShow.drawMode==='function'?silhouetteShow.drawMode():'full',ripple:{enabled:rippleEnabled,intensity:waterRipple.intensity(),backend:waterRipple.backend,webglAvailable:!!waterRipple.webglAvailable,perspective:floorWarp?floorWarp.strength:PERSPECTIVE_DEFAULT},pose:silhouetteShow.poseStats(),activation:wasmActivation(),hush:Math.round(silhouetteShow.hush(performance.now())*100)/100};},
  micState(){return micState;},
  listenTiming(){const now=performance.now();const sr=ac?ac.sampleRate:0;const snap=bandOnsets?bandOnsets.snapshot():null;return {detector:bandOnsets?(listenPattern?'pattern':'per-band'):'legacy',sampleRate:sr,fftSize:analyser?analyser.fftSize:0,micTopHz:Math.round(micTopHz),bandsHz:sr?listenBandsHz(sr,micTopHz):null,bpm:gtState&&gtState.locked?Math.round(gtState.bpm):globalTempo?(nnListen&&nnListen.snapshot().bpm?Math.round(nnListen.snapshot().bpm):0):silhouetteShow.overallBpm(now),nn:nnListen?nnListen.snapshot():null,groove:grooveWire?grooveWire.snapshot():null,drive:nnDrive?nnDrive.snapshot():null,now:Math.round(now),beats:bandBeatCount.slice(),hits:bandHitLog.map(l=>l.slice()),bands:snap,tiers:[0,1,2,3].map(b=>{const t=silhouetteShow.bandTempo(b,now);return {tier:t.tier==='global'?'shared':t.tier==='band'?'band':'idle',bpm:t.bpm,locked:t.locked};}),...listenPatternTiming()};},
  // Compact 10 Hz audio sample for the debug feed (levels, gate, floor, gain, new hits).
  audioSample(sinceSeq){const listening=micState==='listening';const lv=listening?lastLevels:[0,0,0,0];return {t:Math.round(performance.now()),lv:[0,1,2,3].map(k=>Math.round((+lv[k]||0)*1000)/1000),gate:!!(listening&&gate.open),floor:Math.round((+gate.noiseFloor||0)*1000)/1000,glv:Math.round((+gate.smooth||0)*1000)/1000,gmus:Math.round((+gate.music||0)*1000)/1000,gopen:Math.round((+gate.openAt||0)*1000)/1000,gclose:Math.round((+gate.closeAt||0)*1000)/1000,idle:Math.round(Math.min(99,Math.max(0,(performance.now()-lastOnsetAt)/1000))*10)/10,hush:Math.round(silhouetteShow.hush(performance.now())*100)/100,act:wasmActivation(),gain:Math.round((+gate.gain||+gate.agc||0)*1000)/1000,seq:bandHitSeq,hits:sinceSeq===bandHitSeq?null:bandHitLog.map(l=>l.slice(-4)),env:envTake(),bpm:gtState&&gtState.locked?Math.round(gtState.bpm*10)/10:0};},
  saveSettings(){saveRoomSettings();},
  setAlignPattern(on){
    if(!on && (root.dataset.ndAlignOwn==='1' || (document.body && document.body.classList.contains('nd-live-aligning')))) return root.dataset.stagePattern==='1';
    const show=!!on;
    root.dataset.stagePattern=show?'1':'';
    const pattern=document.querySelector('[data-cal-pattern]');
    if(pattern)pattern.hidden=!show;
    document.querySelectorAll('button[data-align-pattern]').forEach(button=>{button.setAttribute('aria-pressed',show?'true':'false');button.textContent=show?'Hide alignment pattern':'Show alignment pattern';});
    if(document.body&&document.body.classList){
      if(show)document.body.classList.add('nd-live-pattern');
      else document.body.classList.remove('nd-live-pattern');
    }
    const exit=document.querySelector('[data-pattern-exit]');
    if(exit){
      let gap=false;
      const stage=document.getElementById('nd-room-projector');
      if(show&&stage&&stage.getBoundingClientRect){
        const r=stage.getBoundingClientRect();
        const w=window.innerWidth||0,h=window.innerHeight||0;
        gap=r.top>48||r.left>48||(w-r.right)>48||(h-r.bottom)>48;
      }
      exit.hidden=!gap;
    }
    try{draw();}catch{still();}
    return show;
  },
  ripple(){return {enabled:rippleEnabled,intensity:waterRipple.intensity(),backend:waterRipple.backend,webglAvailable:!!waterRipple.webglAvailable,perspective:floorWarp?floorWarp.strength:PERSPECTIVE_DEFAULT};},
  splashRipples(){
    const canvas=ensureRippleCanvas();
    const list=(typeof sim!=='undefined'&&sim?sim:[]).concat();
    for(const d of list){
      if(!d)continue;
      const uv=screenToFloorUV(d.x,d.y,floorWarp,W,H);
      const band=((d.type|0)%4+4)%4;
      waterRipple.hit(uv.x,uv.y,1,dancerRippleRgb(d.id|0,band,(silhouetteShow.tuning()||{}).hueSpread));
    }
    if(canvas){for(let i=0;i<14;i++)waterRipple.step(canvas);}
    return !!(canvas&&list.length);
  },
  setRipple(opts){return applyRippleSettings(opts);},
  setPerspective(value){const v=applyFloorPerspective(value);try{if(this.redraw)this.redraw();}catch{}return v;},
  perspective(){return floorWarp?floorWarp.strength:PERSPECTIVE_DEFAULT;},
  setInsets(on){const v=silhouetteShow.setInsets(on);this.redraw&&this.redraw();return v;},
  commitStickerHomes(){return typeof silhouetteShow.commitHomes==='function'?silhouetteShow.commitHomes():false;},
  insets(){return silhouetteShow.insets();},
  bloom(){return (typeof NeuralDanceRings!=='undefined'&&NeuralDanceRings.configureBloom)?NeuralDanceRings.configureBloom():{enabled:true,intensity:0.18,aura:22};},
  showTuning(){return silhouetteShow.setTuning({});},
  setShowTuning(next){const t=silhouetteShow.setTuning(next);still();return t;},
  setPadFeatures(f){return typeof silhouetteShow.setPadFeatures==='function'?silhouetteShow.setPadFeatures(f):null;},
  padFeatures(){return typeof silhouetteShow.padFeatures==='function'?silhouetteShow.padFeatures():null;},
  driveMusic(levels,mask){
    const now=performance.now();
    driveOpen=true;
    lastLevels=Array.isArray(levels)&&levels.length?levels.map(v=>Math.max(0,Math.min(1,+v||0))):[0.85,0.8,0.7,0.55];
    if(typeof silhouetteShow.setHush==='function')silhouetteShow.setHush(false,now);
    if(typeof silhouetteShow.setSongEnergy==='function')silhouetteShow.setSongEnergy(lastLevels,now,{open:true});
    if(mask)silhouetteShow.beat(now,mask|0);
    return {levels:lastLevels.slice(),mask:mask|0};
  },
  beat(now,tones,info){return silhouetteShow.beat(now==null?performance.now():now,tones,info);},
  setBloom(opts){
    const api=typeof NeuralDanceRings!=='undefined'?NeuralDanceRings:null;
    const next=api&&api.configureBloom?api.configureBloom(opts||{}):null;
    // Silhouette mode: bloom drives the dancers' inner glow + string bloom.
    {const b=next||opts||{};silhouetteShow.setTuning({bloomEnabled:b.enabled,bloomIntensity:b.intensity,bloomAura:b.aura});}
    try{if(next)localStorage.setItem('nd.bloom.v2',JSON.stringify(next));}catch{}
    document.querySelectorAll('[data-bloom]').forEach(button=>{const on=!next||next.enabled!==false;button.setAttribute('aria-pressed',on?'true':'false');button.textContent=on?'Bloom':'Bloom off';});
    still();
    return next;
  },
  applyShowCommand(command){
    if(!command)return;
    const action=command.action;
    if(action==='listen'){listenCommand(command.gesture===true);return;}
    if(action==='stop-listen'){stopListenCommand();return;}
    if(action==='start'){start();return;}
    if(action==='pause'){stop();return;}
    if(action==='clear-sim'||action==='sim-off'){clearSim();return;}
    if(action==='sim-seed'){seedSim();return;}
    if(action==='sim-on'){if(!sim.length)seedSim();return;}
    if(action==='add-sim'){addSimAt(+command.x||0,+command.y||0,command.type|0);return;}
    if(action==='toggle-light'){this.toggleLightMode();return;}
    if(action==='set-light-mode'){this.setLightMode(command.mode);return;}
    if(action==='set-draw-mode'){this.setDrawMode(command.mode);return;}
    if(action==='toggle-pattern'){this.setAlignPattern(root.dataset.stagePattern!=='1');return;}
    if(action==='toggle-bloom'){const cur=this.bloom();this.setBloom({enabled:!(cur&&cur.enabled!==false)});return;}
    if(command.bloomEnabled===true||command.bloomEnabled===false)this.setBloom({enabled:command.bloomEnabled,intensity:command.bloomIntensity,aura:command.bloomAura});
    if(command.insetsEnabled===true||command.insetsEnabled===false)this.setInsets(command.insetsEnabled);
    if(command.rippleEnabled===true||command.rippleEnabled===false||Number.isFinite(+command.rippleIntensity))this.setRipple({enabled:command.rippleEnabled,intensity:command.rippleIntensity});
    if(Number.isFinite(+command.perspectiveStrength))this.setPerspective(+command.perspectiveStrength);
  },
  async resumeMic(preferMuted){
    if(micState==='listening'&&!preferMuted)return true;
    if(micState==='muted'&&preferMuted)return true;
    if(micPending)return micState==='listening'||micState==='muted';
    micPending=true;
    try{await startListen();}finally{micPending=false;}
    if(micState!=='listening')return false;
    if(preferMuted)setMicMuted(true);
    return micState==='listening'||micState==='muted';
  }
};
try{const saved=JSON.parse(localStorage.getItem('nd.bloom.v2')||'');if(saved)root.neuralDance.setBloom(saved);}catch{}
document.querySelectorAll('[data-bloom]').forEach(button=>{button.addEventListener('click',()=>{root.neuralDance.applyShowCommand({action:'toggle-bloom'});});});
document.querySelectorAll('button[data-align-pattern]').forEach(button=>{button.addEventListener('click',()=>{root.neuralDance.applyShowCommand({action:'toggle-pattern'});});});
document.querySelectorAll('button[data-light-mode]').forEach(button=>{button.addEventListener('click',()=>{root.neuralDance.applyShowCommand({action:'toggle-light'});});});
paintLightMode();
root.dataset.roomReady='1';
})();
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootRoomLab);
  else bootRoomLab();
}
