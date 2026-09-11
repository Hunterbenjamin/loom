// Scenarios for drive.mjs. Each takes ctx = { renderer, args, out, launch, shot, sleep }.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const herdr = (...a) => JSON.parse(execFileSync('herdr', a, { encoding: 'utf8' }));

const attach = (name, extra = []) => ({
  file: 'herdr',
  args: ['agent', 'attach', name, ...extra],
  title: `herdr agent attach ${name} ${extra.join(' ')}`,
});

// Attach to one agent, check it renders and accepts typed input, screenshot, detach.
export async function smoke({ launch, shot, sleep, args }) {
  const target = args[0] ?? 's03-claude';
  const { app, page } = await launch();
  const id = await page.evaluate((o) => window.s03.open(o), attach(target));
  await page.evaluate((id) => window.s03.waitFor(id, 'for shortcuts|Ask Codex|›|>', 15000), id);
  await sleep(1000);
  const info = await page.evaluate((id) => window.s03.info(id), id);
  await shot(page, `smoke-${target}`);
  await page.keyboard.type('hello');
  await sleep(600);
  const typed = await page.evaluate((id) => window.s03.screenText(id), id);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await sleep(300);
  const exited = await page.evaluate((id) => window.s03.close(id), id);
  await app.close();
  return { info, typedVisible: typed.includes('hello'), closeExit: exited };
}

const SPIKE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(process.env.TMPDIR ?? '/tmp', 'loom-spike-03-embedded-terminal');
const KEYLOG = path.join(OUT, 'keylog.txt');
const keylogSize = () => statSync(KEYLOG).size;
const keylogSince = (off) =>
  readFileSync(KEYLOG, 'utf8')
    .slice(off)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/^\d+\.\d+ /, ''));
const wait = (t) => new Promise((r) => setTimeout(r, t));

// Restart the key logger in pane w1:p3 (our own pane) with the given mode flags.
export async function restartKeylog(flags) {
  try {
    execFileSync('herdr', ['pane', 'send-keys', 'w1:p3', 'ctrl+c']);
  } catch {}
  await wait(500);
  execFileSync('herdr', ['pane', 'run', 'w1:p3', `clear; KEYLOG=${KEYLOG} python3 ${SPIKE}/keylog.py ${flags}`]);
  execFileSync('herdr', ['pane', 'wait-output', 'w1:p3', '--match', 'keylog ready', '--timeout', '5000']);
}

async function termBox(page, id) {
  const idx = (await page.evaluate(() => window.s03.ids())).indexOf(id);
  return page.locator('.term').nth(idx).boundingBox();
}

// What each key sends (renderer → herdr) and what reaches the program in the pane (herdr → app).
export async function keys({ launch, shot, sleep, args }) {
  const flags = args.join(' ') || '--paste --mouse --kitty';
  await restartKeylog(flags);
  const { app, page } = await launch();
  const id = await page.evaluate((o) => window.s03.open(o), attach('s03-keys'));
  await page.evaluate((id) => window.s03.waitFor(id, 'keylog ready', 10000), id);
  await sleep(500);
  const results = { flags };
  const probe = async (label, fn) => {
    await page.evaluate((id) => window.s03.clearInputLog(id), id);
    const off = keylogSize();
    await fn();
    await sleep(400);
    results[label] = {
      sent: await page.evaluate((id) => window.s03.inputLog(id), id),
      received: keylogSince(off),
    };
  };
  for (const k of [
    'a',
    'Enter',
    'Shift+Enter',
    'Control+Enter',
    'Alt+Enter',
    'Shift+Tab',
    'Escape',
    'ArrowUp',
    'Alt+ArrowLeft',
    'Control+a',
    'Control+j',
    'Alt+b',
    'Alt+Backspace',
  ]) {
    await probe(`key ${k}`, () => page.keyboard.press(k));
  }
  await probe('paste event (Cmd+V path)', async () => {
    results.pasteTarget = await page.evaluate(() => window.s03.synthPaste('p1\np2'));
  });
  await probe('paste via term.paste()', () => page.evaluate((id) => window.s03.paste(id, 'q1\nq2'), id));
  const box = await termBox(page, id);
  await probe('mouse click', () => page.mouse.click(box.x + 80, box.y + 40));
  await probe('wheel up', async () => {
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.wheel(0, -200);
  });
  await probe('insertText 宽😀', () => page.keyboard.insertText('宽😀'));
  // Focus: a second (local) terminal takes focus; keys must not reach the first.
  const other = await page.evaluate(() => window.s03.open({ file: '/bin/cat', title: 'local cat' }));
  await sleep(300);
  await probe('typed while other terminal focused', () => page.keyboard.type('zz'));
  const box2 = await termBox(page, id);
  await probe('click back + type', async () => {
    await page.mouse.click(box2.x + 100, box2.y + 100);
    await page.keyboard.type('w');
  });
  await shot(page, `keys${flags.includes('kitty') ? '-kitty' : '-legacy'}`);
  await page.evaluate((o) => window.s03.close(o), other);
  await page.evaluate((id) => window.s03.close(id), id);
  await app.close();
  return results;
}

