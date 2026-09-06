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
  return { markdown, html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{max-width:760px;margin:70px auto;padding:0 32px;color:#26332d;font:16px/1.75 system-ui}h1{font:48px/1.15 Georgia;margin:30px 0;border-bottom:3px solid #ae663e;padding-bottom:30px}h2{margin-top:48px;font:30px Georgia}h3{margin-top:30px;font-size:18px}p{white-space:pre-wrap;overflow-wrap:anywhere}footer{border-top:1px solid #ddd;margin-top:50px;padding-top:20px;color:#666;font-size:12px}@media print{body{margin:0 auto}h2,h3{break-after:avoid}p{orphans:3;widows:3}}</style><body><small>SAFIRE / RESEARCH BRIEF</small>${body}<footer>Prepared in Safire. Evidence statuses are the author's recorded assessments. Private receipt fields and local source paths are excluded.</footer></body></html>` };
}
