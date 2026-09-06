import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Runs only in the packaged probe's disposable vault, after its writing tests.
// Optional screenshots are genuine renders of the shipped app with invented data.
export async function verifyPackagedVisuals({ cdp, sessionId, vaultDir, pollUntil }) {
  const evaluate = expression => cdp.evaluate(expression, sessionId);
  const wait = (label, expression) => pollUntil(label, 20_000, () => evaluate(expression));
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(button => button.textContent === 'Save').click()`);
  await wait('visual fixture preparation', `document.querySelector('.save-health')?.textContent.includes('All changes saved')`);
  for (const item of await fs.readdir(vaultDir, { withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith('.md')) await fs.unlink(path.join(vaultDir, item.name));
  }
  const drafts = path.join(vaultDir, '.safire', 'drafts');
  for (const item of await fs.readdir(drafts, { withFileTypes: true })) {
    if (item.isFile() && /^[a-f0-9]{64}\.json$/.test(item.name)) await fs.unlink(path.join(drafts, item.name));
  }
  const receipt = '```safire-evidence\nid: "reading-space"\nclaim: "A quiet corner makes room for a reading habit."\nsource_type: "manual_observation"\nsource: "Invented demonstration"\nstatus: "verified"\n```';
  const notes = {
    'Studio/Start here.md': '# A little room for good ideas\n\nThis is your space to collect what matters, connect the dots, and make something of it.\n\n## Find your rhythm\n\nStart small. Keep a thought, follow a question, or return to something unfinished.\n\n- [x] Make a space for your notes\n- [ ] Capture an idea worth keeping\n- [ ] Connect it to [[A working rhythm]]\n\n> Good work starts with paying attention.\n\n#ideas #writing',
    'Studio/A working rhythm.md': '# A working rhythm\n\nA short morning review. One clear priority. Time to think before the day gets busy.\n\n[[Start here]]\n\n#writing',
    'Research/Places to grow.md': '# Places to grow\n\nA notebook for observing the small spaces that help a neighborhood feel connected.\n\n' + receipt + '\n\n#community',
    'Research/Room to read.md': '# Room to read\n\nWhat makes a place welcoming enough to stay for one more chapter?\n\n' + receipt.replace('reading-space', 'reading-room') + '\n\n#reading',
    'Personal/A small list of possibilities.md': '# A small list of possibilities\n\n- [ ] Take the long way home\n- [ ] Make something by hand\n- [ ] Leave a little room for surprise\n\n#ideas',
  };
  for (const [relative, content] of Object.entries(notes)) {
    const file = path.join(vaultDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const screenshotDirectory = process.env.SAFIRE_SCREENSHOT_DIR;
  if (screenshotDirectory) await fs.mkdir(path.resolve(screenshotDirectory), { recursive: true });
  const capture = async name => {
    if (!screenshotDirectory) return;
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))`);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    await fs.writeFile(path.join(path.resolve(screenshotDirectory), `${name}.png`), Buffer.from(image.data, 'base64'));
  };
  const reload = async theme => {
    await evaluate(`fetch('/api/settings', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:${JSON.stringify(theme)},startupNote:'Studio/Start here.md'})}).then(r=>{if(!r.ok)throw new Error('Settings failed')})`);
    const origin = await evaluate('performance.timeOrigin');
    await cdp.send('Page.reload', {}, sessionId);
    await wait('the themed Home workspace', `performance.timeOrigin !== ${origin} && document.documentElement.dataset.theme === ${JSON.stringify(theme)} && document.querySelector('.workspace-desk') && document.querySelector('.file-row')?.textContent`);
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  for (const theme of ['light', 'dark']) {
    await reload(theme);
    await cdp.send('Page.bringToFront', {}, sessionId);
    await capture(`safire-workspace-${theme}`);
    const opener = await evaluate(`(() => { const button=[...document.querySelectorAll('.desk-actions button')].find(b=>b.textContent.includes('Quick capture')); button.focus(); button.click(); return button.textContent; })()`);
    await wait('quick capture dialog', `Boolean(document.querySelector('.capture-panel[role="dialog"]'))`);
    assert.equal(await evaluate(`document.querySelector('.capture-panel').contains(document.activeElement)`), true);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await wait(`${theme} dialog dismissal`, `!document.querySelector('.capture-panel')`);
    assert.equal(await evaluate('document.activeElement.textContent'), opener);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  }
  await reload('light');
  await click('button[aria-label="Research desk"]');
  await wait('research cards', `document.querySelectorAll('.evidence-card').length === 2`);
  await capture('safire-research');
  await click('button[aria-label="Home"]');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 611, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const narrow = await evaluate(`({width:document.querySelector('.workspace').getBoundingClientRect().width,overflow:document.documentElement.scrollWidth > innerWidth})`);
  assert.ok(narrow.width > 500, 'Narrow windows keep the main workspace visible');
  assert.equal(narrow.overflow, false);
  await capture('safire-workspace-narrow');
  process.stdout.write('Packaged visual gate passed: both themes, dialog keyboard/focus, research, and narrow workspace.\n');
}
