// Download a small set of CC0 real drum loops, convert to 48 kHz mono WAV,
// and (optionally) label them with tools/listen-label/label.py.
//
//   node scripts/listen-corpus-fetch-real.mjs
//   node scripts/listen-corpus-fetch-real.mjs --skip-label
//
// Sources and licenses are recorded in tests/fixtures/listen-corpus/real/SOURCES.md
// and in each clip's JSON. We use each Freesound HQ preview (the original WAV
// download requires a Freesound account) and convert with ffmpeg.
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {sha256File, SCHEMA} from '../tests/helpers/listen-corpus.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'tests/fixtures/listen-corpus/real');
const PYTHON = process.env.ND_LABEL_PYTHON || '.venv-listen-label/bin/python';
const LABEL = join(root, 'tools/listen-label/label.py');
const skipLabel = process.argv.includes('--skip-label');

// All of these were verified CC0 on their Freesound pages (2026-11-09).
export const TRACKS = [
  {
    id: 'real-marvman-3-4-a',
    author: 'marvman',
    name: '3-4 a.wav',
    freesoundId: 38353,
    preview: 'https://cdn.freesound.org/previews/38/38353_111012-hq.mp3',
    page: 'https://freesound.org/people/marvman/sounds/38353/',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    meter: '3/4',
    grouping: '3',
    notes: 'Author-described 3/4 drum pattern, Freesound pack “Drum patterns 2”.'
  },
  {
    id: 'real-marvman-6-8-a',
    author: 'marvman',
    name: '6-8 a.wav',
    freesoundId: 38360,
    preview: 'https://cdn.freesound.org/previews/38/38360_111012-hq.mp3',
    page: 'https://freesound.org/people/marvman/sounds/38360/',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    meter: '6/8',
    grouping: '3,3',
    notes: 'Author-described 6/8 drum pattern, Freesound pack “Drum patterns 2”.'
  },
  {
    id: 'real-marvman-5-4-b',
    author: 'marvman',
    name: '5-4 b.wav',
    freesoundId: 38359,
    preview: 'https://cdn.freesound.org/previews/38/38359_111012-hq.mp3',
    page: 'https://freesound.org/people/marvman/sounds/38359/',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    meter: '5/4',
    grouping: '3,2',
    notes: 'Author-described 5/4 drum pattern, Freesound pack “Drum patterns 2”.'
  },
  {
    id: 'real-marvman-7-8-b2',
    author: 'marvman',
    name: '7-4 b2.wav',
    freesoundId: 38364,
    preview: 'https://cdn.freesound.org/previews/38/38364_111012-hq.mp3',
    page: 'https://freesound.org/people/marvman/sounds/38364/',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    meter: '7/8',
    grouping: '3,2,2',
    notes: 'Filename says 7-4; the author description is “A drum pattern in 7/8 time.” Pack “Drum patterns 2”.'
  },
  {
    id: 'real-stomachache-110-shuffle',
    author: 'stomachache',
    name: '110drumsshuffle.WAV',
    freesoundId: 139060,
    preview: 'https://cdn.freesound.org/previews/139/139060_177850-hq.mp3',
    page: 'https://freesound.org/people/stomachache/sounds/139060/',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    meter: '4/4',
    grouping: '2,2',
    notes: 'Author-described “triplet drum beat at 110 bpm, heavy swing feel.” Used as a real swing/shuffle test. The author notes the timing is not the most accurate.'
  }
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {stdio: 'inherit'});
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code)));
  });
}

async function download(url, dest) {
  const res = await fetch(url, {headers: {'user-agent': 'NeuralDanceCorpusBot/1.0 (research corpus; tj@tjm.art)'}});
  if (!res.ok) throw new Error('GET ' + url + ' -> ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

const SOURCES_MD = `# Real-recording sources

All audio in this folder is used under a free license, converted from the
official Freesound HQ preview to 48 kHz 16-bit mono WAV. Original pages were
re-checked on 9 Nov 2026 (America/Los_Angeles).

| id | author | work | license | page | announced meter |
| --- | --- | --- | --- | --- | --- |
${TRACKS.map(t => `| \`${t.id}\` | ${t.author} | ${t.name} | ${t.license} | ${t.page} | ${t.meter} |`).join('\n')}

Attribution (not required by CC0, recorded anyway):

${TRACKS.map(t => `- "${t.name}" by ${t.author} (Freesound #${t.freesoundId}), CC0 1.0. ${t.page}`).join('\n')}

The committed WAV is a transcode of the Freesound HQ preview, not the
original uploaded file (Freesound requires a login for original downloads).
Beat / downbeat times in the sibling \`.json\` files come from the offline
labeler (\`tools/listen-label/label.py\`, madmom DBN) with the announced meter
taken from the author’s description. Per-band hit times are envelope-peak
proposals, not hand-audited exact truth — see \`provenance.bands\`.
`;

async function main() {
  await mkdir(outDir, {recursive: true});
  await writeFile(join(outDir, 'SOURCES.md'), SOURCES_MD);
  const entries = [];
  for (const t of TRACKS) {
    const mp3 = join(outDir, t.id + '.preview.mp3');
    const wav = join(outDir, t.id + '.wav');
    console.log('fetch', t.id, t.preview);
    const n = await download(t.preview, mp3);
    console.log('  downloaded', n, 'bytes');
    await run('ffmpeg', ['-y', '-i', mp3, '-ac', '1', '-ar', '48000', '-sample_fmt', 's16', '-hide_banner', '-loglevel', 'error', wav]);
    const sha = await sha256File(wav);
    console.log('  wav sha256', sha);
    if (!skipLabel) {
      await run(PYTHON, [
        LABEL, wav,
        '--id', t.id,
        '--rel-wav', 'real/' + t.id + '.wav',
        '--meter', t.meter,
        '--grouping', t.grouping,
        '--license', t.license,
        '--license-url', t.licenseUrl,
        '--source-name', t.name,
        '--source-author', t.author,
        '--source-url', t.page,
        '--source-notes', t.notes + ' Audio is the Freesound HQ preview, transcoded to 48 kHz mono WAV.',
        '--notes', t.notes,
        '-o', join(outDir, t.id + '.json')
      ]);
    }
    entries.push({id: t.id, wav: 'real/' + t.id + '.wav', json: 'real/' + t.id + '.json', kind: 'real', meter: t.meter, sha256: sha, license: t.license, source: t.page});
  }

  const manPath = join(root, 'tests/fixtures/listen-corpus/manifest.json');
  let man = {schema: SCHEMA, clips: []};
  try { man = JSON.parse(await readFile(manPath, 'utf8')); } catch {}
  const syn = (man.clips || []).filter(c => c.kind !== 'real' && !(c.wav || '').startsWith('real/'));
  man.clips = syn.concat(entries);
  await writeFile(manPath, JSON.stringify(man, null, 2) + '\n');
  console.log('updated manifest with', entries.length, 'real clips');
}

if (import.meta.url === 'file://' + process.argv[1]) main();
