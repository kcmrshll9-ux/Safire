import fs from 'node:fs/promises';
import path from 'node:path';

const target = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!target) throw new Error('Pass an empty disposable vault directory');

await fs.mkdir(target, { recursive: true });
const existing = await fs.readdir(target);
if (existing.length > 0) throw new Error('Disposable vault directory must be empty');

const project = 'Graph UX Demo';
const projectRoot = path.join(target, project);
const reports = Array.from({ length: 25 }, (_, index) => `Report ${String(index + 1).padStart(2, '0')}`);
const insights = Array.from({ length: 16 }, (_, index) => `Insight ${String(index + 1).padStart(2, '0')}`);
const references = ['Report Index', 'Feature Requests', 'Agent Guidance'];
await Promise.all(['Reports', 'Insights', 'Reference'].map(folder => fs.mkdir(path.join(projectRoot, folder), { recursive: true })));

const wikiLinks = values => values.map(value => `- [[${value}]]`).join('\n');
const projectLink = value => `${project}/${value}`;
const allEntries = [
  ...reports.map(name => projectLink(`Reports/${name}`)),
  ...insights.map(name => projectLink(`Insights/${name}`)),
  ...references.map(name => projectLink(`Reference/${name}`)),
];
await fs.writeFile(
  path.join(projectRoot, `${project} Project.md`),
  `# ${project} Project\n\nSynthetic visual-QA project.\n\n## Entries\n\n${wikiLinks(allEntries)}\n`,
  'utf8',
);

for (let index = 0; index < reports.length; index += 1) {
  const linkedInsights = [insights[index % insights.length], insights[(index + 5) % insights.length]];
  await fs.writeFile(
    path.join(projectRoot, 'Reports', `${reports[index]}.md`),
    `# ${reports[index]}\n\nSynthetic report for graph layout verification.\n\n${wikiLinks(linkedInsights.map(name => projectLink(`Insights/${name}`)))}\n`,
    'utf8',
  );
}

for (const insight of insights) {
  await fs.writeFile(
    path.join(projectRoot, 'Insights', `${insight}.md`),
    `# ${insight}\n\nSynthetic insight for graph layout verification.\n`,
    'utf8',
  );
}

await fs.writeFile(
  path.join(projectRoot, 'Reference', 'Report Index.md'),
  `# Report Index\n\n${wikiLinks(reports.map(name => projectLink(`Reports/${name}`)))}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(projectRoot, 'Reference', 'Feature Requests.md'),
  `# Feature Requests\n\n${wikiLinks(reports.slice(0, 5).map(name => projectLink(`Reports/${name}`)))}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(projectRoot, 'Reference', 'Agent Guidance.md'),
  `# Agent Guidance\n\n${wikiLinks(insights.slice(0, 6).map(name => projectLink(`Insights/${name}`)))}\n`,
  'utf8',
);

process.stdout.write(`${target}\n`);
