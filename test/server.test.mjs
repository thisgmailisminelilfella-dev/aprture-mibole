import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { hashPin } from '../lib/pin.mjs';
import { createBookKnowledge } from '../lib/book-knowledge.mjs';

test('PIN authentication, same-origin writes and durable pause', async t=>{
 const data=await mkdtemp(join(tmpdir(),'aperture-test-')); const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 let child; const origin=`http://127.0.0.1:${port}`;
 const start=()=>new Promise((resolve,reject)=>{child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),APERTURE_PIN:'123456',APERTURE_DATA_DIR:data},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',d=>err+=d);child.on('exit',code=>reject(new Error(`Exited ${code}: ${err}`)));child.stdout.on('data',d=>{if(d.toString().includes('LAN accessible'))resolve();});});
 const stop=()=>new Promise(resolve=>{child.once('exit',resolve);child.kill();});
 t.after(async()=>{if(child&&!child.killed)await stop();await rm(data,{recursive:true,force:true});});
 await start();
 let r=await fetch(`${origin}/api/state?market=indian`); assert.equal(r.status,401);
 r=await fetch(`${origin}/api/unlock`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({pin:'000000'})});assert.equal(r.status,401);
 r=await fetch(`${origin}/api/unlock`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({pin:'123456'})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];
 // Key management requires a session, host PIN and secure transport; never return the secret.
 const secret='sk-or-v1-0123456789abcdef';
 r=await fetch(`${origin}/api/keys`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({pin:'123456',key:secret})});assert.equal(r.status,401);
 r=await fetch(`${origin}/api/keys`,{method:'POST',headers:{cookie,host:`example.com:${port}`,origin:`http://example.com:${port}`,'content-type':'application/json'},body:JSON.stringify({pin:'123456',key:secret})});assert.equal(r.status,403);
 r=await fetch(`${origin}/api/keys`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({pin:'999999',key:secret})});assert.equal(r.status,401);
 r=await fetch(`${origin}/api/keys`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({pin:'123456',key:secret})});assert.equal(r.status,201);const created=await r.json();assert.equal(JSON.stringify(created).includes(secret),false);const keyId=created.keys[0].id;
 r=await fetch(`${origin}/api/keys`,{headers:{cookie}});const listed=await r.json();assert.equal(listed.canManage,true);assert.equal(listed.keys.length,1);assert.equal(JSON.stringify(listed).includes(secret),false);
 r=await fetch(`${origin}/api/keys/remove`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({pin:'123456',id:keyId})});assert.equal(r.status,200);assert.equal((await r.json()).keys.length,0);
 const googleKey='AIza'+'a'.repeat(35);
 r=await fetch(`${origin}/api/keys`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({pin:'123456',provider:'google',key:googleKey})});assert.equal(r.status,400);assert.match((await r.json()).error,/billing is disabled/);
 r=await fetch(`${origin}/api/keys`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({pin:'123456',provider:'google',key:googleKey,freeTierConfirmed:true})});assert.equal(r.status,201);const googleResult=await r.json();assert.equal(googleResult.keys[0].provider,'Google AI Studio');assert.equal(JSON.stringify(googleResult).includes(googleKey),false);
 r=await fetch(`${origin}/api/keys/remove`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({pin:'123456',id:googleResult.keys[0].id})});assert.equal(r.status,200);

 // A session is not sufficient: live activation re-verifies the original PIN and always fails closed.
 r=await fetch(`${origin}/api/live/activate`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"market":"indian","pin":"123456"}'});assert.equal(r.status,401);
 r=await fetch(`${origin}/api/live/activate`,{method:'POST',headers:{cookie,origin:'http://evil.test','content-type':'application/json'},body:'{"market":"indian","pin":"123456"}'});assert.equal(r.status,403);
 r=await fetch(`${origin}/api/live/activate`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"market":"invalid","pin":"123456"}'});assert.equal(r.status,400);
 r=await fetch(`${origin}/api/live/activate`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"market":"indian","pin":"999999"}'});assert.equal(r.status,401);
 for(const market of ['indian','foreign','crypto']) {
  r=await fetch(`${origin}/api/live/activate`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({market,pin:'123456'})});assert.equal(r.status,503);
  r=await fetch(`${origin}/api/state?market=${market}`,{headers:{cookie}});assert.equal((await r.json()).mode,'paper');
 }
 r=await fetch(`${origin}/api/pause`,{method:'POST',headers:{cookie,origin:'http://evil.test','content-type':'application/json'},body:'{"paused":true}'});assert.equal(r.status,403);
 r=await fetch(`${origin}/api/pause`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"paused":true}'});assert.equal(r.status,200);
 r=await fetch(`${origin}/api/run`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"market":"indian"}'});assert.equal(r.status,409);
 // Failed live PIN attempts share the unlock rate limit.
 for(let i=0;i<5;i++) {r=await fetch(`${origin}/api/live/activate`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"market":"indian","pin":"999999"}'});assert.equal(r.status,401);}
 r=await fetch(`${origin}/api/live/activate`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"market":"indian","pin":"123456"}'});assert.equal(r.status,429);
 await stop();await start();
 r=await fetch(`${origin}/api/unlock`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"pin":"123456"}'});const cookie2=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(`${origin}/api/state?market=indian`,{headers:{cookie:cookie2}});assert.equal((await r.json()).paused,true);
 // Changing the host PIN invalidates sessions already issued under the old hash.
 const db=new DatabaseSync(join(data,'aperture.sqlite'));const next=hashPin('654321');db.exec('BEGIN');db.prepare("UPDATE settings SET value=? WHERE key='pin_salt'").run(next.salt);db.prepare("UPDATE settings SET value=? WHERE key='pin_hash'").run(next.hash);db.exec('COMMIT');db.close();
 r=await fetch(`${origin}/api/state?market=indian`,{headers:{cookie:cookie2}});assert.equal(r.status,401);
 r=await fetch(`${origin}/api/unlock`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"pin":"123456"}'});assert.equal(r.status,401);
 r=await fetch(`${origin}/api/unlock`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"pin":"654321"}'});assert.equal(r.status,200);

});

