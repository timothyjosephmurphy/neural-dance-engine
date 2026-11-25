// Load a live debug capture into flat arrays (no secrets in captures; key stripped by record.mjs).
import {readFileSync} from 'node:fs';
export function load(file) {
  const L = readFileSync(file, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const seen = new Set(), A = [], F = [], hits = [new Set(), new Set(), new Set(), new Set()], events = [];
  for (const x of L) {
    if (x.event) { events.push(x); continue; }
    const m = x.m; if (!m) continue;
    if (m.type === 'audio') for (const s of m.samples) {
      if (seen.has(s.seq + ':' + s.t)) continue; seen.add(s.seq + ':' + s.t);
      A.push({...s, rx: x.rx});
      if (s.hits) s.hits.forEach((h, b) => h.forEach(t => hits[b].add(t)));
    }
    if (m.type === 'frame') {
      const t = m.telemetry; F.push({rx: x.rx, ...t});
      if (t.listen && t.listen.hits) t.listen.hits.forEach((h, b) => h.forEach(tt => hits[b].add(tt)));
    }
  }
  A.sort((a, b) => a.t - b.t);
  const H = hits.map(s => [...s].sort((a, b) => a - b));
  // map page clock (perf.now ms) <-> wall clock via frames (listen.now vs telemetry.t)
  const off = F.filter(f => f.listen && f.listen.now).map(f => f.t - f.listen.now);
  off.sort((a, b) => a - b);
  const wallOff = off.length ? off[off.length >> 1] : 0;
  return {A, F, H, events, wallOff};
}
