import { randomBytes, createCipheriv, createDecipheriv, createHmac, randomUUID } from 'node:crypto';
import { open, readFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';

// The model is deliberately fixed to a free OpenRouter variant; callers cannot select paid models.
export const FREE_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
export async function createKeyPool(db, dataDir, {fetcher=fetch, now=()=>Date.now()}={}) {
 const path=join(dataDir,'keypool.master');
 // A missing master key must never silently make existing encrypted credentials unreadable.
 try { await access(path); } catch(e) {
  if(e.code!=='ENOENT') throw e;
  const hasTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='key_pool'").get();
  if(hasTable && db.prepare('SELECT 1 FROM key_pool LIMIT 1').get()) throw new Error('Key pool master key is missing. Restore it from backup before starting.');
 }
 try { const file=await open(path,'wx',0o600); try {await file.writeFile(randomBytes(32));} finally {await file.close();} } catch(e) {if(e.code!=='EEXIST') throw e;}
 await chmod(path,0o600);
 const master=await readFile(path); if(master.length!==32) throw new Error('Invalid key pool master key');
 db.exec(`CREATE TABLE IF NOT EXISTS key_pool (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, encrypted BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, status TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0)`);
 function seal(secret) {const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',master,iv);const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return {iv,encrypted,tag:cipher.getAuthTag()};}
 function unseal(row) {const cipher=createDecipheriv('aes-256-gcm',master,row.iv);cipher.setAuthTag(row.tag);return Buffer.concat([cipher.update(row.encrypted),cipher.final()]).toString('utf8');}
 function list() {return db.prepare('SELECT id,status,retry_at,last_used FROM key_pool ORDER BY rowid').all().map(row=>({id:row.id,provider:'OpenRouter', status:row.status==='cooldown'&&row.retry_at<=now()?'untested':row.status,retryAt:row.retry_at||null,lastUsed:row.last_used||null}));}
 function add(secret) {
  if(typeof secret!=='string'||secret.length<10||secret.length>512||!/^sk-or-v1-[a-zA-Z0-9_-]+$/.test(secret)) throw new Error('Enter a valid OpenRouter API key.');
  if(list().length>=20) throw new Error('The pool is limited to 20 keys.');
  const fingerprint=createHmac('sha256',master).update(secret).digest('hex');
  if(db.prepare('SELECT id FROM key_pool WHERE fingerprint=?').get(fingerprint)) throw new Error('This key is already in the pool.');
  const {iv,encrypted,tag}=seal(secret);const id=randomUUID();
  db.prepare('INSERT INTO key_pool (id,fingerprint,encrypted,iv,tag,status) VALUES (?,?,?,?,?,?)').run(id,fingerprint,encrypted,iv,tag,'untested');
  return id;
 }
 function remove(id) {return db.prepare('DELETE FROM key_pool WHERE id=?').run(id).changes>0;}
 function mark(id,status,retryAt=0) {db.prepare('UPDATE key_pool SET status=?,retry_at=?,last_used=? WHERE id=?').run(status,retryAt,now(),id);}
 async function synthesize(signals) {
  const rows=db.prepare("SELECT * FROM key_pool WHERE status != 'invalid' AND retry_at <= ? ORDER BY last_used ASC, rowid ASC").all(now());
  for(const row of rows.slice(0,3)) {
   try {
    const response=await fetcher('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${unseal(row)}`,'Content-Type':'application/json'},body:JSON.stringify({model:FREE_MODEL,max_tokens:180,temperature:0.2,messages:[{role:'system',content:'Summarize the supplied market indicators in one neutral sentence under 250 characters. Do not give financial advice or introduce facts, prices, news, or recommendations.'},{role:'user',content:JSON.stringify(signals.map(({symbol,direction,conviction,quant})=>({symbol,direction,conviction,quant})))}]}),signal:AbortSignal.timeout(6000)});
    if(response.status===401||response.status===403){mark(row.id,'invalid');continue;}
    if(response.status===429){const seconds=Number(response.headers.get('retry-after'));mark(row.id,'cooldown',now()+Math.max(60,Math.min(Number.isFinite(seconds)&&seconds>0?seconds:60,3600))*1000);continue;}
    if(!response.ok){mark(row.id,'cooldown',now()+60000);continue;}
    const json=await response.json();const content=json?.choices?.[0]?.message?.content;
    if(typeof content!=='string'||!content.trim()){mark(row.id,'cooldown',now()+60000);continue;}
    mark(row.id,'ready');return content.replace(/[\r\n]+/g,' ').trim().slice(0,250);
   } catch {mark(row.id,'cooldown',now()+60000);}
  }
  return null;
 }
 return {list,add,remove,synthesize};
}