test('pause cancels an in-flight market data request',async t=>{
 const data=await mkdtemp(join(tmpdir(),'aperture-cancel-'));const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const origin=`http://127.0.0.1:${port}`;const child=spawn(process.execPath,['--import','./test/fixtures/abort-feed.mjs','server.js'],{env:{...process.env,PORT:String(port),APERTURE_PIN:'123456',APERTURE_DATA_DIR:data},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await rm(data,{recursive:true,force:true});});
 let log='';const waitFor=needle=>new Promise((resolve,reject)=>{if(log.includes(needle))return resolve();const timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${needle}`)),5000);const onData=chunk=>{log+=chunk.toString();if(log.includes(needle)){clearTimeout(timer);child.stdout.off('data',onData);resolve();}};child.stdout.on('data',onData);});
 await waitFor('LAN accessible');let r=await fetch(`${origin}/api/unlock`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"pin":"123456"}'});const cookie=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(`${origin}/api/run`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"market":"indian","target":"INFY"}'});assert.equal(r.status,202);
 const aborted=waitFor('TEST_FEED_ABORTED');r=await fetch(`${origin}/api/pause`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"paused":true}'});assert.equal(r.status,200);await aborted;
 r=await fetch(`${origin}/api/state?market=indian`,{headers:{cookie}});const state=await r.json();assert.equal(state.paused,true);assert.equal(state.running,false);assert.deepEqual(state.signals,[]);
});

test('paper APIs isolate Indian simulated fills and Alpaca paper positions',async t=>{
 const data=await mkdtemp(join(tmpdir(),'aperture-paper-api-'));const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const db=new DatabaseSync(join(data,'aperture.sqlite'));createBookKnowledge(db).addMany([{title:'Test source',author:'Tester',locator:'Chapter 2',market:'indian',strategy:'20 / 50 day trend',note:'A user-authored test note.'}]);db.close();
 const origin=`http://127.0.0.1:${port}`;const child=spawn(process.execPath,['--import','./test/fixtures/paper-feeds.mjs','server.js'],{env:{...process.env,PORT:String(port),APERTURE_PIN:'123456',APERTURE_DATA_DIR:data,ALPACA_PAPER_KEY_ID:'PK_TEST',ALPACA_PAPER_SECRET_KEY:'TEST_SECRET'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await rm(data,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timeout')),5000);child.stdout.on('data',d=>{if(d.toString().includes('LAN accessible')){clearTimeout(timer);resolve();}});});
 const post=async(path,payload,cookie)=>fetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(payload)});
 let r=await post('/api/unlock',{pin:'123456'});const cookie=r.headers.get('set-cookie').split(';')[0];
 r=await post('/api/paper/open',{market:'indian',symbol:'INFY.NS',qty:1},null);assert.equal(r.status,401);
 r=await post('/api/run',{market:'indian',target:'INFY'},cookie);assert.equal(r.status,202);
 r=await fetch(`${origin}/api/state?market=indian`,{headers:{cookie}});let state=await r.json();assert.equal(state.signals[0].rawClose,159);assert.equal(state.signals[0].bookNotes[0].title,'Test source');assert.equal(state.signals[0].bookNotes[0].note,'A user-authored test note.');
 r=await post('/api/paper/open',{market:'indian',symbol:'INFY.NS',qty:2,price:0.01,expectedClose:0.01,expectedDataTime:state.signals[0].dataTime},cookie);assert.equal(r.status,409);
 r=await post('/api/paper/open',{market:'indian',symbol:'INFY.NS',qty:2,price:0.01,expectedClose:159,expectedDataTime:state.signals[0].dataTime},cookie);assert.equal(r.status,201);
 r=await fetch(`${origin}/api/paper/positions?market=indian`,{headers:{cookie}});let positions=(await r.json()).positions;assert.equal(positions.length,1);assert.equal(positions[0].entry,159);
 r=await post('/api/paper/open',{market:'indian',symbol:'INFY.NS',qty:1,expectedClose:159,expectedDataTime:state.signals[0].dataTime},cookie);assert.equal(r.status,400);
 r=await post('/api/pause',{paused:true},cookie);assert.equal(r.status,200);r=await post('/api/paper/open',{market:'indian',symbol:'INFY.NS',qty:1},cookie);assert.equal(r.status,409);
 r=await post('/api/paper/close',{market:'indian',id:positions[0].id},cookie);assert.equal(r.status,200);
 r=await fetch(`${origin}/api/state?market=indian`,{headers:{cookie}});state=await r.json();assert.equal(state.learning[0].trades,1);assert.equal(state.learning[0].expectancy,null);
 r=await fetch(`${origin}/api/paper/positions?market=foreign`,{headers:{cookie}});positions=(await r.json()).positions;assert.equal(positions[0].symbol,'AAPL');assert.equal(JSON.stringify(positions).includes('TEST_SECRET'),false);
});
