import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../lib/memory/profile.mjs';
import { parseEventInput, parseFeedbackInput } from '../lib/memory/schema.mjs';
import {
  parseTrustedBridgeEnvelope,
  trustedBridgeAuthenticationResultSchema,
} from '../lib/memory/trusted-bridge.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const examplesDirectory = path.resolve(testDirectory, '..', 'docs', 'memory', 'examples');

async function example(name) {
  return JSON.parse(await fs.readFile(path.join(examplesDirectory, name), 'utf8'));
}

test('every published memory JSON example satisfies its strict version-1 contract', async () => {
  for (const name of [
    'harry-portable-profile.json',
    'synthetic-portable-profile.json',
    'trusted-bridge-profile.json',
  ]) {
    assert.equal(validateProfile(await example(name)).version, 1, name);
  }

  for (const name of ['harry-agent-event.json', 'harry-moltbook-event.json']) {
    assert.equal(parseEventInput(await example(name)).schema_version, 1, name);
  }

  assert.equal(
    parseFeedbackInput(await example('correction-feedback.json')).schema_version,
    1,
  );
  assert.equal(
    parseTrustedBridgeEnvelope(await example('trusted-bridge-user-event.json')).schema_version,
    1,
  );
  assert.equal(
    trustedBridgeAuthenticationResultSchema.parse(
      await example('trusted-bridge-authentication-result.json'),
    ).authenticated,
    true,
  );
});
