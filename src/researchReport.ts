import type { LibraryNote } from './libraryModel';

type ReportReceipt = { claim: string; source: string; status: string; expired: boolean; observedAt: string };
type ReportNote = LibraryNote & { evidence: ReportReceipt[] };
const escape = (value: string) => value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const safeSource = (value: string) => { try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };

export function buildResearchReport(chosen: ReportNote[], title: string, summary: string, date: string) {
    const lines=[`# ${title}`,`Prepared ${date}`,summary,...chosen.flatMap(note=>[
      `## ${note.title}`,note.reportExcerpt || '',...note.evidence.flatMap(receipt=>[
        `### ${receipt.claim || 'Evidence'}`,`Status recorded by author: ${receipt.status}${receipt.expired?' · review overdue':''}`,
        safeSource(receipt.source) ? `Source: ${safeSource(receipt.source)}` : 'Source: local or manually recorded',
        receipt.observedAt ? `Observed: ${receipt.observedAt}` : '',
      ]),
    ])].filter(Boolean);
  const markdown = lines.join('\n\n') + '\n';
  const body = lines.map(line => line.startsWith('### ') ? `<h3>${escape(line.slice(4))}</h3>` : line.startsWith('## ') ? `<h2>${escape(line.slice(3))}</h2>` : line.startsWith('# ') ? `<h1>${escape(line.slice(2))}</h1>` : `<p>${escape(line)}</p>`).join('\n');
  return { markdown, html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{max-width:760px;margin:70px auto;padding:0 32px;background:#fbfaf5;color:#293a30;font:16px/1.75 'Segoe UI',system-ui,sans-serif}h1{font:48px/1.15 Georgia,serif;margin:30px 0;border-bottom:3px solid #42614e;padding-bottom:30px}h2{margin-top:48px;font:30px Georgia,serif}h3{margin-top:30px;font-size:18px}h1,h2,h3{overflow-wrap:anywhere}p{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#657168;letter-spacing:.12em}footer{border-top:1px solid #d3d9cc;margin-top:50px;padding-top:20px;color:#657168;font-size:12px}@media print{body{margin:0 auto;background:white}h2,h3{break-after:avoid}p{orphans:3;widows:3}}</style><body><small>SAFIRE / RESEARCH BRIEF</small>${body}<footer>Prepared in Safire. Evidence statuses are the author's recorded assessments. Private receipt fields and local source fields are excluded. Review ordinary note prose and your summary before sharing.</footer></body></html>` };
}
