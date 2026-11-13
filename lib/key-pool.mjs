import { randomBytes, createCipheriv, createDecipheriv, createHmac, randomUUID } from 'node:crypto';
import { open, readFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';

// These text models have a documented free tier. This is an allowlist, not a
// guarantee: Google's API does not disclose whether the key's project is billed.
// Review it against https://ai.google.dev/gemini-api/docs/pricing when updating.
export const GOOGLE_FREE_MODELS = Object.freeze([
 'gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash-lite',
 'gemini-3.1-flash-lite','gemini-3-flash-preview','gemini-2.5-flash','gemini-2.5-flash-lite'
]);
const ORIGIN_OPENROUTER='https://openrouter.ai/api/v1';
const ORIGIN_GOOGLE='https://generativelanguage.googleapis.com/v1beta';
const instruction='Summarize the supplied market indicators in one neutral sentence under 250 characters. Do not give financial advice or introduce facts, prices, news, or recommendations.';
const timeout=signal=>signal ? AbortSignal.any([signal,AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000);

// Only text-capable explicitly :free models with zero advertised pricing are eligible.
export function selectOpenRouterModels(models) {
 if (!Array.isArray(models)) return [];
 const isZero = value => (typeof value==='string' && value.trim()!=='' || typeof value==='number') && Number.isFinite(Number(value)) && Number(value)===0;
 return models.filter(model=>{
  if(typeof model?.id!=='string' || !/^[a-zA-Z0-9_.\/-]+:free$/.test(model.id) || model.id.length>160) return false;
  const price=model.pricing;
  if(!price || !isZero(price.prompt) || !isZero(price.completion) || Object.values(price).some(value=>value!=null && !isZero(value))) return false;
  const arch=model.architecture;
  if(!arch || !Array.isArray(arch.input_modalities) || !arch.input_modalities.includes('text') || !Array.isArray(arch.output_modalities) || !arch.output_modalities.includes('text')) return false;
  return typeof model.context_length==='number' && model.context_length>=4096;
 }).sort((a,b)=>{
  const rank = m => /instruct|chat|flash/i.test(m.id) ? 0 : /code|safety|embed|audio/i.test(m.id) ? 2 : 1;
  return rank(a)-rank(b) || a.id.localeCompare(b.id);
 }).map(model=>model.id);
}
export function selectGoogleModels(models) {
 if(!Array.isArray(models))return [];
 const available=new Set(models.filter(m=>Array.isArray(m?.supportedGenerationMethods)&&m.supportedGenerationMethods.includes('generateContent')).map(m=>m.name));
 return GOOGLE_FREE_MODELS.filter(id=>available.has(`models/${id}`));
}

export async function createKeyPool(db, dataDir, {fetcher=fetch, now=()=>Date.now()}={}) {
 const path=join(dataDir,'keypool.master');
 try { await access(path); } catch(e) {
  if(e.code!=='ENOENT') throw e;
  const hasTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='key_pool'").get();
  if(hasTable && db.prepare('SELECT 1 FROM key_pool LIMIT 1').get()) throw new Error('Key pool master key is missing. Restore it from backup before starting.');
 }
 try { const file=await open(path,'wx',0o600); try {await file.writeFile(randomBytes(32));} finally {await file.close();} } catch(e) {if(e.code!=='EEXIST') throw e;}
 await chmod(path,0o600);
 const master=await readFile(path); if(master.length!==32) throw new Error('Invalid key pool master key');
 db.exec(`CREATE TABLE IF NOT EXISTS key_pool (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, encrypted BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, status TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0, provider TEXT NOT NULL DEFAULT 'openrouter', google_confirmed INTEGER NOT NULL DEFAULT 0)`);
 // Preserve previously stored OpenRouter keys and assign their provider explicitly.
 const columns=db.prepare('PRAGMA table_info(key_pool)').all().map(column=>column.name);
 if(!columns.includes('provider')) db.exec("ALTER TABLE key_pool ADD COLUMN provider TEXT NOT NULL DEFAULT 'openrouter'");
 if(!columns.includes('google_confirmed')) db.exec('ALTER TABLE key_pool ADD COLUMN google_confirmed INTEGER NOT NULL DEFAULT 0');
 function seal(secret) {const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',master,iv);const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return {iv,encrypted,tag:cipher.getAuthTag()};}
 function unseal(row) {const cipher=createDecipheriv('aes-256-gcm',master,row.iv);cipher.setAuthTag(row.tag);return Buffer.concat([cipher.update(row.encrypted),cipher.final()]).toString('utf8');}
 function list() {return db.prepare('SELECT id,provider,status,retry_at,last_used FROM key_pool ORDER BY rowid').all().map(row=>({id:row.id,provider:row.provider==='google'?'Google AI Studio':'OpenRouter', status:row.status==='cooldown'&&row.retry_at<=now()?'untested':row.status,retryAt:row.retry_at||null,lastUsed:row.last_used||null}));}
 function add(secret,provider='openrouter',freeTierConfirmed=false) {
  if(provider!=='openrouter' && provider!=='google') throw new Error('Choose a supported provider.');
  if(typeof secret!=='string'||secret.length>512 || (provider==='openrouter'?!/^sk-or-v1-[a-zA-Z0-9_-]{1,500}$/.test(secret):!/^AIza[a-zA-Z0-9_-]{20,}$/.test(secret))) throw new Error(`Enter a valid ${provider==='google'?'Google AI Studio':'OpenRouter'} API key.`);
  if(provider==='google' && freeTierConfirmed!==true) throw new Error('Confirm that billing is disabled on the Google project before adding the key.');
  if(list().length>=20) throw new Error('The pool is limited to 20 keys.');
  const fingerprint=createHmac('sha256',master).update(secret).digest('hex');
  if(db.prepare('SELECT id FROM key_pool WHERE fingerprint=?').get(fingerprint)) throw new Error('This key is already in the pool.');
  const {iv,encrypted,tag}=seal(secret);const id=randomUUID();
  db.prepare('INSERT INTO key_pool (id,fingerprint,encrypted,iv,tag,status,provider,google_confirmed) VALUES (?,?,?,?,?,?,?,?)').run(id,fingerprint,encrypted,iv,tag,'untested',provider,provider==='google'?1:0);
  return id;
 }
 function remove(id) {return db.prepare('DELETE FROM key_pool WHERE id=?').run(id).changes>0;}
 function mark(id,status,retryAt=0) {db.prepare('UPDATE key_pool SET status=?,retry_at=?,last_used=? WHERE id=?').run(status,retryAt,now(),id);}
 function delay(response) {const seconds=Number(response.headers.get('retry-after'));return Math.max(60,Math.min(Number.isFinite(seconds)&&seconds>0?seconds:60,3600))*1000;}
 const keyExists=id=>Boolean(db.prepare('SELECT 1 FROM key_pool WHERE id=?').get(id));
 async function googleModels(key,id,signal) {
  const models=[];let page='';
  for(let i=0;i<3;i++) {
   if(signal?.aborted || !keyExists(id)) return {models:[]};
   const url=new URL(`${ORIGIN_GOOGLE}/models`);url.searchParams.set('pageSize','100');if(page)url.searchParams.set('pageToken',page);
   const res=await fetcher(url.toString(),{headers:{'x-goog-api-key':key},signal:timeout(signal)});
   if(!res.ok) return {response:res,models:[]};
   const json=await res.json();if(Array.isArray(json.models))models.push(...json.models);
   page=typeof json.nextPageToken==='string'?json.nextPageToken:'';if(!page)break;
  }
  return {models:selectGoogleModels(models)};
 }
 async function synthesize(signals,{signal}={}) {
  const rows=db.prepare("SELECT * FROM key_pool WHERE status != 'invalid' AND retry_at <= ? ORDER BY last_used ASC, rowid ASC").all(now());
  if(!rows.length) return null;
  const input=JSON.stringify(signals.map(({symbol,direction,conviction,quant})=>({symbol,direction,conviction,quant})));
  let openRouterModels; // Shared within one scan; do not use stale prices on future scans.
  for(const row of rows.slice(0,3)) {
   if(signal?.aborted) return null;
   if(!keyExists(row.id)) continue;
   try {
    const key=unseal(row);let models;
    if(row.provider==='google') {
     // Only explicitly attested Google keys can ever be used.
     if(row.google_confirmed!==1){mark(row.id,'invalid');continue;}
     const result=await googleModels(key,row.id,signal);
     if(result.response){if(result.response.status===401||result.response.status===403){mark(row.id,'invalid');continue;}mark(row.id,'cooldown',now()+(result.response.status===429?delay(result.response):60000));continue;}
     models=result.models;
    } else if(row.provider==='openrouter') {
     if(openRouterModels===undefined){try{const response=await fetcher(`${ORIGIN_OPENROUTER}/models`,{signal:timeout(signal)});openRouterModels=response.ok?selectOpenRouterModels((await response.json()).data):[];}catch{openRouterModels=[];}}
     models=openRouterModels;
    } else {mark(row.id,'invalid');continue;}
    if(signal?.aborted) return null;
    let wait=60000;
    for(const model of models.slice(0,3)) {
     if(signal?.aborted) return null;
     if(!keyExists(row.id)) break;
     let response;
     if(row.provider==='google'){
      response=await fetcher(`${ORIGIN_GOOGLE}/models/${model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:instruction}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{maxOutputTokens:180,temperature:0.2}}),signal:timeout(signal)});
     }else{
      response=await fetcher(`${ORIGIN_OPENROUTER}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,max_tokens:180,temperature:0.2,messages:[{role:'system',content:instruction},{role:'user',content:input}]}),signal:timeout(signal)});
     }
     if(response.status===401||response.status===403){mark(row.id,'invalid');break;}
     if(response.status===429){wait=Math.max(wait,delay(response));continue;}
     if(!response.ok)continue;
     const json=await response.json();
     const content=row.provider==='google'?json?.candidates?.[0]?.content?.parts?.filter(p=>!p.thought&&typeof p.text==='string').map(p=>p.text).join(' '):json?.choices?.[0]?.message?.content;
     if(typeof content==='string'&&content.trim()){mark(row.id,'ready');return content.replace(/[\r\n]+/g,' ').trim().slice(0,250);}
    }
    // Preserve rejected keys as invalid; all other failures cool down.
    const current=db.prepare('SELECT status FROM key_pool WHERE id=?').get(row.id);
    if(current && current.status!=='invalid')mark(row.id,'cooldown',now()+wait);
   } catch {if(signal?.aborted)return null;mark(row.id,'cooldown',now()+60000);}
  }
  return null;
 }
 return {list,add,remove,synthesize};
}
