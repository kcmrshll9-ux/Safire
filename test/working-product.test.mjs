import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNoteMutator } from '../lib/note-mutations.mjs';
import { noteRevision } from '../lib/note-revision.mjs';
import { createDraftStore } from '../lib/draft-store.mjs';
import { createVaultCatalog } from '../lib/vault-catalog.mjs';
import { rewriteWikiReferences, resolveWikiPath } from '../lib/wiki-links.mjs';
import { planLinkedRename } from '../lib/rename-plan.mjs';

const cleanup = new Map();
async function vault(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'safire-product-test-'));
  t.after(async()=>{ await cleanup.get(root)?.(); cleanup.delete(root); await fs.rm(root,{recursive:true,force:true}); });
  return root;
}

test('only one writer can replace the same revision, even across mutator instances',async t=>{
  const root=await vault(t);const file=path.join(root,'Note.md');await fs.writeFile(file,'Original');
  const a=createNoteMutator({vaultDir:root}),b=createNoteMutator({vaultDir:root});
  const results=await Promise.allSettled([a.replace(file,'Alice',{expectedRevision:noteRevision('Original')}),b.replace(file,'Bob',{expectedRevision:noteRevision('Original')})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'NOTE_CONFLICT');
  assert.ok(['Alice','Bob'].includes(await fs.readFile(file,'utf8')));
});

test('drafts survive a new store and stale save cleanup cannot erase newer content',async t=>{
  const root=await vault(t);let drafts=await createDraftStore(root);
  await drafts.put('Project/Note.md',{content:'Unfinished thought',baseRevision:noteRevision('Original')});
  drafts=await createDraftStore(root);
  assert.equal((await drafts.get('Project/Note.md')).content,'Unfinished thought');
  await drafts.put('Project/Note.md',{content:'More writing',baseRevision:noteRevision('Original')});
  await drafts.clear('Project/Note.md',noteRevision('Unfinished thought'));
  assert.equal((await drafts.get('Project/Note.md')).content,'More writing');
  assert.equal((await drafts.list()).drafts.length,1);
  await drafts.clear('Project/Note.md',noteRevision('More writing'));
  assert.deepEqual((await drafts.list()).drafts,[]);
  assert.equal(await drafts.get('Project/Note.md'),null);
});

test('catalog searches beyond 1000 notes, pages without duplicates, updates and removes external edits',async t=>{
  const root=await vault(t);
  for(let i=0;i<1025;i++) await fs.writeFile(path.join(root,`${String(i).padStart(4,'0')}.md`),`# Note ${i}\n${i===1024?'needle-at-the-end':'Example text'}`);
  const catalog=await createVaultCatalog(root);cleanup.set(root,()=>catalog.close());
  assert.equal((await catalog.page({query:'needle-at-the-end'})).notes[0].path,'1024.md');
  let offset=0;const seen=[];
  while(offset!==null){const page=await catalog.page({offset,limit:200});seen.push(...page.notes.map(n=>n.path));offset=page.nextOffset;}
  assert.equal(seen.length,1025);assert.equal(new Set(seen).size,1025);
  await fs.writeFile(path.join(root,'1024.md'),'Externally updated');await catalog.refresh(true);
  assert.equal((await catalog.page({query:'needle-at-the-end'})).total,0);
  assert.equal((await catalog.page({query:'Externally updated'})).total,1);
  await fs.unlink(path.join(root,'1024.md'));await catalog.refresh(true);
  assert.equal((await catalog.page()).total,1024);
});

test('catalog excludes private evidence and fenced code while retaining public evidence',async t=>{
  const root=await vault(t);
  await fs.writeFile(path.join(root,'Evidence.md'),'# Evidence\n\n```safire-evidence\nid: "sample"\nclaim: "Public claim"\nsource_type: "url"\nsource: "https://example.com"\nstatus: "verified"\nprivate_notes: "private-canary"\n```\n\n```js\ncode-canary\n```');
  const catalog=await createVaultCatalog(root);cleanup.set(root,()=>catalog.close());
  assert.equal((await catalog.page({query:'private-canary'})).total,0);
  assert.equal((await catalog.page({query:'code-canary'})).total,0);
  const result=await catalog.page({query:'status:verified',evidenceOnly:true});
  assert.equal(result.total,1);
  assert.equal(JSON.stringify(result).includes('private-canary'),false);
  assert.equal(result.notes[0].evidence[0].source,'https://example.com');
});

test('moving a note preserves its outgoing relative links and escaped examples',()=>{
  const paths=['One/Topic.md','One/Related.md','Two/Related.md'];
  const input='[[Related#Part|Related work]] and [[#Self]]\n\\[[Topic]]';
  const result=rewriteWikiReferences(input,'One/Topic.md','One/Topic.md','Two/Moved.md',paths);
  assert.equal(result.content,'[[/One/Related#Part|Related work]] and [[/Two/Moved#Self]]\n\\[[Topic]]');
  assert.equal(resolveWikiPath('Index.md','TOPIC',['Topic.md','topic.md']),null);
  assert.equal(resolveWikiPath('Index.md','/Missing/Topic',['One/Topic.md']),null);
});

test('a damaged disk catalog falls back to a complete session index',async t=>{
  const root=await vault(t);
  await fs.mkdir(path.join(root,'.safire','catalog'),{recursive:true});
  await fs.writeFile(path.join(root,'.safire','catalog','notes-v1.sqlite'),'This is not a SQLite database');
  await fs.writeFile(path.join(root,'Safe.md'),'# Intact notes');
  const catalog=await createVaultCatalog(root);cleanup.set(root,()=>catalog.close());
  const result=await catalog.page({query:'Intact'});
  assert.equal(result.total,1);assert.equal(result.complete,true);assert.match(result.reason,/rebuilt in memory/);
});

test('combined evidence filters describe the same receipt and dates expire at query time',async t=>{
  const root=await vault(t);
  const receipt=(id,status,source,freshness)=>'```safire-evidence\nid: "'+id+'"\nclaim: "Test"\nstatus: "'+status+'"\nsource_type: "'+source+'"\nfreshness: "'+freshness+'"\n```';
  await fs.writeFile(path.join(root,'Mixed.md'),receipt('a','verified','manual_observation','2000-01-01')+'\n\n'+receipt('b','conflicting','url','2099-01-01'));
  const catalog=await createVaultCatalog(root);cleanup.set(root,()=>catalog.close());
  assert.equal((await catalog.page({query:'status:verified source:url'})).total,0);
  assert.equal((await catalog.page({query:'status:verified expired:true'})).total,1);
  assert.equal((await catalog.page({query:'status:conflicting expired:false'})).total,1);
  assert.equal((await catalog.page({query:'status:verified expired:false'})).total,0);
});

test('rename preserves aliases and anchors, excludes code, and resolves project names',()=>{
  const paths=['One/Topic.md','Two/Topic.md','One/Index.md'];
  assert.equal(resolveWikiPath('Two/Index.md','Topic',paths),'Two/Topic.md');
  const input='[[Topic#Details|Read more]]\n`[[Topic]]`\n```md\n[[Topic]]\n```\n[[/Two/Topic]]';
  const rewritten=rewriteWikiReferences(input,'One/Index.md','One/Topic.md','One/Renamed.md',paths);
  assert.equal(rewritten.count,1);
  assert.equal(rewritten.content,'[[/One/Renamed#Details|Read more]]\n`[[Topic]]`\n```md\n[[Topic]]\n```\n[[/Two/Topic]]');
});

test('linked rename backs up all originals and rejects a stale plan before mutation',async t=>{
  const root=await vault(t);await fs.writeFile(path.join(root,'Alpha.md'),'# Alpha');await fs.writeFile(path.join(root,'Beta.md'),'See [[Alpha|the original]]');
  const catalog=await createVaultCatalog(root);cleanup.set(root,()=>catalog.close());const mutator=createNoteMutator({vaultDir:root});
  let plan=await planLinkedRename(root,'Alpha.md','Renamed.md',catalog);
  await fs.writeFile(path.join(root,'Beta.md'),'Changed [[Alpha]]');
  await assert.rejects(mutator.renameWithLinks(path.join(root,'Alpha.md'),path.join(root,'Renamed.md'),plan.rewrites),{code:'NOTE_CONFLICT'});
  assert.equal(await fs.readFile(path.join(root,'Alpha.md'),'utf8'),'# Alpha');
  await assert.rejects(fs.stat(path.join(root,'Renamed.md')),{code:'ENOENT'});
  plan=await planLinkedRename(root,'Alpha.md','Renamed.md',catalog);
  const result=await mutator.renameWithLinks(path.join(root,'Alpha.md'),path.join(root,'Renamed.md'),plan.rewrites);
  assert.equal(result.updatedLinks,1);assert.equal(result.backups.length,2);
  assert.equal(await fs.readFile(path.join(root,'Beta.md'),'utf8'),'Changed [[/Renamed]]');
  assert.equal(await fs.readFile(path.join(root,'Renamed.md'),'utf8'),'# Alpha');
  await assert.rejects(fs.stat(path.join(root,'Alpha.md')),{code:'ENOENT'});
});

test('rename rollback preserves an independently edited destination',async t=>{
  const root=await vault(t);const source=path.join(root,'Source.md');const destination=path.join(root,'Moved.md');
  await fs.writeFile(source,'Original');
  let interfered=false;
  const fsApi={...fs,async lstat(file,options){
    if(file===source&&!interfered&&(await fs.stat(destination).catch(()=>null))){
      interfered=true;await fs.writeFile(destination,'Independent destination edit');
    }
    return fs.lstat(file,options);
  }};
  const mutator=createNoteMutator({vaultDir:root,fsApi});
  await assert.rejects(mutator.renameWithLinks(source,destination,[{path:'Source.md',content:'Original',revision:noteRevision('Original'),count:0}]));
  assert.equal(await fs.readFile(source,'utf8'),'Original');
  assert.equal(await fs.readFile(destination,'utf8'),'Independent destination edit');
});
