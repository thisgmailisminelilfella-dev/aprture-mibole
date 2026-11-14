import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { analyze } from './lib/quant.mjs';
import { createBookKnowledge } from './lib/book-knowledge.mjs';
import { createIndiaPaper } from './lib/india-paper.mjs';
import { createAlpacaPaper } from './lib/alpaca-paper.mjs';
import { createKeyPool } from './lib/key-pool.mjs';
import { validPin, hashPin, verifyPin, choosePin } from './lib/pin.mjs';

const root = resolve('public'), data = resolve(process.env.APERTURE_DATA_DIR || 'data');
const port = Number(process.env.PORT || 7421);
await mkdir(data, { recursive:true, mode:0o700 }); await chmod(data, 0o700);
const db = new DatabaseSync(resolve(data, 'aperture.sqlite'));
await chmod(resolve(data, 'aperture.sqlite'), 0o600);
db.exec(`PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS snapshots (market TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL);`);
const get = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
const set = (key,value) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
if (!get('pin_hash')) {
  const pin = process.env.APERTURE_PIN !== undefined ? process.env.APERTURE_PIN : await choosePin();
  if (!validPin(pin)) throw new Error('PIN must be 6–12 digits. No PIN was saved.');
  const {salt, hash} = hashPin(pin);
  db.exec('BEGIN');
  try { set('pin_salt', salt); set('pin_hash', hash); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log('Host PIN initialized.');
}

const keyPool = await createKeyPool(db, data);
const indiaPaper=createIndiaPaper(db);
const bookKnowledge=createBookKnowledge(db);
const alpaca=createAlpacaPaper({keyId:process.env.ALPACA_PAPER_KEY_ID,secretKey:process.env.ALPACA_PAPER_SECRET_KEY});
const paperRequests=new Set();
const sessions = new Map(), attempts = new Map(), listeners = new Set();
const validMarkets = ['indian','foreign','crypto'];
const defaults = {indian:['RELIANCE.NS','INFY.NS','HDFCBANK.NS'],foreign:['AAPL','MSFT','SPY'],crypto:['BTC-USD','ETH-USD','SOL-USD']};
let paused = get('paused') === 'true', running = false, generation = 0, scanController = null;
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
function send(res, status, value, extra={}) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}); res.end(JSON.stringify(value)); }
function snapshot(market) { const row=db.prepare('SELECT value,updated FROM snapshots WHERE market=?').get(market); return row ? {signals:JSON.parse(row.value),updated:row.updated} : {signals:[],updated:null}; }
function state(market){const snap=snapshot(market);return {market,...snap,signals:snap.signals.map(s=>({...s,bookNotes:typeof s.strategy==='string'?bookKnowledge.forSignal(market,s.strategy):[]})),paused,running, keyHealth:keyPool.list().some(k=>k.status==='ready')?'Free-tier pool ready': 'LLM reasoning degraded — math signals only.', keyPool:keyPool.list(), readiness:null,positions:market==='indian'?indiaPaper.positions(snapshot(market)):[],learning:market==='indian'?indiaPaper.learning():[],paperProvider:market==='indian'?'Local simulator':'Alpaca paper',paperConfigured:market==='indian'||alpaca.configured,playbook:'Repo preset',mode:'paper',provider:'Yahoo Finance daily chart', limitations:['Manual paper orders only; no automatic strategy execution.','Readiness cannot be calculated without a verified trade ledger.']};}
function broadcast(){ for(const res of listeners) res.write('data: update\n\n'); }
function validSession(req){const token = /(?:^|;\s*)aperture_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1]; if (!token) return false; const hash=createHash('sha256').update(token).digest('hex'); const session=sessions.get(hash); if (!session || session.expires<Date.now() || session.pinHash!==get('pin_hash')){sessions.delete(hash);return false;} return true;}
function checkPin(req, pin) {
 const ip=req.socket.remoteAddress||'unknown', attempt=attempts.get(ip)||{count:0,until:0};
 if(attempt.until>Date.now()) return {status:429,error:'Too many attempts. Try again later.'};
 if(!verifyPin(pin,get('pin_salt'),get('pin_hash'))) {
  attempt.count++; if(attempt.count>=5){attempt.until=Date.now()+5*60*1000;attempt.count=0;}
  attempts.set(ip,attempt); return {status:401,error:'Incorrect PIN.'};
 }
 attempts.delete(ip); return null;
}
// Never accept key material or a re-authentication PIN over unencrypted remote LAN HTTP.
function secureKeyTransport(req){
 if(req.socket.encrypted) return true;
 const remote=req.socket.remoteAddress;
 const isLoopback=remote==='127.0.0.1'||remote==='::1'||remote==='::ffff:127.0.0.1';
 try {const host=new URL(`http://${req.headers.host}`).hostname; return isLoopback && (host==='localhost'||host==='127.0.0.1'||host==='[::1]');}catch{return false;}
}
function sameOrigin(req){ try { return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch {return false;} }
async function body(req){let text=''; for await (const chunk of req){text+=chunk;if(text.length>4096) throw new Error('Request too large');}return JSON.parse(text||'{}');}
function mappedSymbol(market, input) { const s=input.trim().toUpperCase(); if(!/^[A-Z0-9][A-Z0-9.\-^=]{0,19}$/.test(s)) throw new Error('Invalid symbol'); if(market==='indian' && !s.includes('.')) return `${s}.NS`; if(market==='crypto' && !s.includes('-')) return `${s}-USD`; return s; }
async function fetchSignal(market,symbol,signal){
 const response=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`, {headers:{'User-Agent':'Aperture-Phone/1.0'},signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
 if(!response.ok) throw new Error(`Data provider returned ${response.status}`);
 const json=await response.json(); const chart=json?.chart?.result?.[0]; const closes=chart?.indicators?.quote?.[0]?.close;
 if(!Array.isArray(closes)) throw new Error('No price history available');
 const currency=chart.meta?.currency; const unit=currency==='INR'?'₹':currency==='USD'?'$':currency ? `${String(currency).replace(/[^A-Z]/g,'').slice(0,3)} ` : '';
 const result=analyze(symbol,closes,unit);
 const lastIndex=closes.findLastIndex(value=>typeof value==='number' && Number.isFinite(value) && value>0);
 const stamp=chart.timestamp?.[lastIndex]; result.dataTime=Number.isFinite(stamp)?new Date(stamp*1000).toISOString():null;
 return result;
}
async function runScan(market,target,version,controller){
 try {
   const symbols=target?[mappedSymbol(market,target)]:defaults[market];
   const results=await Promise.allSettled(symbols.map(s=>fetchSignal(market,s,controller.signal)));
   if (version!==generation || paused) return;
   const signals=results.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>b.conviction-a.conviction);
   if(signals.length){
     const writeSnapshot=()=>db.prepare('INSERT INTO snapshots VALUES (?,?,?) ON CONFLICT(market) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(market,JSON.stringify(signals),new Date().toISOString());
     // Publish the quant result first; a slow or unavailable model must not hold it back.
     writeSnapshot();lastMessage='Quant signals ready; checking the free model pool…';broadcast();
     const summary=await keyPool.synthesize(signals,{signal:controller.signal});
     if (version!==generation || paused) return;
     if(summary) {signals[0].llmNote=summary;writeSnapshot();}
   }
   lastMessage=signals.length ? `Updated ${signals.length} of ${symbols.length} symbols from the free daily feed.` : 'Data feed unavailable. The previous snapshot was kept.';
 } catch(e){lastMessage=e.message||'Scan failed. The previous snapshot was kept.';}
 finally {running=false;if(scanController===controller)scanController=null;broadcast();}
}
let lastMessage='';
const handler=async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   if(req.method==='POST' && !sameOrigin(req)) return send(res,403,{error:'Origin rejected'});
   if(url.pathname==='/api/unlock' && req.method==='POST'){
    const input=await body(req), failure=checkPin(req,input.pin);
    if(failure) return send(res,failure.status,{error:failure.error});
    const token=randomBytes(32).toString('hex');sessions.set(createHash('sha256').update(token).digest('hex'),{expires:Date.now()+8*60*60*1000,pinHash:get('pin_hash')});
    return send(res,200,{ok:true},{'Set-Cookie':`aperture_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`});
   }
   if(!validSession(req)) return send(res,401,{error:'Unlock required'});
   // Deliberately fail closed: no live broker or verified readiness gate exists.
   // Any future implementation must keep the session, origin, market and PIN checks
   // before evaluating broker/readiness requirements and changing execution mode.
   if(url.pathname==='/api/live/activate' && req.method==='POST'){
    const input=await body(req);
    if(!validMarkets.includes(input.market)) return send(res,400,{error:'Invalid market'});
    const failure=checkPin(req,input.pin);
    if(failure) return send(res,failure.status,{error:failure.error});
    return send(res,503,{error:'Live trading is unavailable: no live broker or verified readiness gate is configured.'});
   }
   if(url.pathname==='/api/paper/positions' && req.method==='GET'){
    const market=url.searchParams.get('market');if(!validMarkets.includes(market))return send(res,400,{error:'Invalid market'});
    try {return send(res,200,{positions:market==='indian'?indiaPaper.positions(snapshot(market)):await alpaca.positions(market),provider:market==='indian'?'Local simulator':'Alpaca paper'});}catch(e){return send(res,503,{error:e.message});}
   }
   if(url.pathname==='/api/paper/open' && req.method==='POST'){
    const input=await body(req);if(!validMarkets.includes(input.market)||typeof input.symbol!=='string'||typeof input.qty!=='number')return send(res,400,{error:'Invalid paper order.'});
    if(paused)return send(res,409,{error:'Scans are paused. Resume before opening a paper position.'});
    const s=snapshot(input.market).signals.find(item=>item.symbol===input.symbol);if(!s || s.direction!=='LONG')return send(res,400,{error:'A current long signal is required.'});
    if(input.expectedDataTime!==s.dataTime || input.expectedClose!==s.rawClose)return send(res,409,{error:'The signal changed. Reopen it and review the current daily close before ordering.'});
    const bar=Date.parse(s.dataTime||'');if(!Number.isFinite(bar)||bar>Date.now()+300000||Date.now()-bar>72*3600000)return send(res,400,{error:'A daily close no older than 72 hours is required. Run a fresh scan.'});
    const lock=input.market+':'+input.symbol;if(paperRequests.has(lock))return send(res,409,{error:'A paper order is already being submitted.'});paperRequests.add(lock);
    try {if(input.market==='indian'){indiaPaper.open(snapshot('indian'),input.symbol,input.qty);broadcast();return send(res,201,{status:'simulated',message:'Local paper position opened at the last daily close.'});}
     const result=await alpaca.open(input.market,input.symbol,input.qty);broadcast();return send(res,202,{status:result.status,message:'Paper order submitted to Alpaca. A fill is not guaranteed; check your broker.'});
    }catch(e){return send(res,400,{error:e.message});}finally{paperRequests.delete(lock);}
   }
   if(url.pathname==='/api/paper/close' && req.method==='POST'){
    const input=await body(req);if(!validMarkets.includes(input.market)||typeof input.id!=='string'||input.id.length>100)return send(res,400,{error:'Invalid paper position.'});
    const lock='close:'+input.market+':'+input.id;if(paperRequests.has(lock))return send(res,409,{error:'Close request already in progress.'});paperRequests.add(lock);
    try {if(input.market==='indian'){indiaPaper.close(snapshot('indian'),input.id);broadcast();return send(res,200,{message:'Local paper position closed at the last daily close.'});}
     const result=await alpaca.close(input.market,input.id);broadcast();return send(res,202,{status:result.status,message:'Close order submitted to Alpaca; the position remains until filled.'});
    }catch(e){return send(res,400,{error:e.message});}finally{paperRequests.delete(lock);}
   }
   if(url.pathname==='/api/keys' && req.method==='GET') return send(res,200,{keys:keyPool.list(), canManage:secureKeyTransport(req)});
   if(url.pathname==='/api/keys' && req.method==='POST'){
    if(!secureKeyTransport(req)) return send(res,403,{error:'Manage keys on localhost or through direct HTTPS; remote HTTP is not secure.'});
    const input=await body(req), failure=checkPin(req,input.pin);
    if(failure) return send(res,failure.status,{error:failure.error});
    try {keyPool.add(input.key,input.provider,input.freeTierConfirmed);broadcast();return send(res,201,{ok:true,keys:keyPool.list()});}
    catch(e) {return send(res,400,{error:e.message});}
   }
   if(url.pathname==='/api/keys/remove' && req.method==='POST'){
    if(!secureKeyTransport(req)) return send(res,403,{error:'Manage keys on localhost or through direct HTTPS; remote HTTP is not secure.'});
    const input=await body(req), failure=checkPin(req,input.pin);
    if(failure) return send(res,failure.status,{error:failure.error});
    if(typeof input.id!=='string'||!keyPool.remove(input.id)) return send(res,404,{error:'Key not found.'});
    broadcast();return send(res,200,{ok:true,keys:keyPool.list()});
   }
   if(url.pathname==='/api/logout' && req.method==='POST'){const token=/(?:^|;\s*)aperture_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];if(token)sessions.delete(createHash('sha256').update(token).digest('hex'));return send(res,200,{ok:true},{'Set-Cookie':'aperture_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
   if(url.pathname==='/api/state' && req.method==='GET'){const market=url.searchParams.get('market');if(!validMarkets.includes(market))return send(res,400,{error:'Invalid market'});return send(res,200,{...state(market),message:lastMessage});}
   if(url.pathname==='/api/events' && req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': connected\n\n');listeners.add(res);req.on('close',()=>listeners.delete(res));return;}
   if(url.pathname==='/api/run' && req.method==='POST'){const input=await body(req);if(!validMarkets.includes(input.market))return send(res,400,{error:'Invalid market'});if(paused)return send(res,409,{error:'Engine paused. Resume before running.'});if(running)return send(res,409,{error:'A scan is already running.'});try {if(input.target) mappedSymbol(input.market,String(input.target));}catch(e){return send(res,400,{error:e.message});}running=true;scanController=new AbortController();lastMessage='Scan running…';broadcast();void runScan(input.market,String(input.target||''),generation,scanController);return send(res,202,{ok:true});}
   if(url.pathname==='/api/pause' && req.method==='POST'){const input=await body(req);if(typeof input.paused!=='boolean')return send(res,400,{error:'Invalid state'});paused=input.paused;set('paused',String(paused));if(paused){generation++;scanController?.abort();}lastMessage=paused?'Engine paused. Cancellation requested; an upstream request may already have been processed.':'Engine resumed.';broadcast();return send(res,200,{ok:true,paused});}
   return send(res,404,{error:'Not found'});
  }
  if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405).end();return;}
  const pathname=decodeURIComponent(url.pathname), file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  const content=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':pathname==='/sw.js'?'no-cache':'no-store','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'"});res.end(content);
 }catch(e){if(!res.headersSent)send(res,400,{error:'Request could not be processed'});else res.end();}
};
const hasTls=process.env.APERTURE_TLS_CERT && process.env.APERTURE_TLS_KEY;
if(Boolean(process.env.APERTURE_TLS_CERT)!==Boolean(process.env.APERTURE_TLS_KEY)) throw new Error('Both APERTURE_TLS_CERT and APERTURE_TLS_KEY are required for HTTPS.');
const server=hasTls ? https.createServer({cert:await readFile(process.env.APERTURE_TLS_CERT),key:await readFile(process.env.APERTURE_TLS_KEY)},handler) : http.createServer(handler);
server.listen(port,'0.0.0.0',()=>console.log(`Aperture phone: ${hasTls?'https':'http'}://localhost:${port} (LAN accessible; use only on a trusted network)`));
