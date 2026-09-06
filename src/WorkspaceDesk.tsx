import React from 'react';
import type { LibraryNote } from './libraryModel';

export function WorkspaceDesk({ notes, create, capture, research, open, recover }: {
  notes: LibraryNote[]; create: () => void; capture: () => void; research: () => void; open: (path: string) => void; recover: () => void;
}) {
  const recent = [...notes].sort((a,b)=>b.mtime-a.mtime).slice(0,3);
  return <section className="workspace-desk" aria-label="Your workspace">
    <div className="desk-intro"><span className="eyebrow">YOUR SPACE TO THINK</span><h1>Good ideas deserve<br/><em>a place to grow.</em></h1><p>Collect what matters. Connect the dots. Make something of it.</p>
      <div className="desk-actions"><button className="primary-action" onClick={create}>＋ Start a note</button><button onClick={capture}>Quick capture <kbd>＋</kbd></button></div>
      <div className="local-pill"><span/> Yours, on your device <span className="pill-divider">/</span> {notes.length.toLocaleString()} notes</div>
    </div>
    <div className="desk-resume"><div className="section-label"><span>PICK UP WHERE YOU LEFT OFF</span><button onClick={recover}>Draft recovery ↗</button></div>
      {recent.length ? recent.map((note,index)=><button className="resume-note" key={note.path} onClick={()=>open(note.path)}><span className="resume-number">0{index+1}</span><span><strong>{note.title}</strong><small>{note.folder || 'Personal notes'} · {new Date(note.mtime).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</small></span><span className="resume-arrow">↗</span></button>) : <p className="desk-empty">A fresh page is a fine place to start.</p>}
      <button className="research-invitation" onClick={research}><span className="research-symbol">✳</span><span><strong>From sources to a clear point of view</strong><small>Open your research desk</small></span><span>↗</span></button>
    </div>
  </section>;
}
