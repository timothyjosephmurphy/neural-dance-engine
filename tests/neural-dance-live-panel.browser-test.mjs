// iPhone portrait: the controls and the camera panel are one scroll column,
// and every visible button is the element under its own center.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css'};

async function launch() {
  let chromium;
  try { ({chromium} = await import('playwright')); }
  catch { ({chromium} = await import('playwright-core')); }
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  try { return await chromium.launch({args}); }
  catch { return chromium.launch({args, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome'}); }
}

test('at 390x844 every visible control button is hit-testable', async () => {
  const liveHtml = (await readFile(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8'))
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/neural-dance/live/' || url.pathname === '/neural-dance/live/index.html') {
        res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
        return res.end(liveHtml);
      }
      const file = join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
      res.end(body);
    } catch { res.writeHead(404); res.end('missing'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    await page.goto(origin + '/neural-dance/live/', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('nd-room-lab')?.dataset.roomReady === '1');
    await page.click('[data-live="collapse"]');
    const report = await page.evaluate(() => {
      const stack = document.querySelector('.nd-live-stack');
      const cs = getComputedStyle(stack);
      document.querySelector('[data-debug-advanced]')?.setAttribute('open', '');
      const buttons = [...document.querySelectorAll('.nd-live-stack button')];
      const blocked = [];
      let checked = 0;
      for (const button of buttons) {
        if (button.hidden) continue;
        const closed = button.closest('details');
        if (closed && !closed.open) continue;
        const style = getComputedStyle(button);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        let scroller = button.parentElement;
        while (scroller && scroller !== document.body) {
          const ss = getComputedStyle(scroller);
          if (/(auto|scroll)/.test(ss.overflowY) && scroller.scrollHeight > scroller.clientHeight + 2) break;
          scroller = scroller.parentElement;
        }
        if (scroller && scroller !== document.body) {
          const host = scroller.getBoundingClientRect();
          const before = button.getBoundingClientRect();
          scroller.scrollTop += before.top - host.top - Math.max(0, (scroller.clientHeight - before.height) / 2);
        }
        const box = button.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        checked++;
        if (hit !== button && !(hit && button.contains(hit))) {
          const who = hit ? (hit.tagName + '.' + (hit.className || '') + ' ' + (hit.textContent || '').trim()).slice(0, 60) : 'nothing';
          blocked.push((button.textContent || button.getAttribute('aria-label') || 'button').trim().slice(0, 24) + ' under ' + who);
        }
        if (box.height + 0.5 < 32) blocked.push('short:' + (button.textContent || '').trim().slice(0, 24));
      }
      const note = document.querySelector('[data-person-note]');
      note.hidden = false;
      const pause = document.querySelector('[data-person-pause]');
      pause.scrollIntoView({block: 'center'});
      const pr = pause.getBoundingClientRect();
      const nr = note.getBoundingClientRect();
      const noteCovers = !(nr.bottom < pr.top || nr.top > pr.bottom || nr.right < pr.left || nr.left > pr.right);
      return {
        checked,
        blocked,
        overflow: cs.overflowY,
        maxHeight: cs.maxHeight,
        webkit: cs.webkitOverflowScrolling || stack.style.webkitOverflowScrolling || '',
        noteCovers
      };
    });
    assert.ok(report.checked >= 8, 'checked ' + report.checked);
    assert.deepEqual(report.blocked, []);
    assert.equal(report.overflow, 'auto');
    assert.equal(report.noteCovers, false, 'person toast covers Pause');
    assert.match(report.maxHeight, /70vh|70dvh|px/);
  } finally {
    await browser.close();
    server.close();
  }
});
