import React from 'react';
import { useDialogAccessibility } from './useDialogAccessibility';

export function RecoveryPanel({ close, open }: { close:()=>void; open:(path:string)=>void }) {
  const panelRef = useDialogAccessibility(true, close);
  const [drafts,setDrafts]=React.useState<{path:string;updatedAt:number}[]>([]);
  const [error,setError]=React.useState('');
  const [loading,setLoading]=React.useState(true);
  React.useEffect(()=> {fetch('/api/drafts').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(data=>{setDrafts(data.drafts);if(!data.complete)setError('Some drafts could not be read. They remain in the vault recovery folder.');}).catch(()=>setError('Could not load recovery drafts.')).finally(()=>setLoading(false));},[]);
  const recover=async(notePath:string)=>{
    try {
      const response=await fetch(`/api/draft?path=${encodeURIComponent(notePath)}`);
      if(!response.ok)throw new Error('Could not read that draft');
      const {draft}=await response.json();
      if(!draft)throw new Error('This draft has already been saved');
      const destination=`Recovered/${notePath.split('/').pop()?.replace(/\.md$/i,'')} ${new Date().toISOString().replace(/[:.]/g,'-')}.md`;
      const saved=await fetch('/api/note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:destination,content:draft.content})});
      if(!saved.ok)throw new Error('Could not create a recovered copy');
      close();open((await saved.json()).path);
    } catch(reason){setError(reason instanceof Error?reason.message:'Recovery failed');}
  };
  return <div className="modal-backdrop"><section ref={panelRef} className="panel-modal recovery-panel" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><div className="panel-head"><div><span className="eyebrow">NOTHING GOOD GETS LEFT BEHIND</span><h2 id="recovery-title">Your draft recovery.</h2><p>Local checkpoints survive closing tabs and restarting Safire.</p></div><button aria-label="Close draft recovery" onClick={close}>×</button></div>{error&&<p role="alert">{error}</p>}{loading?<p>Finding your drafts…</p>:drafts.length?<div className="recovery-list">{drafts.map(draft=><article key={draft.path}><div><strong>{draft.path}</strong><small>{new Date(draft.updatedAt).toLocaleString()}</small></div><button onClick={()=>{close();open(draft.path);}}>Continue editing</button><button onClick={()=>void recover(draft.path)}>Recover as a copy</button></article>)}</div>:<div className="research-empty"><h3>All caught up.</h3><p>Your saved notes are in the vault. Unsaved checkpoints will appear here when you need them.</p></div>}</section></div>;
}
