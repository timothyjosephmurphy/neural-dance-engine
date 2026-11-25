// Long synthetic grooves with exact bar / phrase labels for groove learning
// (scripts/groove-eval.mjs). Kick / bass / snare / hats rendered with the
// Listen harness voices (tests/helpers/listen-sim.mjs), optional phone-mic sim.
//   node scripts/groove-synth.mjs <out-dir>
import {mkdirSync, writeFileSync} from 'node:fs';
import {render, SR} from '../tests/helpers/listen-sim.mjs';
import {writeWav16Mono, phoneMic, peakNormalize} from '../tests/helpers/listen-corpus.mjs';

// Patterns: sixteenth steps per bar for kick (k), bass (b), snare (s), hats (h).
export const PATTERNS = {
  house: {steps: 16, k: [0, 4, 8, 12], b: [2, 6, 10, 14], s: [4, 12], h: [2, 6, 10, 14]},
  rock: {steps: 16, k: [0, 8, 10], b: [0, 8, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14]},
  halftime: {steps: 16, k: [0, 10], b: [0, 10], s: [8], h: [0, 2, 4, 6, 8, 10, 12, 14, 3, 11]},
  hiphop: {steps: 16, k: [0, 6, 10], b: [0, 6, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14]},
  waltz: {steps: 12, k: [0], b: [0], s: [4, 8], h: [0, 2, 4, 6, 8, 10]},
  breaks: {steps: 16, k: [0, 10], b: [0, 3, 10], s: [4, 12, 15], h: [0, 2, 4, 6, 8, 10, 12, 14]}
};

// sections: [{bars, pattern, bpm0, bpm1?, swing?, drums?: false (breakdown: pad only)}]
export function composeSong(sections, {fills = true, crash = true, phrase = 8, seed = 5} = {}) {
  const ev = [], beats = [], downbeats = [], phrases = [];
  let t = 0.5, bar = 0;
  for (const sec of sections) {
    const pat = PATTERNS[sec.pattern], M = pat.steps / 4;
    for (let i = 0; i < sec.bars; i++, bar++) {
      const u = sec.bars > 1 ? i / (sec.bars - 1) : 0;
      const bpm = sec.bpm0 + ((sec.bpm1 || sec.bpm0) - sec.bpm0) * u;
      const beat = 60 / bpm;
      const sw = sec.swing || 0.5; // where the off-beat 8th lands inside the beat
      const at = s => { const j = Math.floor(s / 4), r = s % 4; const f = r === 2 ? sw : r === 1 ? sw / 2 : r === 3 ? sw + (1 - sw) / 2 : 0; return t + (j + f) * beat; };
      downbeats.push(t); for (let j = 0; j < M; j++) beats.push(t + j * beat);
      if (bar % phrase === 0) phrases.push(t);
      const lastOfPhrase = (bar % phrase) === phrase - 1;
      if (sec.drums !== false) {
        for (const s of pat.k) ev.push({band: 0, t: at(s)});
        for (const s of pat.b) ev.push({band: 1, t: at(s), freq: 98 + 12 * ((bar >> 1) % 3)});
        const fill = fills && lastOfPhrase;
        for (const s of pat.s) if (!(fill && s >= pat.steps - 4)) ev.push({band: 2, t: at(s)});
        if (fill) for (let s = pat.steps - 4; s < pat.steps; s++) ev.push({band: 2, t: at(s), gain: 0.7 + 0.1 * (s % 4)});
        for (const s of pat.h) ev.push({band: 3, t: at(s), gain: s % 4 === 0 ? 0.8 : 1});
        if (crash && bar % phrase === 0) { ev.push({band: 3, t: at(0), gain: 2.2}); ev.push({band: 3, t: at(0) + 0.03, gain: 1.6}); }
      }
      t += M * beat;
    }
  }
  return {events: ev, beats, downbeats, phrases, duration: t + 1};
}

export const SONGS = {
  'gs-house-124': {sections: [{bars: 40, pattern: 'house', bpm0: 124}]},
  'gs-rock-110': {sections: [{bars: 32, pattern: 'rock', bpm0: 110}]},
  'gs-halftime-140': {sections: [{bars: 40, pattern: 'halftime', bpm0: 140}]},
  'gs-hiphop-swing-92': {sections: [{bars: 28, pattern: 'hiphop', bpm0: 92, swing: 0.64}]},
  'gs-waltz-3-4-132': {sections: [{bars: 40, pattern: 'waltz', bpm0: 132}], meter: '3/4'},
  'gs-house-drift-120-128': {sections: [{bars: 40, pattern: 'house', bpm0: 120, bpm1: 128}]},
  'gs-breakdown-house-126': {sections: [{bars: 16, pattern: 'house', bpm0: 126}, {bars: 8, pattern: 'house', bpm0: 126, drums: false}, {bars: 16, pattern: 'house', bpm0: 126}]},
  'gs-change-rock-to-breaks': {sections: [{bars: 20, pattern: 'rock', bpm0: 112}, {bars: 24, pattern: 'breaks', bpm0: 128}]}
};

if (import.meta.url === 'file://' + process.argv[1]) {
  const out = process.argv[2]; mkdirSync(out, {recursive: true});
  for (const [id, spec] of Object.entries(SONGS)) {
    const song = composeSong(spec.sections);
    const pads = [];
    spec.sections.reduce((acc, s) => acc, 0);
    for (const phone of [false, true]) {
      let audio = render(song.events, song.duration, {pad: [[0, song.duration]], seed: 11});
      if (phone) audio = phoneMic(audio, SR, {seed: 13});
      peakNormalize(audio, 0.9);
      const name = id + (phone ? '-phone' : '');
      writeWav16Mono(`${out}/${name}.wav`, audio, SR);
      writeFileSync(`${out}/${name}.json`, JSON.stringify({schema: 'nd-listen-corpus-v1', id: name, wav: name + '.wav', kind: 'synthetic', meter: {label: spec.meter || '4/4'},
        tempo: {kind: 'sections', sections: spec.sections}, beats: song.beats, downbeats: song.downbeats, phrases: song.phrases, duration: song.duration,
        provenance: {beats: 'synthetic-exact', downbeats: 'synthetic-exact'}}));
      console.log(name, song.duration.toFixed(1) + 's');
    }
  }
}
