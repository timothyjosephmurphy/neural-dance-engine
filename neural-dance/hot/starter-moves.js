// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Hot module (crowd pages): seeds the shared dance library. Files in
// neural-dance/hot/ load without a page reload when a build changes only
// them (src/crowd-hot.js). Add a move or an event here (or a new file
// next to this one) during the show: build + deploy, and the projector
// picks it up within ~15 s behind the psychedelic wipe. Keep imports to
// the /neural-dance/src/ registries so module identity is shared.

import {registerMove} from '../src/crowd-moves.js';

for (const m of [
  {id: 'starter-raise-the-roof', name: 'Raise the Roof', by: '@neuraldance', steps: [{p: 'pump', beats: 2}, {p: 'step', beats: 2, side: -1}, {p: 'pump', beats: 2}, {p: 'step', beats: 2, side: 1}]},
  {id: 'starter-drop-and-pop', name: 'Drop and Pop', by: '@neuraldance', steps: [{p: 'squat', beats: 2}, {p: 'jump', beats: 2}, {p: 'clap-high', beats: 2}, {p: 'shimmy', beats: 2}]},
  {id: 'starter-robot-walk', name: 'Robot Walk', by: '@neuraldance', steps: [{p: 'robot', beats: 2, side: -1}, {p: 'robot', beats: 2, side: 1}, {p: 'point', beats: 2}, {p: 'pose', beats: 2}]}
]) registerMove(m);
