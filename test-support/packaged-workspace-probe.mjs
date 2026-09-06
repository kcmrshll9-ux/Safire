import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Exercise the shipped React application and HTTP backend with invented notes.
export async function verifyPackagedWorkspace({ cdp, sessionId, vaultDir, pollUntil }) {
  const evaluate = expression => cdp.evaluate(expression, sessionId);
  const wait = (label, expression) => pollUntil(label, 20_000, () => evaluate(expression));
  const input = text => evaluate(`(() => {
    const field = document.querySelector('textarea.editor');
    if (!field) throw new Error('Editor is unavailable');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const reload = async () => {
    const previousOrigin = await evaluate('performance.timeOrigin');
    await cdp.send('Page.reload', {}, sessionId);
    await wait('a fresh initialized workspace', `performance.timeOrigin !== ${previousOrigin} && Boolean(document.querySelector('button[aria-label="Files"]') && document.querySelector('.product-status')?.textContent.startsWith('Opened'))`);
  };
  await fs.writeFile(path.join(vaultDir, 'Other.md'), '# Other note');
  await evaluate(`fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({autosave:false}) }).then(r=>{if(!r.ok)throw new Error('Settings update failed')})`);
  await reload();
  await click('button[aria-label="Files"]');
  await wait('the Markdown editor', `Boolean(document.querySelector('textarea.editor'))`);

  const draft = '# Persistent draft\n\nKeep this writing across navigation and restart.';
  await input(draft);
  await wait('React to receive typing', `document.querySelector('.topbar h2')?.textContent.includes('•')`);
  await evaluate(`[...document.querySelectorAll('.file-row')].find(button=>button.textContent.trim()==='◦ Other').click()`);
  await wait('the other note', `document.querySelector('textarea.editor')?.value === '# Other note'`);
  await evaluate(`[...document.querySelectorAll('.file-row')].find(button=>button.textContent.trim()==='◦ Welcome').click()`);
  await wait('the protected draft', `document.querySelector('textarea.editor')?.value === ${JSON.stringify(draft)}`);
  await reload();
  await click('button[aria-label="Files"]');
  await wait('draft restoration after reload', `document.querySelector('textarea.editor')?.value === ${JSON.stringify(draft)}`);

  await fs.writeFile(path.join(vaultDir, 'Welcome.md'), '# External edit');
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(button=>button.textContent==='Save').click()`);
  await wait('the conflict panel', `Boolean(document.querySelector('.conflict-panel'))`);
  assert.equal(await fs.readFile(path.join(vaultDir,'Welcome.md'),'utf8'), '# External edit');
  assert.equal(await evaluate(`document.querySelector('textarea.editor').value`), draft);
  await evaluate(`[...document.querySelectorAll('.conflict-panel button')].find(button=>button.textContent==='Save mine as a copy').click()`);
  await wait('the recovered copy', `document.querySelector('.topbar .crumb')?.textContent.includes('my copy')`);
  const copiedPath = await evaluate(`document.querySelector('.topbar .crumb').textContent`);
  assert.equal(await fs.readFile(path.join(vaultDir,copiedPath),'utf8'),draft);

  // Hold only the response to one explicit save, allowing real editor changes
  // while the backend has written the older snapshot.
  const older = '# First save snapshot';
  const newer = '# More typing while saving\n\nThis must stay dirty until its own save.';
  await input(older);
  await wait('the dirty copy', `document.querySelector('.topbar h2')?.textContent.includes('•')`);
  await evaluate(`(() => {
    const fetchOriginal = window.fetch;
    window.fetch = async (url, options) => {
      const response = await fetchOriginal(url, options);
      if (url === '/api/note' && options?.method === 'PUT') {
        window.fetch = fetchOriginal;
        await new Promise(resolve=>{window.releaseProductSave=resolve;});
      }
      return response;
    };
    [...document.querySelectorAll('.topbar button')].find(button=>button.textContent==='Save').click();
  })()`);
  await wait('the delayed save', `typeof window.releaseProductSave === 'function'`);
  await input(newer);
  await evaluate(`window.releaseProductSave(); delete window.releaseProductSave;`);
  await wait('new typing retained after save', `document.querySelector('textarea.editor')?.value === ${JSON.stringify(newer)} && document.querySelector('.topbar h2')?.textContent.includes('•') && [...document.querySelectorAll('.topbar button')].some(button=>button.textContent==='Save'&&!button.disabled)`);
  assert.equal(await fs.readFile(path.join(vaultDir,copiedPath),'utf8'),older);
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(button=>button.textContent==='Save').click()`);
  await wait('the second snapshot saved', `document.querySelector('.save-health')?.textContent.includes('All changes saved')`);
  assert.equal(await fs.readFile(path.join(vaultDir,copiedPath),'utf8'),newer);

  // The native close handshake uses this same event and must await protection.
  await input('# Draft before native close');
  await evaluate(`(async()=>{const pending=[];window.dispatchEvent(new CustomEvent('safire:checkpoint',{detail:{waitUntil:p=>pending.push(p)}}));if(!pending.length)throw new Error('Missing desktop checkpoint listener');await Promise.all(pending);})()`);
  const record = await evaluate(`fetch('/api/draft?path='+encodeURIComponent(${JSON.stringify(copiedPath)})).then(r=>r.json())`);
  assert.equal(record.draft.content,'# Draft before native close');
  process.stdout.write('Packaged workspace gate passed: drafts, reload, conflicts, recovery copies, typing during saves, desktop checkpoint.\n');
}
