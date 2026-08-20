import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('in-app Help covers every primary Safire workflow', async () => {
  const help = await fs.readFile(path.join(projectRoot, 'src', 'HelpPanel.tsx'), 'utf8');
  for (const topic of [
    'Start here',
    'Projects & notes',
    'Daily work',
    'Templates & web clips',
    'Research & recovery',
    'Use cases',
    'Connect an AI assistant',
    'AI prompt library',
    'Reference & troubleshooting',
    'Privacy & safety',
    'About & licenses',
  ]) assert.match(help, new RegExp(topic.replace(/[&]/g, '&')));

  for (const workflow of [
    'Change Vault Location',
    'Create your first project',
    'Add a project entry',
    'Project graph',
    'Delete entry',
    'Wikilinks',
    'Daily notes',
    'Markdown tasks',
    'Quick capture',
    'New from template',
    'Web Clipper',
    'Evidence receipts',
    'Relationship graph',
    'Backups and restore',
    'Attachments and images',
  ]) assert.match(help, new RegExp(workflow));

  for (const token of ['{{title}}', '{{date}}', '{{time}}', '{{url}}', '{{content}}', '{{citations}}']) {
    assert.match(help, new RegExp(token.replace(/[{}]/g, '\\$&')));
  }
});

test('AI Help documents exact Safire tools, safe writes, Hermes, and OpenClaw', async () => {
  const help = await fs.readFile(path.join(projectRoot, 'src', 'HelpPanel.tsx'), 'utf8');
  for (const tool of ['list_notes', 'read_note', 'create_note', 'update_note', 'quick_capture', 'list_tasks', 'toggle_task', 'vault_health']) {
    assert.match(help, new RegExp(`\\b${tool}\\b`));
  }

  assert.match(help, /Node\.js 22\.19\.0 or newer/);
  assert.match(help, /current eight-tool vault MCP has no stable external launcher/);
  assert.match(help, /hermes mcp add safire --command node --connect-timeout 30 --args/);
  assert.match(help, /hermes mcp test safire/);
  assert.match(help, /mcp_servers:/);
  assert.match(help, /openclaw mcp add safire --command node --arg/);
  assert.match(help, /openclaw mcp doctor safire --probe/);
  assert.match(help, /openclaw agent --agent main --message/);
  assert.match(help, /mcp:\s*\{/);
  assert.match(help, /Do not use openclaw mcp serve/);
  assert.match(help, /Do not use hermes mcp serve/);
  assert.match(help, /update_note replaces the complete note body/);
  assert.match(help, /Default to read-only behavior/);
  assert.match(help, /https:\/\/docs\.openclaw\.ai\/cli\/mcp/);
  assert.match(help, /github\.com\/NousResearch\/hermes-agent/);
});

test('Help is searchable, responsive, licensed, and reachable from every app surface', async () => {
  const [help, main, styles, desktop] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'src', 'HelpPanel.tsx'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src', 'main.tsx'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src', 'styles.css'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'electron', 'main.cjs'), 'utf8'),
  ]);

  assert.match(help, /type="search"/);
  assert.match(help, /aria-current=/);
  assert.match(help, /role="dialog"/);
  assert.match(help, /import mitLicenseText from '\.\.\/LICENSE\?raw';/);
  assert.match(help, /Third-party software notices/);
  assert.match(help, /Copyright © 2026 Safire/);
  assert.match(main, /import \{ HelpPanel \} from '\.\/HelpPanel';/);
  assert.match(main, /<HelpPanel/);
  assert.match(main, /version=\{APP_VERSION\}/);
  assert.match(main, /Safire Help/);
  assert.match(desktop, /label: 'Safire Help'/);
  assert.match(styles, /\.help-layout\s*\{/);
  assert.match(styles, /\.help-topic-select/);
  assert.match(styles, /@media \(max-width: 760px\)/);
});

test('in-app Help replaces the standalone desktop user guide', async () => {
  const standaloneGuide = path.join(projectRoot, 'docs', 'Safire User Guide.html');
  const [packageJson, desktop, main, docsIndex] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(projectRoot, 'electron', 'main.cjs'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src', 'main.tsx'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'docs', 'README.md'), 'utf8'),
  ]);

  assert.ok(!packageJson.build.files.includes('docs/Safire User Guide.html'));
  assert.doesNotMatch(desktop, /Open User Guide|Safire User Guide|guidePath/);
  assert.match(desktop, /label: 'Safire Help'/);
  assert.doesNotMatch(main, /Open User Guide|Safire User Guide/);
  assert.match(main, /Safire Help/);
  assert.doesNotMatch(docsIndex, /\[Safire User Guide\]\(Safire%20User%20Guide\.html\)/);
  assert.match(docsIndex, /searchable in-app Help Center is the complete current software guide/);
  await assert.rejects(fs.stat(standaloneGuide), { code: 'ENOENT' });
});

test('New from template refreshes the list and explains supported tokens', async () => {
  const main = await fs.readFile(path.join(projectRoot, 'src', 'main.tsx'), 'utf8');
  assert.match(main, /const openTemplatePicker = React\.useCallback\(async \(\) => \{/);
  assert.match(main, /await loadTemplates\(\);\s*setTemplatePickerOpen\(true\);/);
  assert.match(main, /Put a <code>\.md<\/code> file under <code>Templates\/<\/code>/);
  for (const token of ['{{title}}', '{{date}}', '{{time}}']) {
    assert.match(main, new RegExp(token.replace(/[{}]/g, '\\$&')));
  }
});
