import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicEvidenceContent,
  publicNoteMetadata,
} from '../lib/note-projection.mjs';

const PRIVATE_TERMS = [
  'LITERAL-PRIVATE',
  'FOLDED-PRIVATE',
  'INDENTED-PRIVATE',
  'QUOTED-PRIVATE',
  'MALFORMED-PRIVATE',
  'LEGACY-PRIVATE',
];

function adversarialEvidence(newline = '\n') {
  return [
    '```safire-evidence',
    'id: "first"',
    'claim: >-',
    '  Public receipt text #receipt-tag [[Receipt Link]]',
    'private_notes: |',
    '  LITERAL-PRIVATE #literal-private [[Literal Private Link]]',
    'notes: >-',
    '  FOLDED-PRIVATE #folded-private [[Folded Private Link]]',
    'private_notes: |2+',
    '  INDENTED-PRIVATE #indented-private [[Indented Private Link]]',
    '```',
    '',
    '```safire-evidence',
    'id: "second"',
    'claim: "Second public receipt"',
    'private_notes: "QUOTED-PRIVATE',
    '  #quoted-private [[Quoted Private Link]]"',
    'notes: "MALFORMED-PRIVATE',
    '  #malformed-private [[Malformed Private Link]]',
    'label: "Still public"',
    '"private_notes": "LEGACY-PRIVATE #legacy-private [[Legacy Private Link]]"',
    '```',
  ].join(newline);
}

test('public evidence projection allowlists public fields and drops private multiline spans', () => {
  const markdown = `# Outside #outside [[Outside Link]]\r\n\r\n${adversarialEvidence('\r\n')}`;
  const projected = publicEvidenceContent(markdown);

  assert.match(projected, /Public receipt text/);
  assert.doesNotMatch(projected, /Second public receipt|Still public/);
  assert.equal((projected.match(/```safire-evidence/g) || []).length, 2);
  for (const privateTerm of PRIVATE_TERMS) assert.doesNotMatch(projected, new RegExp(privateTerm));
  assert.doesNotMatch(projected, /literal-private|folded-private|indented-private|quoted-private|malformed-private|legacy-private|Private Link/);

  const metadata = publicNoteMetadata(markdown);
  assert.deepEqual(metadata.tags, ['outside', 'receipt-tag']);
  assert.deepEqual(metadata.links, ['Outside Link', 'Receipt Link']);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE|private|Private Link/);
});

test('public evidence projection fails closed for unknown and malformed evidence fields', () => {
  const markdown = [
    '```safire-evidence',
    'claim: "Visible claim"',
    'unknown_private_field: "UNKNOWN-PRIVATE #unknown-private [[Unknown Private Link]]"',
    'private_notes "MALFORMED-PRIVATE #malformed-private [[Malformed Private Link]]"',
    'notes:',
    '  LEGACY-PRIVATE #legacy-private [[Legacy Private Link]]',
    'status: "verified"',
    '```',
  ].join('\n');
  const projected = publicEvidenceContent(markdown);

  assert.doesNotMatch(projected, /Visible claim|status: "verified"/);
  assert.doesNotMatch(projected, /UNKNOWN-PRIVATE|MALFORMED-PRIVATE|LEGACY-PRIVATE|private-tag|Private Link/);
});

test('an unclosed private quote cannot promote a root-looking continuation into public output', () => {
  const markdown = [
    '```safire-evidence',
    'id: "malformed-quote"',
    'private_notes: "PRIVATE-PREFIX',
    'claim: PRIVATE-CONTINUATION #private-tag [[Private Link]]',
    'status: "verified"',
    '```',
  ].join('\n');
  const projected = publicEvidenceContent(markdown);

  assert.doesNotMatch(projected, /PRIVATE-PREFIX|PRIVATE-CONTINUATION|private-tag|Private Link|verified|malformed-quote/);
  assert.deepEqual(publicNoteMetadata(markdown), { tags: [], links: [], excerpt: '' });
});

test('an unclosed evidence fence is omitted through EOF without altering ordinary code fences', () => {
  const interrupted = [
    '# Outside #outside [[Outside Link]]',
    '',
    '```safire-evidence',
    'claim: "Visible but incomplete"',
    'private_notes: |',
    '  UNCLOSED-PRIVATE #unclosed-private [[Unclosed Private Link]]',
  ].join('\n');
  const projected = publicEvidenceContent(interrupted);
  assert.match(projected, /# Outside #outside \[\[Outside Link\]\]/);
  assert.doesNotMatch(projected, /Visible but incomplete|UNCLOSED-PRIVATE|unclosed-private|Unclosed Private Link/);
  assert.deepEqual(publicNoteMetadata(interrupted), {
    tags: ['outside'],
    links: ['Outside Link'],
    excerpt: 'Outside outside Outside Link',
  });

  const ordinaryFence = ['```markdown', '```safire-evidence', 'private_notes: "ordinary code"', '```', '```'].join('\n');
  assert.equal(publicEvidenceContent(ordinaryFence), ordinaryFence);
});

test('nested blockquoted evidence is projected structurally and fails closed', () => {
  const markdown = [
    '# Outside #outside [[Outside Link]]',
    '',
    '> > ```safire-evidence',
    '> > id: "quoted-valid"',
    '> > claim: >-',
    '> >   Quoted public claim #quoted-public [[Quoted Public Link]]',
    '> > private_notes: |+',
    '> >   QUOTED-BLOCK-PRIVATE #quoted-private [[Quoted Private Link]]',
    '> > ```',
    '',
    '> ```safire-evidence',
    '> id: "quoted-malformed"',
    '> private_notes: "MALFORMED-QUOTED-PRIVATE',
    '> claim: PRIVATE-PROMOTION #promoted-private [[Promoted Private Link]]',
    '> ```',
  ].join('\r\n');
  const projected = publicEvidenceContent(markdown);

  assert.match(projected, /> >   Quoted public claim #quoted-public \[\[Quoted Public Link\]\]/);
  assert.doesNotMatch(projected, /QUOTED-BLOCK-PRIVATE|MALFORMED-QUOTED-PRIVATE|PRIVATE-PROMOTION|quoted-private|promoted-private|Private Link/);
  assert.deepEqual(publicNoteMetadata(markdown), {
    tags: ['outside', 'quoted-public'],
    links: ['Outside Link', 'Quoted Public Link'],
    excerpt: 'Outside outside Outside Link',
  });

  const interrupted = ['> > ```safire-evidence', '> > id: "unclosed"', '> > private_notes: |', '> >   UNCLOSED-QUOTED-PRIVATE #unclosed-private [[Unclosed Private Link]]'].join('\n');
  assert.doesNotMatch(publicEvidenceContent(interrupted), /unclosed|UNCLOSED|private|Private Link/);

  const ordinary = ['> ```markdown', '> private_notes: "ordinary quoted code #ordinary [[Ordinary Link]]"', '> ```'].join('\n');
  assert.equal(publicEvidenceContent(ordinary), ordinary);
});
