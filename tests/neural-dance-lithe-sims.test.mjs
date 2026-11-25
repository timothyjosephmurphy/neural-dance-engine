// Lithe unique sim silhouettes (TJ 5:18 PM).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dancerSilhouette,
  smoothClosedContour,
  uniqueDancerSilhouette,
  variationFor
} from '../neural-dance/src/silhouette-dance.js';
import {figureHeight, figureWidth, fullFigureContour, placeContour} from '../neural-dance/src/silhouette.js';

function contourSig(points) {
  return points.map(p => p.x.toFixed(2) + ':' + p.y.toFixed(2)).join('|');
}

test('N sims produce distinct lithe contours', () => {
  const N = 12;
  const sigs = new Set();
  const aspects = [];
  for (let id = 1; id <= N; id++) {
    const pts = uniqueDancerSilhouette(id);
    assert.ok(pts.length >= 60, 'smoothed outline has more vertices');
    sigs.add(contourSig(pts));
    const h = figureHeight(pts);
    const w = figureWidth(pts);
    aspects.push(h / Math.max(1e-6, w));
  }
  assert.equal(sigs.size, N, 'every sim contour is distinct');
  const base = dancerSilhouette();
  const baseAspect = figureHeight(base) / Math.max(1e-6, figureWidth(base));
  // Lithe: median aspect taller/slimmer than the blocky template.
  aspects.sort((a, b) => a - b);
  const med = aspects[aspects.length >> 1];
  assert.ok(med > baseAspect * 1.05, 'lithe figures are slenderer than the template (' + med.toFixed(2) + ' vs ' + baseAspect.toFixed(2) + ')');
});

test('smoothClosedContour softens a polygon without changing size much', () => {
  const raw = dancerSilhouette();
  const soft = smoothClosedContour(raw, 2);
  assert.ok(soft.length > raw.length);
  assert.ok(Math.abs(figureHeight(soft) - figureHeight(raw)) / figureHeight(raw) < 0.08);
});

test('fullFigureContour keeps sim height while preserving uniqueness', () => {
  const target = figureHeight(dancerSilhouette()) * 1.05;
  const a = fullFigureContour(null, 0, 0, target, 3);
  const b = fullFigureContour(null, 0, 0, target, 9);
  assert.ok(Math.abs(figureHeight(a) - target) < 1.5);
  assert.ok(Math.abs(figureHeight(b) - target) < 1.5);
  assert.notEqual(contourSig(a), contourSig(b));
});

test('variationFor gives each dancer its own motion phase', () => {
  const phases = new Set();
  for (let id = 1; id <= 8; id++) phases.add(variationFor(id).phase.toFixed(4));
  assert.ok(phases.size >= 6);
});
