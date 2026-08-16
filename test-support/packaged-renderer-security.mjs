import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'undici';

const STARTUP_TIMEOUT_MS = 45_000;
const RENDER_TIMEOUT_MS = 20_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

class FatalProbeError extends Error {}

const attackMarkers = Object.freeze([
  'ATTACK-PLAIN',
  'ATTACK-MIXED-CASE',
  'ATTACK-ENTITY-VALUE',
  'ATTACK-ENTITY-NAME',
  'ATTACK-MULTILINE',
  'ATTACK-BORROWED-SAFE',
  'ATTACK-PRIMARY-ACTION',
]);

const attackerIds = Object.freeze([
  'attacker-plain',
  'attacker-mixed',
  'attacker-entity-value',
  'attacker-entity-name',
  'attacker-multiline',
  'attacker-borrowed-safe',
  'attacker-primary-action',
]);

const syntheticMarkdown = `# Packaged renderer security probe

<div class="modal-backdrop palette primary-action app-shell panel-modal" id="attacker-plain" style="position:fixed;inset:0;z-index:2147483647">ATTACK-PLAIN</div>

<div CLASS = "MoDaL-BaCkDrOp PaLeTtE PrImArY-AcTiOn" ID = "attacker-mixed" STYLE = "position:fixed;inset:0">ATTACK-MIXED-CASE</div>

<div class="modal&#x2d;backdrop palette primary&#x2d;action" id="attacker-entity-value" style="position&#x3a;fixed;inset&#x3a;0">ATTACK-ENTITY-VALUE</div>

<div cl&#x61;ss="modal-backdrop palette primary-action" i&#x64;="attacker-entity-name" st&#x79;le="position:fixed;inset:0">ATTACK-ENTITY-NAME</div>

<div
  class = "modal-backdrop palette primary-action danger-action note-row"
  id = "attacker-multiline"
  style = "position:fixed;inset:0"
>ATTACK-MULTILINE</div>

<div class="youtube-link-card safire-preview-image safire-evidence-callout evidence-status verified" id="attacker-borrowed-safe" style="position:fixed;inset:0">ATTACK-BORROWED-SAFE</div>

<div class="primary-action" id="attacker-primary-action" style="position:fixed;inset:0">ATTACK-PRIMARY-ACTION</div>

[Renderer-owned YouTube card](https://www.youtube.com/watch?v=synthetic-renderer-probe)

![Renderer-owned image](/api/attachment?path=Attachments%2Fsynthetic-probe.png)

\`\`\`safire-evidence
id: "synthetic-renderer-probe"
claim: "Renderer-owned evidence classes survive"
source_type: "manual_observation"
source: "synthetic local fixture"
observed_at: "2026-08-15T00:00:00.000Z"
action: "Rendered a synthetic fixture"
verification: "Static synthetic assertion"
status: "verified"
freshness: "2099-01-01T00:00:00.000Z"
excerpt: "Synthetic fixture only"
hash: ""
private_notes: ""
\`\`\`
`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollUntil(label, timeoutMs, operation) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      if (error instanceof FatalProbeError) throw error;
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', () => this.#failPending(new Error('DevTools connection closed')));
    socket.addEventListener('error', () => this.#failPending(new Error('DevTools connection failed')));
  }

  static async connect(url, abortPromise) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => {
        try { socket.close(); } catch { /* The handshake may not have opened. */ }
        finish(new Error('Timed out connecting to DevTools'));
      }, CDP_COMMAND_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        finish();
      }, { once: true });
      socket.addEventListener('error', () => {
        finish(new Error('Could not connect to the packaged renderer DevTools endpoint'));
      }, { once: true });
      abortPromise?.then((error) => {
        try { socket.close(); } catch { /* The handshake may not have opened. */ }
        finish(error);
      });
    });
    return new CdpConnection(socket);
  }

  #receive(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out running ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(expression, sessionId) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'unknown renderer exception';
      throw new Error(description);
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function readDevToolsEndpoint(userDataDir, stderrText) {
  try {
    const contents = await fs.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
    const [portText, endpointPath] = contents.split(/\r?\n/);
    const port = Number(portText);
    if (Number.isInteger(port) && port > 0 && port <= 65_535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpointPath || '')) {
      return `ws://127.0.0.1:${port}${endpointPath}`;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return stderrText().match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9-]+)/)?.[1] || null;
}

async function stopPackagedApp(child, exited) {
  if (exited.settled) return;
  child.kill();
  await Promise.race([exited.promise, delay(5_000)]);
  if (!exited.settled) {
    child.kill('SIGKILL');
    await Promise.race([exited.promise, delay(5_000)]);
  }
  if (!exited.settled) throw new Error('Packaged Safire did not exit after the security probe');
}

