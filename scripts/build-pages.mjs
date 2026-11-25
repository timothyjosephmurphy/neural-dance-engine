// Build Neural Dance pages and assets into dist/assets.
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile, cp, readdir} from 'node:fs/promises';
import {dirname, join, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist/assets');
const assetExt = /\.(?:html|css|js|mjs|json|jpg|jpeg|png|webp|gif|svg|ico|wasm|onnx|webmanifest)$/i;

function attrs(source) {
  const out = {};
  for (const match of source.matchAll(/([:\w-]+)(?:\s*=\s*"([^"]*)")?/g)) {
    out[match[1]] = match[2] === undefined ? true : match[2];
  }
  return out;
}

function baseLayout(source) {
  const tag = attrs(source);
  const manifest = tag.manifestHref || '/site.webmanifest';
  const standalone = tag.standalone === true || tag.standalone === 'true';
  const title = tag.appleTitle || 'Neural Dance';
  const theme = tag.themeColor || (standalone ? '#070a12' : '');
  const install = standalone ? `
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${title}" />
    ${theme ? `<meta name="theme-color" content="${theme}" />` : ''}
    <script>
      if (window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) {
        document.documentElement.classList.add('nd-standalone');
      }
    </script>
    <link rel="stylesheet" href="/neural-dance/standalone.css" />
    <script type="module" src="/neural-dance/standalone.js"></script>` : '';
  return `<link rel="icon" href="/favicon.ico?v=2" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=2" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=2" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />
<link rel="manifest" href="${manifest}" />${install}`;
}

export function readBuildVersion() {
  const fromEnv = process.env.ND_BUILD_VERSION && String(process.env.ND_BUILD_VERSION).trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  } catch {
    return 'dev';
  }
}

export function stampBuild(html, version) {
  return String(html).replaceAll('__ND_BUILD__', version || 'dev');
}

export function renderPage(source, header) {
  const body = source.replace(/^---[\s\S]*?---\n/, '');
  return body
    .replace(/<BaseLayout\b([^>]*)\/?>/g, (_, raw) => baseLayout(raw))
    .replace(/<SiteHeader\s*\/>/g, header)
    .replace(/\sis:inline/g, '');
}

async function copyTree(from, to) {
  await mkdir(to, {recursive: true});
  for (const entry of await readdir(from, {withFileTypes: true})) {
    if (entry.name.startsWith('.') || entry.name === 'build.sh') continue;
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.name === 'src') {
      await mkdir(dest, {recursive: true});
      for (const child of await readdir(src, {withFileTypes: true})) {
        if (child.isFile() && child.name.endsWith('.js')) await cp(join(src, child.name), join(dest, child.name));
      }
      continue;
    }
    if (entry.isDirectory()) await copyTree(src, dest);
    else if (assetExt.test(extname(entry.name)) || entry.name.endsWith('.webmanifest')) await cp(src, dest);
  }
}

export const CROWD_TITLES = {demo: 'Neural Dance Demo', show: 'Neural Dance Show'};
export function crowdPage(liveHtml, mode) {
  if (!CROWD_TITLES[mode]) throw new Error('Unknown crowd mode ' + mode);
  let html = String(liveHtml)
    .replace(/<title>[^<]*<\/title>/, `<title>${CROWD_TITLES[mode]} | TJ Murphy</title>`)
    .replace(/<body class="([^"]*)">/, (_, cls) => `<body class="${cls} nd-crowd" data-nd-crowd="${mode}">`);
  if (!html.includes(`data-nd-crowd="${mode}"`)) throw new Error('Crowd page body not found');
  html = html.replace('</body>', `<script type="module" src="/neural-dance/crowd-page.js"></script>\n</body>`);
  return html;
}

