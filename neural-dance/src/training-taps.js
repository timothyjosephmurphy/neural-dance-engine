// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Manual sticker taps on the debug camera become labeled examples:
// the camera frame, the tap, and whatever the detector had just reported.

import {applyHomography, homographyFromNormalized} from '../camera-markers.js';

export function cameraTapToStage(nx, ny, quad) {
  if (!Number.isFinite(+nx) || !Number.isFinite(+ny) || !quad || quad.length !== 4) return null;
  const H = homographyFromNormalized(quad, 1, 1);
  if (!H) return null;
  const at = applyHomography(H, +nx, +ny);
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  return {
    x: Math.min(1000, Math.max(0, at.x)),
    y: Math.min(620, Math.max(0, at.y))
  };
}

function cloneDetector(detector) {
  const source = detector && typeof detector === 'object' ? detector : {};
  let copy = {stickers: [], pink: [], markers: []};
  try { copy = JSON.parse(JSON.stringify({
    stickers: source.stickers || [],
    pink: source.pink || [],
    markers: source.markers || [],
    scan: source.scan || null
  })); } catch { /* keep the empty report */ }
  return copy;
}

export function createTrainingLog() {
  const examples = [];
  return {
    list() { return examples.map(item => ({...item, detector: cloneDetector(item.detector)})); },
    add(example) {
      if (!example) return null;
      const camera = example.camera || {};
      const stage = example.stage || {};
      if (!Number.isFinite(+camera.x) || !Number.isFinite(+camera.y)) return null;
      if (!Number.isFinite(+stage.x) || !Number.isFinite(+stage.y)) return null;
      const item = {
        at: Number.isFinite(+example.at) ? +example.at : Date.now(),
        camera: {x: +camera.x, y: +camera.y},
        stage: {x: +stage.x, y: +stage.y},
        detector: cloneDetector(example.detector),
        frame: typeof example.frame === 'string' ? example.frame : ''
      };
      examples.push(item);
      return item;
    },
    toJSON() {
      return {v: 1, kind: 'neural-dance-sticker-taps', examples: this.list()};
    },
    toZip() {
      const json = new TextEncoder().encode(JSON.stringify(this.toJSON()));
      const files = [{name: 'examples.json', data: json}];
      this.list().forEach((example, index) => {
        const bytes = dataUrlBytes(example.frame);
        if (bytes) files.push({name: 'frame-' + index + '.jpg', data: bytes});
      });
      return zipStore(files);
    }
  };
}

function dataUrlBytes(value) {
  if (typeof value !== 'string') return null;
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma < 0) return null;
  const body = value.slice(comma + 1);
  try {
    const binary = atob(body);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return {time, day};
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value & 0xffff, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

export function zipStore(files, date = new Date(2026, 10, 9, 12, 0, 0)) {
  const stamp = dosTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data || []);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    writeUint32(view, 0, 0x04034b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 8, 0);
    writeUint16(view, 10, stamp.time);
    writeUint16(view, 12, stamp.day);
    writeUint32(view, 14, crc);
    writeUint32(view, 18, data.length);
    writeUint32(view, 22, data.length);
    writeUint16(view, 26, nameBytes.length);
    local.set(nameBytes, 30);
    parts.push(local, data);
    const entry = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(entry.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, stamp.time);
    writeUint16(centralView, 14, stamp.day);
    writeUint32(centralView, 16, crc);
    writeUint32(centralView, 20, data.length);
    writeUint32(centralView, 24, data.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint32(centralView, 42, offset);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, offset);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const entry of central) {
    out.set(entry, cursor);
    cursor += entry.length;
  }
  out.set(end, cursor);
  return out;
}
