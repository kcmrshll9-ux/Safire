import test from 'node:test';
import assert from 'node:assert/strict';
import {
  genericIndexContent,
  isPublicTaskLine,
  parseEvidenceReceipts,
  parsePublicEvidenceReceipts,
  parsePublicTasks,
  publicEvidenceContent,
  publicNoteMetadata,
  semanticMarkdownContent,
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

  const openingOnly = '~~~safire-evidence';
  const closedProjection = '~~~safire-evidence\n~~~';
  assert.equal(publicEvidenceContent(openingOnly), closedProjection);
  assert.equal(publicEvidenceContent(closedProjection), closedProjection);
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
    excerpt: 'Outside outside Outside Link id: "quoted valid" claim: Quoted public claim quoted public Quoted Public Link',
  });

  const interrupted = ['> > ```safire-evidence', '> > id: "unclosed"', '> > private_notes: |', '> >   UNCLOSED-QUOTED-PRIVATE #unclosed-private [[Unclosed Private Link]]'].join('\n');
  assert.doesNotMatch(publicEvidenceContent(interrupted), /unclosed|UNCLOSED|private|Private Link/);

  const ordinary = ['> ```markdown', '> private_notes: "ordinary quoted code #ordinary [[Ordinary Link]]"', '> ```'].join('\n');
  assert.equal(publicEvidenceContent(ordinary), ordinary);
});

test('malformed flow scalars fail the whole evidence record closed for LF and CRLF', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const opening of ['[FLOW-PRIVATE-PREFIX', '{FLOW-PRIVATE-PREFIX']) {
      const markdown = [
        '# Outside #outside [[Outside Link]]',
        '```safire-evidence',
        'id: public-id',
        `private_notes: ${opening}`,
        'claim: FLOW-PRIVATE-CONTINUATION #flow-private [[Flow Private Link]]',
        'status: verified',
        '```',
      ].join(newline);
      const projected = publicEvidenceContent(markdown);

      assert.match(projected, /Outside Link/);
      assert.doesNotMatch(projected, /public-id|FLOW-PRIVATE|flow-private|Flow Private Link|verified/);
      assert.deepEqual(publicNoteMetadata(markdown), {
        tags: ['outside'],
        links: ['Outside Link'],
        excerpt: 'Outside outside Outside Link',
      });
      assert.deepEqual(parsePublicEvidenceReceipts(markdown, 'Flow.md'), []);
    }
  }
});

