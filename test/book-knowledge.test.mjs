import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createBookKnowledge} from '../lib/book-knowledge.mjs';

const note={title:'Test source',author:'Test author',locator:'Chapter 2',market:'indian',strategy:'20 / 50 day trend',note:'A test note written by the user.'};
test('book notes persist, match only the requested market and strategy, and can be removed',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'notes-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'notes.sqlite');let db=new DatabaseSync(path), k=createBookKnowledge(db);
 assert.equal(k.addMany([note,{...note,title:'All markets',market:'all'}]),2);assert.equal(k.forSignal('indian','20 / 50 day trend').length,2);assert.equal(k.forSignal('foreign','20 / 50 day trend').length,1);assert.equal(k.forSignal('indian','unrelated').length,0);
 assert.throws(()=>k.addMany([note,{...note,locator:''}]));assert.equal(k.list().length,2);db.close();
 db=new DatabaseSync(path);k=createBookKnowledge(db);assert.equal(k.forSignal('indian','20 / 50 day trend')[0].locator,'Chapter 2');const id=k.list()[0].id;assert.equal(k.remove(id),true);assert.equal(k.remove(id),false);db.close();
});
test('host import command uses the local data directory',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'notes-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'notes.json');await writeFile(file,JSON.stringify([note]));
 const run=(...args)=>spawnSync(process.execPath,['tools/book-notes.mjs',...args],{env:{...process.env,APERTURE_DATA_DIR:dir},encoding:'utf8'});
 const imported=run('import',file);assert.equal(imported.status,0,imported.stderr);const result=run('list');assert.equal(result.status,0,result.stderr);const rows=JSON.parse(result.stdout);assert.equal(rows.length,1);assert.equal(rows[0].title,note.title);assert.equal(run('remove',rows[0].id).status,0);assert.deepEqual(JSON.parse(run('list').stdout),[]);
});
