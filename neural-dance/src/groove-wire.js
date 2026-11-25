// ND Listen v2 glue (TJ Nov 12): feeds the groove learner from the live
// chain and, only while it is confident, hands its bar / phrase / accents to
// the entrained beat clock. Below confidence nothing changes: the dancers
// get exactly today's entrain output (the show-safe fallback).
//
//   const wire = createGrooveWire({groove: createGrooveLearner(), entrain});
//   wire.feed(now, {gateOpen, bandInfo, gt: gtState, entrainActive});   // every frame, before entrain.step
//   wire.decorate(now, entrainOut);                                     // after entrain.step, on the entrain path
//
// Kept apart from room-lab's long Listen line so PR #113 (build-and-drop)
// merges cleanly; its section events go to groove.sectionEvent().

export const GROOVE_ACCENT_FLOOR = 0.7; // accent on a step the groove says is empty (silhouette clamps to >= 0.5)

export function createGrooveWire({groove, entrain = null, phrase = true} = {}) {
  const onT = new Float64Array(4), str = new Float64Array(4).fill(1);
  const ph = {start: false, barInPhrase: -1, phraseBars: 8, bar: -1, confidence: 0};
  const st = {applied: false, down: -1, source: 'none', phraseStarts: 0, overrides: 0};

  function feed(now, {gateOpen = false, bandInfo = null, gt = null, entrainActive = false} = {}) {
    let P = 0, A = 0;
    if (entrain && entrainActive && entrain.state.P > 0) { P = entrain.state.P; A = entrain.state.anchor; st.source = 'entrain'; }
    else if (gt && gt.locked && gt.period > 0) { P = gt.period; A = gt.next; st.source = 'tempo'; }
    else st.source = 'none';
    const on = gateOpen && bandInfo ? bandInfo.onsets | 0 : 0;
    if (on) for (let b = 0; b < 4; b++) {
      if (!(on & (1 << b))) continue;
      onT[b] = bandInfo.onsetTime ? +bandInfo.onsetTime[b] : now;
      const thr = bandInfo.threshold ? +bandInfo.threshold[b] : 0;
      str[b] = thr > 0 && bandInfo.flux ? Math.min(4, bandInfo.flux[b] / thr) : 1;
    }
    const o = groove.step(now, {P, anchor: A, gateOpen: !!gateOpen, onsets: on, onsetTime: onT, strength: str});
    // Bar start for the entrain clock: only confident, 4/4, clock on the music's beats.
    let down = -1;
    if (entrain && st.source === 'entrain' && o.active && o.meter === 4) {
      const k = Math.round((now - entrain.state.anchor) / entrain.state.P);
      const bb = groove.barBeatAt(entrain.state.anchor + k * entrain.state.P);
      if (bb >= 0) down = ((k - bb) % 4 + 4) % 4;
    }
    st.down = down;
    if (entrain && entrain.setDownbeat && entrain.state.extDown !== down) entrain.setDownbeat(down); // (entrain.reset() clears it)
    st.applied = down >= 0;
    return o;
  }

  // Phrase start + groove accents onto this frame's entrain beat info.
  function decorate(now, eo) {
    ph.start = false;
    if (!eo || !eo.info) return eo;
    const info = eo.info;
    if (!st.applied) { info.phrase = null; return eo; }
    st.overrides++;
    const o = groove.state;
    const bb = info.barBeat;
    if (eo.mask) for (let b = 0; b < 4; b++) {
      if (!(eo.mask & (1 << b)) || info.pos[b] < 0) continue;
      const n = info.cyc[b] > 4 ? Math.round(info.cyc[b] / 4) : 1, sub = n > 1 ? info.pos[b] % n : 0;
      const e = groove.expect(b, bb, n === 2 ? sub * 2 : n === 4 ? sub : 0);
      info.accent[b] = GROOVE_ACCENT_FLOOR + (1 - GROOVE_ACCENT_FLOOR) * Math.min(1, e);
    }
    const bip = groove.barInPhraseAt(entrain ? entrain.state.beatAt : now);
    ph.barInPhrase = bip; ph.phraseBars = o.phraseBars; ph.bar = info.bar; ph.confidence = o.confidence;
    if (phrase && eo.downbeat && bb === 0 && bip === 0) { ph.start = true; st.phraseStarts++; }
    info.phrase = ph;
    return eo;
  }

  function reset() { groove.reset(); st.down = -1; st.applied = false; st.source = 'none'; if (entrain && entrain.setDownbeat) entrain.setDownbeat(-1); }
  function snapshot() {
    const g = groove.snapshot();
    return {...g, applied: st.applied, source: st.source, entrainDownbeat: st.down, phraseStarts: st.phraseStarts};
  }
  return {feed, decorate, reset, snapshot, state: st, phrase: ph, groove};
}