test('balanced-but-invalid flow and unsupported scalar wrappers also fail closed', () => {
  const privateValues = [
    ['[', '  one', '  two', ']'],
    ['{key value}', '', '', ''],
    ['!!seq [WRAPPED-PRIVATE', '', '', ''],
    ['"BAD-ESCAPE-\\q"', '', '', ''],
    ['["BAD-FLOW-ESCAPE-\\q"]', '', '', ''],
    ['|22', '  BAD-BLOCK-PRIVATE', '', ''],
  ];
  for (const [value, continuationOne, continuationTwo, closing] of privateValues) {
    const markdown = [
      '```safire-evidence',
      'id: should-disappear',
      `private_notes: ${value}`,
      ...(continuationOne ? [continuationOne] : []),
      ...(continuationTwo ? [continuationTwo] : []),
      ...(closing ? [closing] : []),
      'claim: MUST-NOT-BE-PROMOTED #private [[Private Link]]',
      'status: verified',
      '```',
    ].join('\n');
    assert.deepEqual(parsePublicEvidenceReceipts(markdown, 'Malformed.md'), []);
    assert.doesNotMatch(publicEvidenceContent(markdown), /should-disappear|MUST-NOT-BE-PROMOTED|#private|Private Link|verified/);
  }
});

test('balanced private flow and quoted scalars consume root-looking continuation lines', () => {
  const markdown = [
    '```safire-evidence',
    'id: safe-id',
    'private_notes: [',
    '  "FLOW-CONTINUATION #private-flow [[Private Flow Link]]",',
    '  "claim: still private",',
    ']',
    'notes: "QUOTED-PREFIX',
    'status: QUOTED-CONTINUATION #private-quote [[Private Quote Link]]"',
    'claim: Public claim',
    'status: verified',
    '```',
  ].join('\n');
  const projected = publicEvidenceContent(markdown);

  assert.match(projected, /Public claim/);
  assert.doesNotMatch(projected, /FLOW-CONTINUATION|QUOTED-CONTINUATION|private-flow|private-quote|Private (?:Flow|Quote) Link/);
  assert.deepEqual(parsePublicEvidenceReceipts(markdown, 'Balanced.md').map(({ id, claim, status }) => ({ id, claim, status })), [
    { id: 'safe-id', claim: 'Public claim', status: 'verified' },
  ]);
});

test('evidence fence recognition covers tildes, long runs, case, blockquotes, and evidence-like info', () => {
  const exactOpenings = [
    '~~~safire-evidence',
    '~~~~~SAFIRE-EVIDENCE   ',
    '```SaFiRe-EvIdEnCe',
    '    ~~~safire-evidence',
    '\t```safire-evidence',
    '> > ~~~~ safire-evidence',
  ];
  for (const opening of exactOpenings) {
    const marker = opening.includes('~') ? '~'.repeat((opening.match(/~+/)?.[0].length || 3)) : '`'.repeat((opening.match(/`+/)?.[0].length || 3));
    const quote = opening.startsWith('> >') ? '> > ' : '';
    const markdown = [
      opening,
      `${quote}claim: Public claim #public-tag [[Public Link]]`,
      `${quote}private_notes: TILDE-PRIVATE #tilde-private [[Tilde Private Link]]`,
      `${quote}${marker}`,
    ].join('\r\n');
    const projected = publicEvidenceContent(markdown);
    assert.match(projected, /Public claim/);
    assert.doesNotMatch(projected, /TILDE-PRIVATE|tilde-private|Tilde Private Link/);
  }

  const evidenceLikeOpenings = [
    '```safire-evidence extra',
    '~~~safire-evidence.invalid',
    '```{.safire-evidence}',
  ];
  for (const opening of evidenceLikeOpenings) {
    const marker = opening.startsWith('~') ? '~~~' : '```';
    const markdown = [opening, 'claim: SHOULD-NOT-BE-PUBLIC', 'private_notes: MALFORMED-INFO-PRIVATE #private [[Private Link]]', marker].join('\n');
    const projected = publicEvidenceContent(markdown);
    assert.doesNotMatch(projected, /SHOULD-NOT-BE-PUBLIC|MALFORMED-INFO-PRIVATE|#private|Private Link|extra|invalid/);
  }
});

test('malformed evidence-family info strings fail closed without suppressing ordinary code fences', () => {
  const cases = [
    { opening: '```safire-private-evidence', continuation: '', closing: '```', newline: '\n' },
    { opening: '~~~SAFIRE_PRIVATE_EVIDENCE yaml', continuation: '', closing: '~~~', newline: '\r\n' },
    { opening: '> ```{.sAfIrE-private-EvIdEnCe data-private=true}', continuation: '> ', closing: '> ```', newline: '\n' },
    { opening: '- ~~~~safire.private.evidence+yaml', continuation: '  ', closing: '  ~~~~', newline: '\r\n' },
    { opening: '> 1. ~~~evidence-private-safire', continuation: '>    ', closing: '>    ~~~', newline: '\n' },
    { opening: '- > ```s-a-f-i-r-e private e_v_i_d_e_n_c_e', continuation: '  > ', closing: '  > ```', newline: '\r\n' },
  ];

  for (const [caseIndex, item] of cases.entries()) {
    const privateMarker = `MALFORMED-INFO-PRIVATE-${caseIndex}`;
    const markdown = [
      '# Outside #outside [[Outside Link]]',
      item.opening,
      `${item.continuation}id: malformed-${caseIndex}`,
      `${item.continuation}claim: ${privateMarker} #malformed-${caseIndex} [[Malformed Link ${caseIndex}]]`,
      `${item.continuation}private_notes: ${privateMarker}`,
      `${item.continuation}- [ ] ${privateMarker}`,
      item.closing,
      '- [ ] Outside task',
    ].join(item.newline);
    const projected = publicEvidenceContent(markdown);

    assert.doesNotMatch(projected, new RegExp(`${privateMarker}|malformed-${caseIndex}|Malformed Link ${caseIndex}`));
    assert.deepEqual(publicNoteMetadata(markdown), {
      tags: ['outside'],
      links: ['Outside Link'],
      excerpt: 'Outside outside Outside Link Outside task',
    });
    assert.deepEqual(parsePublicEvidenceReceipts(markdown, `Malformed-${caseIndex}.md`), []);
    assert.deepEqual(parseEvidenceReceipts(markdown, `Malformed-${caseIndex}.md`), []);
    assert.deepEqual(parsePublicTasks(markdown, `Malformed-${caseIndex}.md`).map(({ line, text }) => ({ line, text })), [
      { line: 8, text: 'Outside task' },
    ]);
    assert.equal(isPublicTaskLine(markdown, 6), false);
    assert.equal(publicEvidenceContent(projected), projected);
  }

  const unclosed = [
    '# Outside',
    '~~~safire-private-evidence extra',
    'claim: UNCLOSED-MALFORMED-PRIVATE #unclosed-private [[Unclosed Private Link]]',
    '- [ ] UNCLOSED-MALFORMED-PRIVATE',
  ].join('\r\n');
  assert.doesNotMatch(publicEvidenceContent(unclosed), /UNCLOSED-MALFORMED|unclosed-private|Unclosed Private Link/);
  assert.deepEqual(parsePublicTasks(unclosed, 'Unclosed malformed.md'), []);

  for (const ordinary of [
    ['```safire-plugin', 'ordinary plugin sample', '```'].join('\n'),
    ['~~~evidence-report', 'ordinary evidence report sample', '~~~'].join('\r\n'),
    ['> ```typescript', '> const evidence = "ordinary";', '> ```'].join('\n'),
  ]) assert.equal(publicEvidenceContent(ordinary), ordinary);
});

test('mismatched and unclosed sensitive fences fail closed while unrelated fences remain byte-identical', () => {
  const sensitiveCases = [
    ['~~~safire-evidence', '```'],
    ['````safire-evidence', '```'],
    ['> ```safire-evidence', '```'],
  ];
  for (const [opening, wrongClose] of sensitiveCases) {
    const markdown = [opening, 'private_notes: UNCLOSED-PRIVATE #private [[Private Link]]', wrongClose, 'OUTSIDE-AFTER-UNCERTAIN'].join('\r\n');
    const projected = publicEvidenceContent(markdown);
    assert.doesNotMatch(projected, /UNCLOSED-PRIVATE|#private|Private Link|OUTSIDE-AFTER-UNCERTAIN/);
  }

  for (const ordinary of [
    ['~~~markdown', 'private_notes: ordinary #ordinary [[Ordinary Link]]', '~~~'].join('\n'),
    ['````typescript', '```safire-evidence', 'private_notes: ordinary', '```', '````'].join('\r\n'),
  ]) assert.equal(publicEvidenceContent(ordinary), ordinary);
});

test('public task parsing uses a line-preserving visibility mask for all fenced and uncertain content', () => {
  const markdown = [
    '- [ ] Public first',
    '```markdown',
    '- [ ] Ordinary fenced task',
    '```',
    '> ~~~safire-evidence',
    '- [ ] Malformed-depth private task #private [[Private Link]]',
    '> ~~~',
    '- [x] Public second',
    '```safire-evidence extra',
    '- [ ] Malformed-info private task',
    '```',
  ].join('\r\n');

  assert.deepEqual(parsePublicTasks(markdown, 'Tasks.md'), [
    { id: 'Tasks.md:1', path: 'Tasks.md', line: 1, text: 'Public first', completed: false },
    { id: 'Tasks.md:8', path: 'Tasks.md', line: 8, text: 'Public second', completed: true },
  ]);
  assert.equal(isPublicTaskLine(markdown, 1), true);
  assert.equal(isPublicTaskLine(markdown, 6), false);
  assert.equal(isPublicTaskLine(markdown, 8), true);
  assert.equal(isPublicTaskLine(markdown, 10), false);

  const unclosed = ['- [ ] Public', '~~~safire-evidence', 'private_notes: |', '- [ ] Private', '- [ ] Structurally uncertain'].join('\n');
  assert.deepEqual(parsePublicTasks(unclosed, 'Unclosed.md').map(task => task.line), [1]);
});

test('public task and evidence receipt parsing honor zero and finite result limits', () => {
  const taskMarkdown = [
    '- [ ] First',
    '```safire-evidence',
    'private_notes: |-',
    '  - [ ] Hidden',
    '```',
    '- [x] Second',
    '- [ ] Third',
  ].join('\n');
  assert.deepEqual(parsePublicTasks(taskMarkdown, 'Limited.md', { limit: 0 }), []);
  assert.deepEqual(parsePublicTasks(taskMarkdown, 'Limited.md', { limit: 2 }).map(task => task.text), ['First', 'Second']);
  assert.deepEqual(parsePublicTasks(taskMarkdown, 'Limited.md').map(task => task.text), ['First', 'Second', 'Third']);

  const receiptMarkdown = [1, 2, 3].map(index => [
    '```safire-evidence',
    `id: receipt-${index}`,
    `claim: Receipt ${index}`,
    `private_notes: PRIVATE-RECEIPT-${index}`,
    '```',
  ].join('\n')).join('\n');
  assert.deepEqual(parseEvidenceReceipts(receiptMarkdown, 'Limited.md', { limit: 0 }), []);
  assert.deepEqual(parseEvidenceReceipts(receiptMarkdown, 'Limited.md', { limit: 2 }).map(receipt => receipt.id), ['receipt-1', 'receipt-2']);
  assert.deepEqual(parsePublicEvidenceReceipts(receiptMarkdown, 'Limited.md', { limit: 2 }).map(receipt => receipt.id), ['receipt-1', 'receipt-2']);
  assert.deepEqual(parsePublicEvidenceReceipts(receiptMarkdown, 'Limited.md').map(receipt => receipt.id), ['receipt-1', 'receipt-2', 'receipt-3']);
});

test('receipt parsing supports bounded multiline YAML scalars without root-field promotion', () => {
  const cases = [
    ['|', 'Public line one\nPublic line two\n'],
    ['|-', 'Public line one\nPublic line two'],
    ['|+', 'Public line one\nPublic line two\n\n'],
    ['>', 'Public line one Public line two\n'],
    ['>-', 'Public line one Public line two'],
    ['>+', 'Public line one Public line two\n\n'],
    ['|2-', 'Public line one\nPublic line two'],
    ['>2-', 'Public line one Public line two'],
    ['|+2', 'Public line one\nPublic line two\n'],
    ['>-2', 'Public line one Public line two'],
  ];

  for (const newline of ['\n', '\r\n']) {
    for (const [indicator, expectedClaim] of cases) {
      const keepBlank = indicator.endsWith('+');
      const markdown = [
        '```safire-evidence',
        `id: multiline-${indicator.replace(/[^A-Za-z0-9]/g, '') || 'plain'}`,
        `claim: ${indicator}`,
        '  Public line one',
        '  Public line two',
        ...(keepBlank ? [''] : []),
        'private_notes: |-',
        '  RECEIPT-PRIVATE #private [[Private Link]]',
        'status: verified',
        '```',
      ].join(newline);
      const [receipt] = parsePublicEvidenceReceipts(markdown, 'Receipt.md');
      assert.equal(receipt.claim, expectedClaim);
      assert.equal(receipt.status, 'verified');
      assert.equal(receipt.privateNotes, undefined);
    }
  }
});

test('multiline receipt continuations cannot overwrite root fields and explicit parsing retains private notes', () => {
  const markdown = [
    '```safire-evidence',
    'id: multiline',
    'claim: >-',
    '  Public line one: with colon',
    '  status: conflicting',
    '  source_type: url',
    'source_type: manual_observation',
    'status: verified',
    'private_notes: |-',
    '  PRIVATE-RECEIPT-NOTE',
    '```',
    '',
    '~~~safire-evidence',
    'id: second',
    'claim: Second receipt',
    'status: stale',
    '~~~',
  ].join('\n');

  const publicReceipts = parsePublicEvidenceReceipts(markdown, 'Receipts.md');
  assert.equal(publicReceipts.length, 2);
  assert.equal(publicReceipts[0].claim, 'Public line one: with colon status: conflicting source_type: url');
  assert.equal(publicReceipts[0].sourceType, 'manual_observation');
  assert.equal(publicReceipts[0].status, 'verified');
  assert.equal(publicReceipts[0].privateNotes, undefined);

  const explicitReceipts = parseEvidenceReceipts(markdown, 'Receipts.md');
  assert.equal(explicitReceipts[0].privateNotes, 'PRIVATE-RECEIPT-NOTE');
  assert.equal(explicitReceipts[1].claim, 'Second receipt');

  const malformed = ['```safire-evidence', 'id: broken', 'claim: [not closed', 'status: verified', '```'].join('\n');
  assert.deepEqual(parsePublicEvidenceReceipts(malformed, 'Broken.md'), []);
});

test('folded receipt scalars preserve paragraph and more-indented line breaks', () => {
  const markdown = [
    '```safire-evidence',
    'id: folded-paragraphs',
    'claim: >-',
    '  First line',
    '  continued',
    '',
    '  Second paragraph',
    '    more-indented',
    '  final line',
    'status: verified',
    '```',
  ].join('\n');
  const [receipt] = parsePublicEvidenceReceipts(markdown, 'Folded.md');
  assert.equal(receipt.claim, 'First line continued\nSecond paragraph\n  more-indented\nfinal line');
});

test('evidence projection recognizes unordered, ordered, nested, and blockquoted list containers', () => {
  const cases = [
    { opening: '- ~~~safire-evidence', continuation: '  ', closing: '  ~~~' },
    { opening: '+ ```SAFIRE-EVIDENCE', continuation: '  ', closing: '  ```' },
    { opening: '* ~~~~safire-evidence', continuation: '  ', closing: '  ~~~~' },
    { opening: '10. ~~~safire-evidence', continuation: '    ', closing: '    ~~~' },
    { opening: '2) ~~~safire-evidence', continuation: '   ', closing: '   ~~~' },
    { opening: '- 1. ~~~safire-evidence', continuation: '     ', closing: '     ~~~' },
    { opening: '> - ~~~safire-evidence', continuation: '>   ', closing: '>   ~~~' },
    { opening: '- > ~~~safire-evidence', continuation: '  > ', closing: '  > ~~~' },
    { opening: '> 3) - ~~~safire-evidence', continuation: `> ${' '.repeat(5)}`, closing: `> ${' '.repeat(5)}~~~` },
  ];

  for (const [caseIndex, container] of cases.entries()) {
    const markdown = [
      container.opening,
      `${container.continuation}id: list-${caseIndex}`,
      `${container.continuation}claim: Public list claim ${caseIndex} #list-public-${caseIndex} [[List Public ${caseIndex}]]`,
      `${container.continuation}private_notes: |-`,
      `${container.continuation}  - [ ] LIST-PRIVATE-${caseIndex} #list-private-${caseIndex} [[List Private ${caseIndex}]]`,
      container.closing,
      `- [ ] Outside task ${caseIndex}`,
    ].join(caseIndex % 2 ? '\r\n' : '\n');
    const projected = publicEvidenceContent(markdown);
    assert.match(projected, new RegExp(`Public list claim ${caseIndex}`));
    assert.doesNotMatch(projected, new RegExp(`LIST-PRIVATE-${caseIndex}|list-private-${caseIndex}|List Private ${caseIndex}`));
    assert.deepEqual(publicNoteMetadata(markdown).tags, [`list-public-${caseIndex}`]);
    assert.deepEqual(publicNoteMetadata(markdown).links, [`List Public ${caseIndex}`]);
    assert.deepEqual(parsePublicTasks(markdown, `List-${caseIndex}.md`).map(task => ({ line: task.line, text: task.text })), [
      { line: 7, text: `Outside task ${caseIndex}` },
    ]);
    assert.equal(isPublicTaskLine(markdown, 5), false);
    assert.equal(isPublicTaskLine(markdown, 7), true);
  }
});

test('malformed and unclosed list-contained evidence fails closed with line-preserving task masking', () => {
  const malformed = [
    '1. ~~~safire-evidence extra',
    '   claim: MALFORMED-LIST-PUBLIC',
    '   private_notes: MALFORMED-LIST-PRIVATE #private [[Private Link]]',
    '   ~~~',
    '- [ ] Public after malformed block',
  ].join('\r\n');
  const malformedProjection = publicEvidenceContent(malformed);
  assert.doesNotMatch(malformedProjection, /MALFORMED-LIST|#private|Private Link|extra/);
  assert.deepEqual(parsePublicTasks(malformed, 'Malformed List.md').map(task => task.line), [5]);

  for (const unclosed of [
    ['- ~~~~safire-evidence', '  private_notes: LIST-UNCLOSED-PRIVATE', '  ~~~', '- [ ] UNCERTAIN-TASK'],
    ['> - ~~~safire-evidence', '>   private_notes: LIST-MISMATCHED-PRIVATE', '>   ```', '- [ ] UNCERTAIN-TASK'],
    ['- 1. ~~~safire-evidence', '     private_notes: LIST-EOF-PRIVATE', '     - [ ] UNCERTAIN-TASK'],
  ].map(lines => lines.join('\n'))) {
    const projected = publicEvidenceContent(unclosed);
    assert.doesNotMatch(projected, /LIST-(?:UNCLOSED|MISMATCHED|EOF)-PRIVATE|UNCERTAIN-TASK/);
    assert.equal(publicEvidenceContent(projected), projected);
    assert.deepEqual(parsePublicTasks(unclosed, 'Unclosed List.md'), []);
  }
});

test('ordinary list-contained code fences remain byte-identical and non-task content remains public', () => {
  const markdown = [
    '- ~~~markdown',
    '  Ordinary code #ordinary-code [[Ordinary Code Link]]',
    '  - [ ] Ordinary fenced task',
    '  ~~~',
    '- [ ] Outside public task',
  ].join('\r\n');
  assert.equal(publicEvidenceContent(markdown), markdown);
  assert.match(publicEvidenceContent(markdown), /Ordinary code #ordinary-code/);
  assert.deepEqual(parsePublicTasks(markdown, 'Ordinary List.md').map(task => ({ line: task.line, text: task.text })), [
    { line: 5, text: 'Outside public task' },
  ]);
});

test('generic metadata excludes ordinary fenced code while the evidence-only projection preserves it', () => {
  const markdown = [
    '# Visible prose #visible [[Visible Link]]',
    '',
    '```text',
    'SYNTH-FENCED-MARKER #fenced-private [[Fenced Private Link]]',
    '```',
  ].join('\n');

  assert.equal(publicEvidenceContent(markdown), markdown);
  assert.deepEqual(publicNoteMetadata(markdown), {
    tags: ['visible'],
    links: ['Visible Link'],
    excerpt: 'Visible prose visible Visible Link',
  });
});

test('generic index projection removes ordinary fences across delimiters, containers, and line endings', () => {
  const cases = [
    { opening: '```text', continuation: '', closing: '```', fenceLike: '``', newline: '\n' },
    { opening: '~~~javascript', continuation: '', closing: '~~~', fenceLike: '~~', newline: '\r\n' },
    { opening: '``````text', continuation: '', closing: '``````', fenceLike: '```', newline: '\n' },
    { opening: '> ```text', continuation: '> ', closing: '> ```', fenceLike: '> ``', newline: '\r\n' },
    { opening: '- ~~~~text', continuation: '  ', closing: '  ~~~~', fenceLike: '  ~~~', newline: '\n' },
    { opening: '10. ~~~text', continuation: '    ', closing: '    ~~~', fenceLike: '    ~~', newline: '\r\n' },
    { opening: '> 3) - `````text', continuation: `> ${' '.repeat(5)}`, closing: `> ${' '.repeat(5)}` + '`````', fenceLike: `> ${' '.repeat(5)}` + '```', newline: '\n' },
  ];

  for (const [caseIndex, item] of cases.entries()) {
    const marker = `SYNTH-FENCED-MARKER-${caseIndex}`;
    const nestedFence = item.opening.includes('`') ? '~~~' : '```';
    const markdown = [
      `Visible before ${caseIndex} #outside-${caseIndex} [[Outside ${caseIndex}]]`,
      item.opening,
      `${item.continuation}${marker} #fenced-${caseIndex} [[Fenced Link ${caseIndex}]]`,
      item.fenceLike,
      `${item.continuation}${nestedFence}safire-evidence`,
      `${item.continuation}claim: MUST-NOT-PROMOTE-${caseIndex} #promoted-${caseIndex} [[Promoted ${caseIndex}]]`,
      `${item.continuation}${nestedFence}`,
      item.closing,
      `Visible after ${caseIndex}`,
    ].join(item.newline);

    const projected = genericIndexContent(markdown);
    assert.match(projected, new RegExp(`Visible before ${caseIndex}`));
    assert.match(projected, new RegExp(`Visible after ${caseIndex}`));
    assert.doesNotMatch(projected, new RegExp(`${marker}|MUST-NOT-PROMOTE-${caseIndex}|fenced-${caseIndex}|promoted-${caseIndex}|Fenced Link ${caseIndex}|Promoted ${caseIndex}`));
    assert.deepEqual(publicNoteMetadata(markdown).tags, [`outside-${caseIndex}`]);
    assert.deepEqual(publicNoteMetadata(markdown).links, [`Outside ${caseIndex}`]);
    assert.doesNotMatch(semanticMarkdownContent(markdown), new RegExp(`${marker}|MUST-NOT-PROMOTE-${caseIndex}`));

    // Explicit reads retain the raw input, and the evidence-only projection
    // also leaves ordinary code byte-identical. Generic indexes see less.
    assert.equal(publicEvidenceContent(markdown), markdown);
    assert.match(markdown, new RegExp(marker));
  }
});

test('generic index projection exposes only validated public evidence fields and fails closed otherwise', () => {
  for (const newline of ['\n', '\r\n']) {
    const markdown = [
      '# Outside #outside [[Outside Link]]',
      '> - ~~~~safire-evidence',
      '>   id: public-receipt',
      '>   claim: PUBLIC-EVIDENCE-MARKER #public-evidence [[Public Evidence Link]]',
      '>   status: verified',
      '>   private_notes: PRIVATE-EVIDENCE-MARKER #private-evidence [[Private Evidence Link]]',
      '>   ~~~~',
      '',
      '```text',
      'ORDINARY-CODE-MARKER #ordinary-code [[Ordinary Code Link]]',
      '```',
    ].join(newline);
    const projected = genericIndexContent(markdown);

    assert.match(projected, /Outside/);
    assert.match(projected, /public-receipt|PUBLIC-EVIDENCE-MARKER|verified/);
    assert.doesNotMatch(projected, /PRIVATE-EVIDENCE-MARKER|private-evidence|Private Evidence Link|ORDINARY-CODE-MARKER|ordinary-code|Ordinary Code Link/);
    assert.deepEqual(publicNoteMetadata(markdown).tags, ['outside', 'public-evidence']);
    assert.deepEqual(publicNoteMetadata(markdown).links, ['Outside Link', 'Public Evidence Link']);
    assert.match(semanticMarkdownContent(markdown), /PUBLIC-EVIDENCE-MARKER/);

    const [explicitReceipt] = parseEvidenceReceipts(markdown, 'Evidence.md');
    assert.equal(explicitReceipt.privateNotes, 'PRIVATE-EVIDENCE-MARKER #private-evidence [[Private Evidence Link]]');
    const [publicReceipt] = parsePublicEvidenceReceipts(markdown, 'Evidence.md');
    assert.equal(publicReceipt.claim, 'PUBLIC-EVIDENCE-MARKER #public-evidence [[Public Evidence Link]]');
    assert.equal(publicReceipt.privateNotes, undefined);
  }

  const failClosedCases = [
    ['```safire-evidence extra', 'claim: MALFORMED-INFO-PUBLIC', 'private_notes: MALFORMED-INFO-PRIVATE', '```'].join('\n'),
    ['~~~safire-evidence', 'claim: INVALID-FIELD-PUBLIC', 'unknown_private: INVALID-FIELD-PRIVATE', '~~~'].join('\r\n'),
    ['````safire-evidence', 'claim: UNCLOSED-EVIDENCE-PUBLIC', 'private_notes: UNCLOSED-EVIDENCE-PRIVATE', '```'].join('\n'),
  ];
  for (const markdown of failClosedCases) {
    const projected = genericIndexContent(`# Outside\n${markdown}`);
    assert.equal(projected.trim(), '# Outside');
    assert.doesNotMatch(projected, /(?:MALFORMED|INVALID|UNCLOSED)-(?:INFO|FIELD|EVIDENCE)-(?:PUBLIC|PRIVATE)/);
  }
});

test('generic index projection strips nested fences from public evidence scalars without promoting them', () => {
  const cases = [
    {
      outer: '````',
      inner: '~~~',
      marker: 'INNER-TILDE-CODE',
      tag: 'inner-tilde',
      link: 'Inner Tilde Link',
    },
    {
      outer: '~~~~',
      inner: '```',
      marker: 'INNER-BACKTICK-CODE',
      tag: 'inner-backtick',
      link: 'Inner Backtick Link',
    },
  ];

  for (const item of cases) {
    const markdown = [
      `${item.outer}safire-evidence`,
      `id: public-nested-${item.marker.startsWith('INNER-TILDE') ? 'one' : 'two'}`,
      'claim: |',
      '  Visible claim before #claim-visible [[Visible Claim Link]]',
      `  ${item.inner}text`,
      `  ${item.marker} #${item.tag} [[${item.link}]]`,
      `  ${item.inner}`,
      '  Visible claim after',
      'status: verified',
      item.outer,
    ].join('\n');

    const projected = genericIndexContent(markdown);
    assert.match(projected, /Visible claim before|Visible claim after/);
    assert.doesNotMatch(projected, new RegExp(`${item.marker}|${item.tag}|${item.link}`));
    assert.deepEqual(publicNoteMetadata(markdown).tags, ['claim-visible']);
    assert.deepEqual(publicNoteMetadata(markdown).links, ['Visible Claim Link']);

    const [receipt] = parsePublicEvidenceReceipts(markdown, 'Nested.md');
    assert.equal(receipt.claim, '');
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(`${item.marker}|${item.tag}|${item.link}`));
  }

  const foldedScalarCases = [
    [
      'claim: "Visible double-quoted claim',
      '~~~text',
      'INNER-DOUBLE-QUOTED-CODE #inner-double [[Inner Double Link]]',
      '~~~',
      '"',
    ],
    [
      "claim: 'Visible single-quoted claim",
      '```text',
      'INNER-SINGLE-QUOTED-CODE #inner-single [[Inner Single Link]]',
      '```',
      "'",
    ],
    [
      'claim: [',
      '  Visible flow claim,',
      '  ~~~text,',
      '  INNER-FLOW-CODE #inner-flow [[Inner Flow Link]],',
      '  ~~~',
      ']',
    ],
  ];
  for (const [caseIndex, scalarLines] of foldedScalarCases.entries()) {
    const markdown = [
      '````safire-evidence',
      `id: folded-${caseIndex}`,
      ...scalarLines,
      'status: verified',
      '````',
    ].join('\n');
    const generic = genericIndexContent(markdown);
    const receipts = parsePublicEvidenceReceipts(markdown, 'Folded.md');
    assert.doesNotMatch(generic, /INNER-(?:DOUBLE-QUOTED|SINGLE-QUOTED|FLOW)-CODE|inner-(?:double|single|flow)|Inner (?:Double|Single|Flow) Link/);
    assert.doesNotMatch(JSON.stringify(receipts), /INNER-(?:DOUBLE-QUOTED|SINGLE-QUOTED|FLOW)-CODE|inner-(?:double|single|flow)|Inner (?:Double|Single|Flow) Link/);
  }

  const nestedEvidence = [
    '````safire-evidence',
    'id: outer-public',
    'claim: |',
    '  ```safire-evidence',
    '  claim: MUST-NOT-BE-PROMOTED #nested-promoted [[Nested Promoted Link]]',
    '  ```',
    'status: verified',
    '````',
  ].join('\n');
  assert.doesNotMatch(genericIndexContent(nestedEvidence), /MUST-NOT-BE-PROMOTED|nested-promoted|Nested Promoted Link/);
  assert.doesNotMatch(JSON.stringify(parsePublicEvidenceReceipts(nestedEvidence, 'Nested.md')), /MUST-NOT-BE-PROMOTED|nested-promoted|Nested Promoted Link/);
});
