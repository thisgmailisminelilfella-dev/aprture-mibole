import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { hashPin } from '../lib/pin.mjs';

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
