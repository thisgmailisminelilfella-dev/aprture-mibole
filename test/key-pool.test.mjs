import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,unlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createKeyPool,FREE_MODEL} from '../lib/key-pool.mjs';

test('key pool encrypts at rest, rotates on failures and uses only a free model',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-pool-'));const db=new DatabaseSync(join(dir,'test.sqlite'));t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const keys=['sk-or-v1-aaaaaaaaaa','sk-or-v1-bbbbbbbbbb','sk-or-v1-cccccccccc'];let clock=100000;const calls=[];
 const fetcher=async (url,opts)=>{calls.push({url,opts});const index=calls.length;return new Response(index===3?JSON.stringify({choices:[{message:{content:'Indicators show a trend.'}}]}):'{}',{status:index===1?401:index===2?429:200,headers:{'Content-Type':'application/json','Retry-After':'120'}});};
 const pool=await createKeyPool(db,dir,{fetcher,now:()=>clock});for(const key of keys)pool.add(key);
 assert.throws(()=>pool.add(keys[0]),/already/); assert.throws(()=>pool.add('invalid'),/valid/);
 assert.equal((await stat(join(dir,'keypool.master'))).mode&0o777,0o600);
 const rows=db.prepare('SELECT * FROM key_pool').all();for(const [i,row] of rows.entries())assert.equal(Buffer.from(row.encrypted).includes(keys[i]),false);
 assert.equal(JSON.stringify(pool.list()).includes('sk-or'),false);
 const summary=await pool.synthesize([{symbol:'ABC',direction:'LONG',conviction:3,quant:'example'}]);assert.equal(summary,'Indicators show a trend.');
 assert.deepEqual(pool.list().map(k=>k.status),['invalid','cooldown','ready']);
 assert.equal(pool.list()[1].retryAt,clock+120000);assert.equal(calls.length,3);
 for(const call of calls){assert.equal(call.url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(JSON.parse(call.opts.body).model,FREE_MODEL);assert.match(FREE_MODEL,/:free$/);assert.equal(call.opts.body.includes('sk-or-'),false);}
 clock+=120001;assert.equal(pool.list()[1].status,'untested');
 assert.equal(pool.remove(rows[0].id),true);await unlink(join(dir,'keypool.master'));await assert.rejects(createKeyPool(db,dir),/master key is missing/);
});

test('pool gracefully falls back with no working keys',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-empty-'));const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});const pool=await createKeyPool(db,dir,{fetcher:async()=>{throw Error('offline');}});assert.equal(await pool.synthesize([]),null);pool.add('sk-or-v1-aaaaaaaaaa');assert.equal(await pool.synthesize([]),null);assert.equal(pool.list()[0].status,'cooldown');
});
