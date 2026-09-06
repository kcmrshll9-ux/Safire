import { createHash } from 'node:crypto';

export function noteRevision(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function assertNoteRevision(content, expected) {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('A valid note revision is required');
  }
  if (noteRevision(content ?? '') !== expected) {
    const error = new Error('This note changed since you opened it. Your draft is safe. Review the latest version before saving.');
    error.code = 'NOTE_CONFLICT';
    throw error;
  }
}
