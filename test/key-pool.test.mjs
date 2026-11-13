import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createKeyPool,selectGoogleModels,selectOpenRouterModels} from '../lib/key-pool.mjs';

const googleKey='AIza'+'a'.repeat(35), orKeys=['sk-or-v1-aaaaaaaaaa','sk-or-v1-bbbbbbbbbb','sk-or-v1-cccccccccc'];
const model=(id,pricing={prompt:'0',completion:'0'})=>({id,pricing,context_length:8192,architecture:{input_modalities:['text'],output_modalities:['text']}});
const orModels=[model('vendor/second:free'),model('vendor/first-instruct:free'),model('vendor/paid'),model('vendor/notfree:free',{prompt:'1',completion:'0'}),model('vendor/charge:free',{prompt:'0',completion:'0',request:'1'})];
const signals=[{symbol:'ABC',direction:'LONG',conviction:3,quant:'example'}];
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});

test('model selection rejects paid or unsupported models and intersects Google allowlist',()=>{
 assert.deepEqual(selectOpenRouterModels(orModels),['vendor/first-instruct:free','vendor/second:free']);
 assert.deepEqual(selectOpenRouterModels([model('vendor/a:free',{prompt:'',completion:'0'}),model('vendor/b:free',{prompt:'0',completion:'0',request:'0.01'}),{...model('vendor/c:free'),architecture:{input_modalities:['image'],output_modalities:['image']}}]),[]);
 assert.deepEqual(selectGoogleModels([{name:'models/gemini-4-argon',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']}]),['gemini-3.8-flash','gemini-3.5-flash-lite']);
});

test('pool encrypts keys, rotates on failures and discovers only free OpenRouter models',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-pool-'));const db=new DatabaseSync(join(dir,'test.sqlite'));t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 let clock=100000;const calls=[];let completions=0;
 const fetcher=async (url,opts)=>{calls.push({url,opts});if(url.endsWith('/models'))return json({data:orModels});completions++;return completions===1?json({},401):completions<=3?json({},429,{'Retry-After':'120'}):json({choices:[{message:{content:'Indicators show a trend.'}}]});};
 const pool=await createKeyPool(db,dir,{fetcher,now:()=>clock});for(const key of orKeys)pool.add(key);
 assert.throws(()=>pool.add(orKeys[0]),/already/);assert.throws(()=>pool.add('invalid'),/valid/);
 assert.equal((await stat(join(dir,'keypool.master'))).mode&0o777,0o600);
 const rows=db.prepare('SELECT * FROM key_pool').all();for(const [i,row] of rows.entries())assert.equal(Buffer.from(row.encrypted).includes(orKeys[i]),false);
 assert.equal(JSON.stringify(pool.list()).includes('sk-or'),false);
 assert.equal(await pool.synthesize(signals),'Indicators show a trend.');
 assert.deepEqual(pool.list().map(k=>k.status),['invalid','cooldown','ready']);assert.equal(pool.list()[1].retryAt,clock+120000);
 const posts=calls.filter(call=>call.opts.method==='POST');assert.equal(posts.length,4);
 for(const call of posts){assert.equal(call.url,'https://openrouter.ai/api/v1/chat/completions');assert.match(JSON.parse(call.opts.body).model,/:free$/);assert.ok(['vendor/first-instruct:free','vendor/second:free'].includes(JSON.parse(call.opts.body).model));assert.equal(call.opts.body.includes('sk-or-'),false);}
 assert.equal(calls.filter(call=>call.url.endsWith('/models')).length,1);
 clock+=120001;assert.equal(pool.list()[1].status,'untested');assert.equal(pool.remove(rows[0].id),true);
 await unlink(join(dir,'keypool.master'));await assert.rejects(createKeyPool(db,dir),/master key is missing/);
});

test('Google requires explicit free-project confirmation and chooses available allowed models',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-google-'));const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});const calls=[];
 const fetcher=async(url,opts)=>{calls.push({url,opts});if(url.includes('/models?'))return json({models:[{name:'models/gemini-4-argon',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']}]});if(url.includes('gemini-3.8-flash'))return json({},429);return json({candidates:[{content:{parts:[{thought:true,text:'private thinking'},{text:'Google summary.'}]}}]});};
 const pool=await createKeyPool(db,dir,{fetcher});assert.throws(()=>pool.add(googleKey,'google'),/billing is disabled/);assert.throws(()=>pool.add(googleKey,'google','true'),/billing is disabled/);pool.add(googleKey,'google',true);
 assert.equal(pool.list()[0].provider,'Google AI Studio');assert.equal(JSON.stringify(pool.list()).includes(googleKey),false);
 assert.equal(await pool.synthesize(signals),'Google summary.');assert.equal(pool.list()[0].status,'ready');assert.equal(calls.length,3);
 for(const call of calls){assert.equal(call.opts.headers['x-goog-api-key'],googleKey);assert.equal(call.url.includes(googleKey),false);assert.equal((call.opts.body||'').includes(googleKey),false);assert.equal(call.url.includes('gemini-4-argon'),false);}
});

test('migrates existing OpenRouter keys and gracefully falls back without free models',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-migrate-'));const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const fetcher=async()=>json({data:[model('vendor/paid'),model('vendor/also-paid:free',{prompt:'0.1',completion:'0'})]});
 let pool=await createKeyPool(db,dir,{fetcher});pool.add(orKeys[0]);db.exec('ALTER TABLE key_pool DROP COLUMN google_confirmed; ALTER TABLE key_pool DROP COLUMN provider');
 pool=await createKeyPool(db,dir,{fetcher});assert.equal(pool.list()[0].provider,'OpenRouter');assert.equal(await pool.synthesize(signals),null);assert.equal(pool.list()[0].status,'cooldown');
});

test('can fail over from unavailable OpenRouter models to Google',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-failover-'));const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const fetcher=async(url)=>url.startsWith('https://openrouter.ai')?json({data:[]}):url.includes('/models?')?json({models:[{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']}]}):json({candidates:[{content:{parts:[{text:'Fallback summary'}]}}]});
 const pool=await createKeyPool(db,dir,{fetcher});pool.add(orKeys[0]);pool.add(googleKey,'google',true);assert.equal(await pool.synthesize(signals),'Fallback summary');assert.deepEqual(pool.list().map(k=>k.status),['cooldown','ready']);
});

test('an aborted scan stops in-flight provider work without trying another key',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-abort-'));const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 let started;const waiting=new Promise(resolve=>{started=resolve;});let posts=0;
 const fetcher=async(url,opts)=>{if(url.endsWith('/models'))return json({data:[model('vendor/a-instruct:free')]});posts++;started();return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};
 const pool=await createKeyPool(db,dir,{fetcher});pool.add(orKeys[0]);pool.add(orKeys[1]);const controller=new AbortController();const task=pool.synthesize(signals,{signal:controller.signal});await waiting;controller.abort();assert.equal(await task,null);assert.equal(posts,1);assert.deepEqual(pool.list().map(k=>k.status),['untested','untested']);
});

test('removing a key during model discovery prevents a subsequent generation request',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-removal-'));const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});let pool,id,posts=0;
 const fetcher=async(url)=>{if(url.endsWith('/models')){pool.remove(id);return json({data:[model('vendor/a-instruct:free')]});}posts++;return json({});};
 pool=await createKeyPool(db,dir,{fetcher});id=pool.add(orKeys[0]);assert.equal(await pool.synthesize(signals),null);assert.equal(posts,0);assert.deepEqual(pool.list(),[]);
});

test('an encrypted legacy OpenRouter key still works after migration',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aperture-legacy-'));const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});let seenAuth='';
 const fetcher=async(url,opts)=>{if(url.endsWith('/models'))return json({data:[model('vendor/a-instruct:free')]});seenAuth=opts.headers.Authorization;return json({choices:[{message:{content:'Migrated key works.'}}]});};
 let pool=await createKeyPool(db,dir,{fetcher});pool.add(orKeys[0]);db.exec('ALTER TABLE key_pool DROP COLUMN google_confirmed; ALTER TABLE key_pool DROP COLUMN provider');pool=await createKeyPool(db,dir,{fetcher});assert.equal(await pool.synthesize(signals),'Migrated key works.');assert.equal(seenAuth,`Bearer ${orKeys[0]}`);
});