// Agent UIs: Shift+Enter, wide chars in the prompt, selection/copy, resize.
export async function agents({ launch, shot, sleep, renderer }) {
  const { app, page } = await launch();
  const res = {};
  const promptArea = (text) =>
    text
      .split('\n')
      .filter((l) => /^\s*[❯›>] |^\s{2,}b\s*$/.test(l))
      .map((l) => l.trimEnd());
  for (const [name, ready] of [
    ['s03-claude', 'for shortcuts'],
    ['s03-codex', 'Ask Codex|›'],
  ]) {
    const r = (res[name] = {});
    const id = await page.evaluate((o) => window.s03.open(o), attach(name));
    await page.evaluate(([id, re]) => window.s03.waitFor(id, re, 15000), [id, ready]);
    await sleep(800);
    await shot(page, `${name}-idle`);

    await page.evaluate((id) => window.s03.clearInputLog(id), id);
    await page.keyboard.type('a');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('b');
    await sleep(1000);
    const t = await page.evaluate((id) => window.s03.screenText(id), id);
    r.shiftEnter = {
      sentByRenderer: await page.evaluate((id) => window.s03.inputLog(id), id),
      promptLines: promptArea(t),
      agentStatus: herdr('agent', 'get', name).result.agent.agent_status,
    };
    await shot(page, `${name}-shift-enter`);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await sleep(300);

    await page.keyboard.insertText('宽字符😀x');
    await sleep(800);
    const info = await page.evaluate((id) => window.s03.info(id), id);
    r.wide = {
      promptLines: promptArea(await page.evaluate((id) => window.s03.screenText(id), id)),
      herdrView: execFileSync('herdr', ['agent', 'read', name, '--source', 'visible', '--lines', '60'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter((l) => l.includes('宽')),
      rendererCursor: [info.cursorX, info.cursorY],
      bufferType: info.bufferType,
    };
    await shot(page, `${name}-wide`);
    for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
    await sleep(300);

    // Selection: plain drag, Alt+drag, Shift+drag across the header line.
    const box = await termBox(page, id);
    const sel = {};
    for (const mod of ['none', 'Alt', 'Shift']) {
      await page.evaluate((id) => window.s03.clearInputLog(id), id);
      if (mod !== 'none') await page.keyboard.down(mod);
      await page.mouse.move(box.x + 130, box.y + 22);
      await page.mouse.down();
      await page.mouse.move(box.x + 330, box.y + 22, { steps: 8 });
      await page.mouse.up();
      if (mod !== 'none') await page.keyboard.up(mod);
      await sleep(400);
      const i2 = await page.evaluate((id) => window.s03.info(id), id);
      sel[mod] = {
        rendererSelection: i2.selection,
        osc52Seen: i2.osc52,
        mouseBytesSent: (await page.evaluate((id) => window.s03.inputLog(id), id)).length,
      };
      await page.mouse.click(box.x + 5, box.y + box.height - 5); // clear any selection
    }
    r.selection = sel;

    // Resize the window; the attach client should resize the Herdr pane.
    const pane = herdr('agent', 'get', name).result.agent.pane_id;
    const before = { term: await page.evaluate((id) => window.s03.info(id), id), pane: herdr('pane', 'get', pane).result.pane.scroll };
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 560));
    await sleep(1500);
    const after = { term: await page.evaluate((id) => window.s03.info(id), id), pane: herdr('pane', 'get', pane).result.pane.scroll };
    await shot(page, `${name}-resized`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await sleep(800);
    r.resize = {
      before: `${before.term.cols}x${before.term.rows} pane rows=${before.pane.viewport_rows}`,
      after: `${after.term.cols}x${after.term.rows} pane rows=${after.pane.viewport_rows}`,
    };
    await page.evaluate((id) => window.s03.close(id), id);
  }
  await app.close();
  return res;
}

// Test pattern through Herdr (left) and in a local PTY (right); then scrollback via wheel.
export async function pattern({ launch, shot, sleep }) {
  try {
    execFileSync('herdr', ['pane', 'send-keys', 'w1:p3', 'ctrl+c']);
  } catch {}
  await sleep(500);
  execFileSync('herdr', ['pane', 'run', 'w1:p3', `clear; bash ${SPIKE}/testpattern.sh`]);
  execFileSync('herdr', ['pane', 'wait-output', 'w1:p3', '--match', 'end-of-pattern', '--timeout', '5000']);
  const { app, page } = await launch();
  const h = await page.evaluate((o) => window.s03.open(o), attach('s03-keys'));
  await page.evaluate((id) => window.s03.waitFor(id, 'end-of-pattern', 10000), h);
  const l = await page.evaluate((f) => window.s03.open({ file: '/bin/bash', args: [f], title: 'local PTY: testpattern.sh' }), `${SPIKE}/testpattern.sh`);
  await page.evaluate((id) => window.s03.waitFor(id, 'end-of-pattern', 10000), l);
  await sleep(800);
  await shot(page, 'pattern');
  const res = {
    herdr: await page.evaluate((id) => window.s03.screenText(id), h),
    local: await page.evaluate((id) => window.s03.screenText(id), l),
  };
  await page.evaluate((id) => window.s03.close(id), l);

  // Scrollback lives in Herdr: the attach client is on the alternate screen.
  execFileSync('herdr', ['pane', 'run', 'w1:p3', 'seq 1 400']);
  await page.evaluate((id) => window.s03.waitFor(id, '\\b400\\b', 10000), h);
  await sleep(300);
  const box = await termBox(page, h);
  const firstLine = async () => (await page.evaluate((id) => window.s03.screenText(id), h)).split('\n').slice(0, 2).join(' | ');
  res.scroll = { before: await firstLine() };
  await page.mouse.move(box.x + 200, box.y + 200);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -300);
    await sleep(100);
  }
  await sleep(500);
  res.scroll.afterWheelUp = await firstLine();
  res.scroll.info = await page.evaluate((id) => window.s03.info(id), h);
  await shot(page, 'scrollback');
  await page.keyboard.type('x');
  await sleep(400);
  res.scroll.afterTyping = await firstLine();
  await page.keyboard.press('Backspace');
  await page.evaluate((id) => window.s03.close(id), h);
  await app.close();
  return res;
}

