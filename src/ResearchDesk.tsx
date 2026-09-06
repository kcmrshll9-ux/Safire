import React from 'react';
import { useDialogAccessibility } from './useDialogAccessibility';
import type { LibraryNote } from './libraryModel';

type Receipt = { id: string; claim: string; source: string; sourceType: string; status: string; observedAt: string; freshness: string; expired: boolean };
type ResearchNote = LibraryNote & { evidence: Receipt[] };
type Page = { notes: ResearchNote[]; total: number; nextOffset: number | null; reason: string };
import { buildResearchReport, safeSource } from './researchReport';
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const anchor = document.createElement('a'); anchor.href=url; anchor.download=name; anchor.click();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function ResearchDesk({ open, clip, create }: { open: (path:string)=>void; clip:()=>void; create:()=>void }) {
  const [page,setPage] = React.useState<Page>({ notes:[],total:0,nextOffset:null,reason:'' });
  const [filter,setFilter] = React.useState('');
  const [query,setQuery] = React.useState('');
  const [loading,setLoading] = React.useState(true);
  const [error,setError] = React.useState('');
  const [selected,setSelected] = React.useState(new Map<string,ResearchNote>());
  const [report,setReport] = React.useState(false);
  const reportRef = useDialogAccessibility(report, ()=>setReport(false));
  const requestVersion = React.useRef(0);
  const [loadingMore,setLoadingMore] = React.useState(false);
  const [title,setTitle] = React.useState('Research brief');
  const [summary,setSummary] = React.useState('');
  React.useEffect(()=> {
    requestVersion.current++;
    const abort = new AbortController();
    setLoading(true);
    const timer=setTimeout(()=> {
      fetch(`/api/library?evidence=1&limit=50&q=${encodeURIComponent([query,filter].filter(Boolean).join(' '))}`,{signal:abort.signal})
        .then(async response=>{ if(!response.ok) throw new Error('Could not load research'); return response.json(); })
        .then(data=>{setPage(data);setError('');})
        .catch(reason=>{if(!abort.signal.aborted)setError(reason.message);})
        .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    },150);
    return ()=>{clearTimeout(timer);abort.abort();};
  },[filter,query]);
  const exportReport = (format: 'md'|'html') => {
    const chosen=[...selected.values()];
    const date=new Date().toLocaleDateString(undefined,{dateStyle:'long'});
    const report = buildResearchReport(chosen, title, summary, date);
    const name = title.replace(/[^a-z0-9 -]/gi, '').trim() || 'Research brief';
    download(`${name}.${format}`, format === 'md' ? report.markdown : report.html, format === 'md' ? 'text/markdown' : 'text/html');
  };
  return <section className="research-desk">
    <header className="research-header"><div><span className="eyebrow">COLLECT · QUESTION · CONNECT</span><h1>Your research desk.</h1><p>A clear view of what you know, where it came from, and what needs another look.</p></div><div className="desk-actions"><button onClick={clip}>＋ Capture a source</button><button className="primary-action" onClick={create}>Start a research note</button></div></header>
    <div className="research-toolbar"><input type="search" aria-label="Search evidence" placeholder="Find a claim, source, or topic…" value={query} onChange={event=>setQuery(event.target.value)}/><div role="group" aria-label="Evidence filter">{[['','All evidence'],['status:verified','Verified'],['status:conflicting','Conflicting'],['expired','Needs review']].map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div><button disabled={!selected.size} onClick={()=>setReport(true)}>Create brief · {selected.size}</button></div>
    {page.reason&&<p className="library-notice" role="status">{page.reason}</p>}{error&&<p role="alert">{error}</p>}
    {loading?<div className="research-empty">Gathering your sources…</div>:page.notes.length?<div className="evidence-board">{page.notes.map(note=><article key={note.path} className="evidence-card"><div className="evidence-card-top"><span>{note.folder||'Personal research'}</span><label><input type="checkbox" aria-label={`Include ${note.title} in brief`} checked={selected.has(note.path)} onChange={event=>setSelected(previous=>{const next=new Map(previous);if(event.target.checked)next.set(note.path,note);else next.delete(note.path);return next;})}/> Select</label></div><button className="evidence-note-title" onClick={()=>open(note.path)}>{note.title}<span>↗</span></button><p>{note.excerpt}</p><div className="evidence-claims">{note.evidence.slice(0,4).map((receipt,index)=><div key={`${receipt.id}-${index}`}><span className={`receipt-state ${receipt.expired?'stale':receipt.status}`}>{receipt.expired?'Review due':receipt.status}</span><strong>{receipt.claim||'Recorded evidence'}</strong><small>{safeSource(receipt.source)?new URL(receipt.source).hostname:'Local or manual source'}</small></div>)}</div><footer>{note.evidence.length} recorded {note.evidence.length===1?'claim':'claims'}<button onClick={()=>open(note.path)}>Review note →</button></footer></article>)}</div>:<div className="research-empty"><span>✳</span><h2>Give your ideas a foundation.</h2><p>Capture a source, then add an evidence receipt to record what it supports. Your claims and sources will come together here.</p><button className="primary-action" onClick={create}>Create your first research note</button></div>}
    {!loading&&page.nextOffset!==null&&<button className="load-more" disabled={loadingMore} onClick={async()=>{const version=requestVersion.current;setLoadingMore(true);try{const result=await fetch(`/api/library?evidence=1&limit=50&offset=${page.nextOffset}&q=${encodeURIComponent([query,filter].filter(Boolean).join(' '))}`).then(r=>{if(!r.ok)throw new Error();return r.json();});if(version===requestVersion.current)setPage(previous=>({...result,notes:[...previous.notes,...result.notes]}));}catch{setError('Could not load more sources');}finally{setLoadingMore(false);}}}>Load more sources</button>}
    {report&&<div className="modal-backdrop"><section ref={reportRef} className="panel-modal report-panel" role="dialog" aria-modal="true" aria-labelledby="report-title"><div className="panel-head"><div><span className="eyebrow">MAKE SOMETHING OF IT</span><h2 id="report-title">A brief worth sharing.</h2></div><button aria-label="Close report" onClick={()=>setReport(false)}>×</button></div><label>Report title<input value={title} onChange={event=>setTitle(event.target.value)}/></label><label>Your point of view<textarea placeholder="What do these sources tell you? Write your conclusion or executive summary." value={summary} onChange={event=>setSummary(event.target.value)}/></label><div className="report-includes">{selected.size} selected notes · Claims, source URLs, and recorded assessments.<br/>Private receipt fields and local source fields are excluded.</div><div className="dialog-actions"><button onClick={()=>exportReport('md')}>Export Markdown</button><button className="primary-action" onClick={()=>exportReport('html')}>Export designed report ↗</button></div></section></div>}
  </section>;
}