function packagedResourcesDirectory(packagedApp) {
  if (process.platform === 'darwin') {
    const contents = path.dirname(path.dirname(packagedApp));
    assert.equal(path.basename(contents), 'Contents', `macOS executable is not inside an app bundle: ${packagedApp}`);
    return path.join(contents, 'Resources');
  }
  return path.join(path.dirname(packagedApp), 'resources');
}

function packagedCopyLayout(packagedApp, scratch) {
  if (process.platform === 'darwin') {
    const contents = path.dirname(path.dirname(packagedApp));
    const bundle = path.dirname(contents);
    const isolatedBundle = path.join(scratch, path.basename(bundle));
    return {
      sourceRoot: bundle,
      isolatedRoot: isolatedBundle,
      isolatedExecutable: path.join(isolatedBundle, path.relative(bundle, packagedApp)),
    };
  }
  const sourceRoot = path.dirname(packagedApp);
  const isolatedRoot = path.join(scratch, 'packaged-app');
  return {
    sourceRoot,
    isolatedRoot,
    isolatedExecutable: path.join(isolatedRoot, path.basename(packagedApp)),
  };
}

async function verifyPackagedBackendImport(packagedApp, environment) {
  const serverUrl = pathToFileURL(path.join(packagedResourcesDirectory(packagedApp), 'app.asar', 'server.mjs')).href;
  const source = `try { await import(process.argv[1]); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }`;
  await new Promise((resolve, reject) => {
    const child = spawn(packagedApp, ['--input-type=module', '-e', source, serverUrl], {
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const retainOutput = (chunk) => {
      output = `${output}${chunk}`.slice(-16_384);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', retainOutput);
    child.stderr.on('data', retainOutput);
    child.once('error', (error) => finish(new Error(`Could not start the packaged backend import check: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`Packaged backend import failed before Chromium startup (${code ?? signal ?? 'unknown reason'}).${output.trim() ? `\n${output.trim()}` : ''}`));
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Timed out checking the packaged backend dependency closure'));
    }, 20_000);
  });
}

function packagedExitError(exited) {
  const reason = exited.error?.message ?? exited.code ?? exited.signal ?? 'unknown reason';
  return new FatalProbeError(`Packaged Safire exited before its renderer became available (${reason})`);
}

async function main() {
  assert.ok(process.env.SAFIRE_PACKAGED_APP, 'SAFIRE_PACKAGED_APP must name the freshly built packaged Safire executable');
  const packagedApp = path.resolve(process.env.SAFIRE_PACKAGED_APP);
  const executable = await fs.stat(packagedApp).catch(() => null);
  assert.ok(executable?.isFile(), `SAFIRE_PACKAGED_APP is not a file: ${packagedApp}`);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-packaged-renderer-'));
  const vaultDir = path.join(scratch, 'vault');
  const userDataDir = path.join(scratch, 'user-data');
  const attachmentDir = path.join(vaultDir, 'Attachments');
  const copyLayout = packagedCopyLayout(packagedApp, scratch);
  const isolatedPackagedApp = copyLayout.isolatedExecutable;
  const childEnvironment = {
    ...process.env,
    SAFIRE_VAULT_PATH: vaultDir,
    SAFIRE_VAULT_CONFIG_PATH: path.join(scratch, 'vault-config.json'),
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;

  try {
    await fs.mkdir(attachmentDir, { recursive: true });
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(path.join(vaultDir, 'Welcome.md'), syntheticMarkdown, 'utf8');
    await fs.writeFile(
      path.join(attachmentDir, 'synthetic-probe.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    await fs.cp(copyLayout.sourceRoot, copyLayout.isolatedRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await verifyPackagedBackendImport(isolatedPackagedApp, childEnvironment);
  } catch (error) {
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }

  let stderr = '';
  const child = spawn(isolatedPackagedApp, [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--disable-extensions',
    '--enable-logging=stderr',
  ], {
    env: childEnvironment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const exited = { settled: false, code: null, signal: null, error: null, promise: null };
  exited.promise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited.settled = true;
      exited.code = code;
      exited.signal = signal;
      resolve();
    });
    child.once('error', (error) => {
      exited.settled = true;
      exited.error = error;
      resolve();
    });
  });

  let cdp;
  try {
    const devToolsEndpoint = await pollUntil('the packaged browser DevTools endpoint', STARTUP_TIMEOUT_MS, async () => {
      if (exited.settled) {
        throw packagedExitError(exited);
      }
      return readDevToolsEndpoint(userDataDir, () => stderr);
    });
    cdp = await CdpConnection.connect(devToolsEndpoint, exited.promise.then(() => packagedExitError(exited)));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const target = await pollUntil('the packaged Safire renderer target', STARTUP_TIMEOUT_MS, async () => {
      if (exited.settled) throw packagedExitError(exited);
      const response = await cdp.send('Target.getTargets');
      return response.targetInfos.find((candidate) => candidate.type === 'page'
        && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(candidate.url));
    });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send('Runtime.enable', {}, sessionId);

    await pollUntil('the synthetic Markdown preview', RENDER_TIMEOUT_MS, async () => {
      if (exited.settled) throw packagedExitError(exited);
      return cdp.evaluate(`(() => {
        const preview = document.querySelector('article.preview.markdown');
        return Boolean(preview && ${JSON.stringify(attackMarkers)}.every((marker) => preview.textContent.includes(marker)));
      })()`, sessionId);
    });

    const result = await cdp.evaluate(`(() => {
      const preview = document.querySelector('article.preview.markdown');
      if (!preview) throw new Error('Markdown preview was not rendered');
      const markers = ${JSON.stringify(attackMarkers)};
      const ids = ${JSON.stringify(attackerIds)};
      const probes = markers.map((marker) => {
        const element = [...preview.querySelectorAll('div,a')]
          .find((candidate) => candidate.textContent.trim() === marker);
        if (!element) return { marker, missing: true };
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          marker,
          missing: false,
          tag: element.tagName,
          hasClass: element.hasAttribute('class'),
          className: element.getAttribute('class') || '',
          hasId: element.hasAttribute('id'),
          id: element.getAttribute('id') || '',
          hasStyle: element.hasAttribute('style'),
          position: style.position,
          coversViewport: style.position === 'fixed'
            && rect.left <= 0 && rect.top <= 0
            && rect.right >= innerWidth && rect.bottom >= innerHeight,
          html: element.outerHTML,
        };
      });
      return {
        probes,
        privilegedClassCount: preview.querySelectorAll('.modal-backdrop,.palette,.primary-action').length,
        attackerIdsPresent: ids.filter((id) => document.getElementById(id)),
        inlineStyleCount: preview.querySelectorAll('[style]').length,
        safe: {
          youtubeCard: Boolean(preview.querySelector('a.youtube-link-card')),
          youtubeStructure: Boolean(preview.querySelector('a.youtube-link-card .youtube-thumb-wrap.youtube-local-placeholder .youtube-play')
            && preview.querySelector('a.youtube-link-card .youtube-link-copy .youtube-eyebrow')
            && preview.querySelector('a.youtube-link-card .youtube-link-copy .youtube-title')),
          image: Boolean(preview.querySelector('img.safire-preview-image')),
          evidenceCallout: Boolean(preview.querySelector('details.safire-evidence-callout')),
          evidenceStatus: Boolean(preview.querySelector('details.safire-evidence-callout .evidence-status.verified')),
          evidenceStructure: Boolean(preview.querySelector('details.safire-evidence-callout .evidence-claim')
            && preview.querySelector('details.safire-evidence-callout .evidence-source')),
        },
      };
    })()`, sessionId);

    assert.equal(result.privilegedClassCount, 0, 'attacker-controlled application classes survived in the Markdown preview');
    assert.deepEqual(result.attackerIdsPresent, [], 'attacker-controlled IDs survived in the rendered document');
    assert.equal(result.inlineStyleCount, 0, 'attacker-controlled inline styles survived in the Markdown preview');
    assert.equal(result.probes.length, attackMarkers.length);
    for (const probe of result.probes) {
      assert.equal(probe.missing, false, `rendered marker was missing: ${probe.marker}`);
      assert.equal(probe.hasClass, false, `attacker class attribute survived: ${probe.html}`);
      assert.equal(probe.hasId, false, `attacker id attribute survived: ${probe.html}`);
      assert.equal(probe.hasStyle, false, `attacker style attribute survived: ${probe.html}`);
      assert.notEqual(probe.position, 'fixed', `attacker element computed to fixed positioning: ${probe.html}`);
      assert.equal(probe.coversViewport, false, `attacker element covered the viewport: ${probe.html}`);
    }
    assert.deepEqual(result.safe, {
      youtubeCard: true,
      youtubeStructure: true,
      image: true,
      evidenceCallout: true,
      evidenceStatus: true,
      evidenceStructure: true,
    }, 'renderer-owned preview classes did not survive final sanitization');

    process.stdout.write('Packaged Chromium Markdown renderer security gate passed.\n');
  } catch (error) {
    const diagnostics = stderr.trim() ? `\nPackaged app diagnostics (tail):\n${stderr.trim()}` : '';
    error.message = `${error.message}${diagnostics}`;
    throw error;
  } finally {
    cdp?.close();
    try {
      await stopPackagedApp(child, exited);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