// Shift+Enter end to end, typed slowly (so Codex's paste-burst heuristic can't turn CR into a
// newline). args[0] = 'fix' to enable the CSI-u key handler.
export async function shiftenter({ launch, sleep, shot, args }) {
  const fix = args[0] === 'fix';
  await restartKeylog('--kitty');
  const { app, page } = await launch(fix ? { S03_QUERY: 'keyfix=1' } : {});
  const res = { keyfix: fix };
  const k = await page.evaluate((o) => window.s03.open(o), attach('s03-keys'));
  await page.evaluate((id) => window.s03.waitFor(id, 'keylog ready', 10000), k);
  const off = keylogSize();
  await page.keyboard.press('Shift+Enter');
  await sleep(500);
  res.keylog = { sent: await page.evaluate((id) => window.s03.inputLog(id), k), received: keylogSince(off) };
  await page.evaluate((id) => window.s03.close(id), k);
  for (const [name, ready] of [
    ['s03-claude', 'for shortcuts'],
    ['s03-codex', 'Ask Codex|›'],
  ]) {
    const id = await page.evaluate((o) => window.s03.open(o), attach(name));
    await page.evaluate(([id, re]) => window.s03.waitFor(id, re, 15000), [id, ready]);
    await sleep(500);
    await page.keyboard.type('a');
    await sleep(600);
    await page.keyboard.press('Shift+Enter');
    await sleep(600);
    await page.keyboard.type('b');
    await sleep(1000);
    const text = await page.evaluate((id) => window.s03.screenText(id), id);
    res[name] = {
      promptLines: text.split('\n').filter((l) => /^\s*[❯›] |^\s+b\s*$/.test(l)).map((l) => l.trimEnd()),
      agentStatus: herdr('agent', 'get', name).result.agent.agent_status,
    };
    await shot(page, `${name}-shiftenter-${fix ? 'fix' : 'nofix'}`);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await sleep(300);
    await page.evaluate((id) => window.s03.close(id), id);
  }
  await app.close();
  return res;
}

// IME composition (e.g. Japanese input) into a local PTY: what does the renderer send on commit?
export async function ime({ launch, sleep }) {
  const { app, page } = await launch();
  const id = await page.evaluate(() => window.s03.open({ file: '/bin/cat', title: 'local cat' }));
  await sleep(500);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate((id) => window.s03.clearInputLog(id), id);
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
  await sleep(150);
  await cdp.send('Input.imeSetComposition', { text: 'かん', selectionStart: 2, selectionEnd: 2 });
  await sleep(150);
  const duringComposition = await page.evaluate((id) => window.s03.inputLog(id), id);
  await cdp.send('Input.insertText', { text: '漢' });
  await sleep(500);
  const res = {
    duringComposition,
    afterCommit: await page.evaluate((id) => window.s03.inputLog(id), id),
    screen: (await page.evaluate((id) => window.s03.screenText(id), id)).trim(),
  };
  await page.evaluate((id) => window.s03.close(id), id);
  await app.close();
  return res;
}
