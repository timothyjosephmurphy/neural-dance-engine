// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// AudioWorklet tap for the neural beat tracker: batches mic samples into
// 2048-sample blocks stamped with AudioContext time and posts them out.
// Never touches the audio graph's output.
class NdBeatCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.on = true; this.port.onmessage = e => { if (e.data && e.data.type === 'stop') this.on = false; }; }
  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          const t = (currentFrame + i + 1 - this.buf.length) / sampleRate;
          this.port.postMessage({type: 'audio', t, data: this.buf}, [this.buf.buffer]);
          this.buf = new Float32Array(2048); this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('nd-beat-capture', NdBeatCapture);