// Phone remote for the crowd pages (studio key, same relay as /debug/).
export function crowdRemotePage(mode, version) {
  if (!CROWD_TITLES[mode]) throw new Error('Unknown crowd mode ' + mode);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0b0d14">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>${CROWD_TITLES[mode]} Remote | TJ Murphy</title>
<meta name="nd-build" content="${version || 'dev'}">
</head>
<body data-nd-remote="${mode}">
<main id="nd-remote" aria-live="polite"><p>Loading remote…</p></main>
<script type="module" src="/neural-dance/crowd-remote.js"></script>
</body>
</html>
`;
}

// Hot-update manifest (neural-dance/src/crowd-hot.js): `core` hashes every
// shipped source that is not a hot module; `hot` maps each
// neural-dance/hot/<name>.js to its own hash. The projector hot-loads when
// only `hot` changed and does a seamless reload when `core` changed.
async function listFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'test' && e.name !== 'node_modules') out.push(...await listFiles(p)); }
    else if (/\.(?:js|mjs|html|astro|css)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}
export async function hotManifest() {
  const {createHash} = await import('node:crypto');
  const hotDir = join(root, 'neural-dance/hot');
  const core = createHash('sha256');
  for (const base of ['neural-dance', 'src', 'static/neural-dance', 'scripts/build-pages.mjs']) {
    const files = base.endsWith('.mjs') ? [join(root, base)] : await listFiles(join(root, base));
    for (const f of files) {
      if (f.startsWith(hotDir + '/')) continue;
      core.update(f.slice(root.length)); core.update(await readFile(f));
    }
  }
  const hot = {};
  for (const f of await listFiles(hotDir)) {
    const name = f.slice(hotDir.length + 1).replace(/\.js$/, '');
    if (/^[\w-]{1,40}$/.test(name)) hot[name] = createHash('sha256').update(await readFile(f)).digest('hex').slice(0, 12);
  }
  return {core: core.digest('hex').slice(0, 12), hot};
}

export async function buildPages() {
  const version = readBuildVersion();
  const header = (await readFile(join(root, 'src/components/SiteHeader.astro'), 'utf8')).replace(/\sis:inline/g, '');
  const pages = [
    ['src/pages/neural-dance/index.astro', 'neural-dance/index.html'],
    ['src/pages/neural-dance/live/index.astro', 'neural-dance/live/index.html'],
    ['src/pages/neural-dance/debug/index.astro', 'neural-dance/debug/index.html']
  ];
  for (const [src, dest] of pages) {
    const html = stampBuild(renderPage(await readFile(join(root, src), 'utf8'), header), version);
    if (html.includes('<BaseLayout') || html.includes('<SiteHeader') || html.includes('__ND_BUILD__')) throw new Error('Uncompiled component in ' + src);
    const out = join(dist, dest);
    await mkdir(dirname(out), {recursive: true});
    await writeFile(out, html);
  }
  // Crowd fallback pages: the live page plus crowd-page.js (no sticker scans).
  const liveSource = await readFile(join(root, 'src/pages/neural-dance/live/index.astro'), 'utf8');
  for (const mode of ['demo', 'show']) {
    const html = stampBuild(crowdPage(renderPage(liveSource, header), mode), version);
    const out = join(dist, 'neural-dance', mode, 'index.html');
    await mkdir(dirname(out), {recursive: true});
    await writeFile(out, html);
    const remote = join(dist, 'neural-dance', mode, 'control', 'index.html');
    await mkdir(dirname(remote), {recursive: true});
    await writeFile(remote, crowdRemotePage(mode, version));
  }
  await copyTree(join(root, 'neural-dance'), join(dist, 'neural-dance'));
  await copyTree(join(root, 'static/neural-dance'), join(dist, 'neural-dance'));
  await mkdir(join(dist, 'brand'), {recursive: true});
  await cp(join(root, 'static/brand/neural-dance-share.jpg'), join(dist, 'brand/neural-dance-share.jpg'));
  await writeFile(join(dist, 'neural-dance/version.json'), JSON.stringify({version, ...(await hotManifest())}) + '\n');
}

if (process.argv[1] && process.argv[1].endsWith('build-pages.mjs')) {
  await buildPages();
  console.log('Neural Dance assets written to dist/assets');
}
