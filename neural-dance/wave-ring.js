// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Neural Dance sound-wave rings.
// Each dancer's bloom is a circle whose radius follows the time-domain
// waveform of that dancer's band: kick, bass, snare, or hi-hat.
// The page taps the live source (room microphone, or the mural tone bus)
// through a highpass/lowpass pair into an AnalyserNode. Meter AGC is not
// applied here; it still scales only the Room music spectrum bars.
(function (root) {
  const BAND_HZ = [[40, 120], [120, 300], [300, 2500], [5000, 14000]];

  // Room-mic bands sit around RMS 0.001–0.015 after the 4th-order filters.
  // A non-gated source (synthetic oscillator, mural tone bus) is open.
  // Listen passes the silence gate: a closed gate, or a band at the hiss
  // floor, draws a calm circle instead of jitter.
  function ringGateOpen(options) {
    const opts = options || {};
    if (opts.gateOpen === false) return false;
    if (opts.gate && opts.gate.open !== true) return false;
    return true;
  }

  function ringSens(options) {
    const opts = options || {};
    if (opts.sens == null && opts.bandSens == null) return 1;
    const raw = opts.sens != null ? +opts.sens : +opts.bandSens;
    if (!Number.isFinite(raw) || !(raw > 0)) return 0;
    return raw > 3 ? 3 : raw;
  }

  function ringGain(env, options) {
    if (!ringGateOpen(options)) return 0;
    if (!(env > 0.0005)) return 0;
    const sens = ringSens(options);
    if (!(sens > 0)) return 0;
    return Math.min(75, 0.78 / env) * sens;
  }

  // Soft-limit each sample so a clap cannot invert the ring or leave the stage.
  function waveExcursion(sample, gain) {
    const x = (+sample || 0) * (+gain || 0);
    if (!Number.isFinite(x) || x === 0) return 0;
    const y = 0.85 * Math.tanh(x / 0.85);
    return Math.max(-0.85, Math.min(0.85, y));
  }

  // Energy bloom for a waveform contour. No canvas shadow: a cached radial sprite
  // is the soft aura, then a translucent ribbon and a thin crest, all additive.
  // bloomStroke remains the Path2D entry. paintEnergyBloom takes the points so
  // the aura can be stamped without reading pixels back.
  const bloom = {enabled: true, intensity: 0.18, aura: 22};
  let whiteSprite = null;
  const tinted = new Map();

  function makeCanvas(size) {
    if (typeof OffscreenCanvas === 'function') {
      try { return new OffscreenCanvas(size, size); } catch (e) {}
    }
    if (typeof document !== 'undefined' && document.createElement) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      return canvas;
    }
    return null;
  }

  function auraSprite() {
    if (whiteSprite) return whiteSprite;
    const canvas = makeCanvas(48);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createRadialGradient(24, 24, 0, 24, 24, 24);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 48, 48);
    whiteSprite = canvas;
    return whiteSprite;
  }

  function spriteFor(color) {
    const key = color || '#fff';
    const cached = tinted.get(key);
    if (cached) return cached;
    const base = auraSprite();
    if (!base) return null;
    const canvas = makeCanvas(48);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = key;
    ctx.fillRect(0, 0, 48, 48);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(base, 0, 0);
    tinted.set(key, canvas);
    if (tinted.size > 12) tinted.delete(tinted.keys().next().value);
    return canvas;
  }

  function clampBloom(value, lo, hi, fallback) {
    const n = +value;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function configureBloom(opts) {
    const next = opts || {};
    if (next.enabled === true || next.enabled === false) bloom.enabled = next.enabled;
    if (next.intensity != null) bloom.intensity = clampBloom(next.intensity, 0.05, 2, bloom.intensity);
    if (next.aura != null) bloom.aura = clampBloom(next.aura, 8, 64, bloom.aura);
    return {enabled: bloom.enabled, intensity: bloom.intensity, aura: bloom.aura};
  }

  function tracePoints(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }

  function strokeLayer(ctx, draw, color, alpha, width) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color || '#fff';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    draw();
  }

  // The outline from before blooms: a soft outer stroke and a crisp crest.
  function outlineStroke(ctx, draw, color, low) {
    if (!ctx || !draw) return;
    ctx.save();
    strokeLayer(ctx, draw, color, 0.22, low ? 6 : 11);
    strokeLayer(ctx, draw, color, 0.92, 2.5);
    ctx.restore();
  }

  // soft (0-1] tones one bloom down: intensity x soft, aura width x soft
  // (min 6), crest thinner, no sprite stamps. 1 is the original look.
  function paintEnergyBloom(ctx, points, color, low, soft) {
    if (!ctx || !points || points.length < 2) return;
    const k = Number.isFinite(+soft) && +soft > 0 ? Math.min(1, +soft) : 1;
    const draw = () => { tracePoints(ctx, points); ctx.stroke(); };
    if (!bloom.enabled) {
      outlineStroke(ctx, draw, color, low);
      return;
    }
    const intensity = bloom.intensity * k;
    const baseAura = low ? Math.max(8, bloom.aura * 0.65) : bloom.aura;
    const aura = k < 1 ? Math.max(6, baseAura * k) : baseAura;
    const crest = k < 1 ? Math.max(1.25, 2.5 * (0.4 + 0.6 * k)) : 2.5;
    const sprite = spriteFor(color || '#fff');
    ctx.save();
    // Toned-down blooms (silhouettes) skip the sprite stamps: a 53 px radial
    // stamp on every outline point smeared a sticker-sized shape into a blob.
    if (sprite && k >= 1) {
      const stamp = low ? 12 : 28;
      const step = Math.max(1, Math.ceil(points.length / stamp));
      const size = aura * 2.4;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.55, 0.2 * intensity);
      for (let i = 0; i < points.length; i += step) {
        const p = points[i];
        ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
      }
    }
    strokeLayer(ctx, draw, color, Math.min(0.34, 0.08 * intensity), aura);
    strokeLayer(ctx, draw, color, Math.min(0.7, 0.3 * intensity), Math.max(3.5, aura * 0.42));
    strokeLayer(ctx, draw, color, Math.min(0.95, 0.78 * intensity), crest);
    ctx.lineWidth = 2.5;
    ctx.restore();
  }

  function bloomStroke(ctx, path, color, low) {
    if (!ctx || !path) return;
    // Path2D has no vertices, so this path skips the sprite stamps.
    const paint = () => { ctx.stroke(path); };
    if (!bloom.enabled) {
      ctx.save();
      strokeLayer(ctx, paint, color, 0.22, low ? 6 : 11);
      strokeLayer(ctx, paint, color, 0.92, 2.5);
      ctx.restore();
      return;
    }
    const aura = low ? Math.max(8, bloom.aura * 0.65) : bloom.aura;
    const intensity = bloom.intensity;
    ctx.save();
    strokeLayer(ctx, paint, color, Math.min(0.34, 0.08 * intensity), aura);
    strokeLayer(ctx, paint, color, Math.min(0.7, 0.3 * intensity), Math.max(3.5, aura * 0.42));
    strokeLayer(ctx, paint, color, Math.min(0.95, 0.78 * intensity), 2.5);
    ctx.restore();
  }

  function radialWavePoint(cx, cy, radius, angle, sample) {
    const s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    const r = radius * (1 + s * 0.85);
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  }

  function createSession() {
    const waves = [0, 1, 2, 3].map(() => new Float32Array(512));
    const env = [0, 0, 0, 0];
    let nodes = [];
    let analysers = [null, null, null, null];
    let bound = null;

    function release() {
      for (const node of nodes) {
        try { node.disconnect(); } catch (e) {}
      }
      nodes = [];
      analysers = [null, null, null, null];
      bound = null;
      for (let k = 0; k < 4; k++) {
        waves[k].fill(0);
        env[k] = 0;
      }
    }

    function connect(ac, source) {
      if (!ac || !source) {
        release();
        return;
      }
      if (bound === source) return;
      release();
      const nyq = ac.sampleRate * 0.49;
      for (let k = 0; k < 4; k++) {
        let lo = BAND_HZ[k][0];
        let hi = BAND_HZ[k][1];
        if (!(lo < nyq)) continue;
        if (hi > nyq) hi = nyq;
        const hp = ac.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = lo;
        hp.Q.value = 0.7071;
        const hp2 = ac.createBiquadFilter();
        hp2.type = 'highpass';
        hp2.frequency.value = lo;
        hp2.Q.value = 0.7071;
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.max(lo + 1, hi);
        lp.Q.value = 0.7071;
        const lp2 = ac.createBiquadFilter();
        lp2.type = 'lowpass';
        lp2.frequency.value = Math.max(lo + 1, hi);
        lp2.Q.value = 0.7071;
        const an = ac.createAnalyser();
        an.fftSize = 512;
        an.smoothingTimeConstant = 0;
        source.connect(hp);
        hp.connect(hp2);
        hp2.connect(lp);
        lp.connect(lp2);
        lp2.connect(an);
        nodes.push(hp, hp2, lp, lp2, an);
        analysers[k] = an;
      }
      bound = source;
    }

    function sample(dt) {
      const step = Math.max(0.001, Math.min(0.1, dt || 0.033));
      for (let k = 0; k < 4; k++) {
        const an = analysers[k];
        const w = waves[k];
        if (!an) {
          w.fill(0);
          env[k] = 0;
          continue;
        }
        an.getFloatTimeDomainData(w);
        let sum = 0;
        for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
        const rms = Math.sqrt(sum / w.length);
        const tau = rms > env[k] ? 0.08 : 0.45;
        env[k] += (rms - env[k]) * (1 - Math.exp(-step / tau));
      }
    }

    function stroke(ctx, x, y, radius, band, color, low) {
      const w = waves[band];
      if (!w || !(radius > 0)) {
        session.rippling = false;
        return;
      }
      const sens = typeof session.sensAt === 'function' ? session.sensAt(band) : undefined;
      const gain = ringGain(env[band] || 0, {gate: session.gate, sens});
      const rippling = !low && gain > 0;
      session.rippling = rippling;
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = color || '#fff';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (!rippling) {
        ctx.lineWidth = 1.6;
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return;
      }
      const n = w.length;
      const stepN = low ? Math.max(1, Math.floor(n / 48)) : Math.max(1, Math.floor(n / 96));
      const points = [];
      for (let i = 0; i < n; i += stepN) {
        const excursion = waveExcursion(w[i], gain);
        const p = radialWavePoint(x, y, radius, (i / n) * Math.PI * 2, excursion / 0.85);
        points.push({x: p[0], y: p[1]});
      }
      ctx.restore();
      paintEnergyBloom(ctx, points, color, low);
    }

    // Read-only time-domain samples for silhouette pulses. Callers must not write the buffer.
    function waveform(band) {
      const index = band | 0;
      if (index < 0 || index > 3) return null;
      return waves[index];
    }

    const session = {connect, release, sample, stroke, waveform, gate: null, sensAt: null, rippling: false};
    return session;
  }

  root.NeuralDanceRings = {BAND_HZ, ringGain, ringSens, waveExcursion, radialWavePoint, bloomStroke, paintEnergyBloom, configureBloom, createSession};
})(typeof window !== 'undefined' ? window : globalThis);
