// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Sticker scan memory. Clear drops the floor reference, the latch book, and
// the person-pause phase together. A person or a non-blank frame is never
// stored as the floor, and sticker-sized holes in a real blank are filled so
// the sticker that was present at capture is still found afterwards.

import {blankFrameVerified, buildFloorReference, createScanBook, scanBlankFrame} from './blank-scan.js';
import {createPersonOcclusion, personInFrame} from './person-occlusion.js';

export function createStickerScan({sensitivity = 0.5, hits, misses, latchedMisses, autoLatchedMisses, radius} = {}) {
  const bookOpts = {};
  if (hits != null) bookOpts.hits = hits;
  if (misses != null) bookOpts.misses = misses;
  if (latchedMisses != null) bookOpts.latchedMisses = latchedMisses;
  if (autoLatchedMisses != null) bookOpts.autoLatchedMisses = autoLatchedMisses;
  if (radius != null) bookOpts.radius = radius;
  const book = createScanBook(bookOpts);
  const occlusion = createPersonOcclusion();
  let sense = Math.min(1, Math.max(0, +sensitivity || 0.5));
  let reference = {white: null, black: null};

  function lumFor(mode, width, height) {
    const saved = mode === 'white' ? reference.white : reference.black;
    if (!saved || saved.width !== (width | 0) || saved.height !== (height | 0)) return null;
    return saved.lum;
  }

  return {
    markers() { return book.markers(); },
    reference(mode) { return mode === 'white' ? reference.white : reference.black; },
    referenceLum(mode, width, height) { return lumFor(mode, width, height); },
    setSensitivity(value) {
      if (Number.isFinite(+value)) sense = Math.min(1, Math.max(0, +value));
    },
    resetBook() { book.reset(); },
    restore(list) { return book.restore(list); },
    observe(points, opts) { return book.observe(points, opts); },
    clear() {
      book.reset();
      occlusion.reset();
      reference = {white: null, black: null};
    },
    storeReference(rgba, width, height, mode) {
      const kind = mode === 'white' ? 'white' : 'black';
      const built = buildFloorReference(rgba, width, height, kind);
      if (!built.ok) return built;
      reference[kind] = {lum: built.lum, width: built.width, height: built.height};
      return built;
    },
    observePerson(rgba, width, height, now = 0) {
      const bright = blankFrameVerified(rgba, width, height, 'white');
      const ref = lumFor(bright ? 'white' : 'black', width, height);
      const person = personInFrame(rgba, width, height, {sensitivity: 0.35, reference: ref});
      const decision = occlusion.observe({person, stickers: book.markers(), now});
      return {person, decision, stored: false};
    },
    observeBlank(rgba, width, height, mode) {
      const kind = mode === 'white' ? 'white' : 'black';
      if (!blankFrameVerified(rgba, width, height, kind)) {
        return {accepted: false, blobs: [], markers: book.markers()};
      }
      const blobs = scanBlankFrame(rgba, width, height, {
        settled: true,
        mode: kind,
        sensitivity: sense,
        reference: lumFor(kind, width, height)
      });
      const points = blobs.map(blob => {
        const point = {x: blob.x, y: blob.y, kind: 'sticker'};
        if (blob.contour) point.contour = blob.contour;
        return point;
      });
      const markers = book.observe(points);
      return {accepted: true, blobs, markers};
    }
  };
}
