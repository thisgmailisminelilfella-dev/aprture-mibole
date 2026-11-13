// Intentionally fixed: no option, environment variable, or redirect can select a live endpoint.
const PAPER='https://paper-api.alpaca.markets/v2';
export function createAlpacaPaper({keyId,secretKey,fetcher=fetch}={}) {
 const configured=Boolean(keyId&&secretKey);
 async function request(path,method='GET',body) {
  if(!configured)throw new Error('Alpaca paper credentials are not configured on the host.');
  let res;try {res=await fetcher(PAPER+path,{method,redirect:'error',headers:{'APCA-API-KEY-ID':keyId,'APCA-API-SECRET-KEY':secretKey,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}catch{throw new Error('Alpaca paper service is unavailable. An order may have been received; check the broker dashboard before retrying.');}
  if(!res.ok)throw new Error(`Alpaca paper request was rejected (HTTP ${res.status}). Check the paper account and order details.`);
  if(res.status===204)return null;try{return await res.json();}catch{throw new Error('Alpaca returned an invalid response.');}
 }
 async function positions(market) {
  const data=await request('/positions');if(!Array.isArray(data))throw new Error('Alpaca returned an invalid position list.');
  const numeric=value=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;
  return data.filter(p=>(market==='crypto'?p.asset_class==='crypto':p.asset_class==='us_equity') && typeof p.symbol==='string' && /^[A-Z0-9.\/-]{1,30}$/.test(p.symbol)).map(p=>({id:p.symbol,symbol:p.symbol,direction:p.side==='short'?'SHORT':'LONG',qty:numeric(p.qty),entry:numeric(p.avg_entry_price),mark:numeric(p.current_price),pl:numeric(p.unrealized_pl),source:'Alpaca paper',openedAt:null})).filter(p=>p.qty!==null&&p.entry!==null);
 }
 function convertSymbol(market,symbol) {
  if(typeof symbol!=='string')throw new Error('Invalid symbol.');
  if(market==='foreign' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) && !/\.(NS|BO)$/.test(symbol))return symbol;
  if(market==='crypto' && /^[A-Z0-9]{2,12}-USD$/.test(symbol))return symbol.replace('-','/');
  throw new Error('This symbol is not supported for Alpaca paper orders.');
 }
 async function open(market,symbol,qty) {
  const alpacaSymbol=convertSymbol(market,symbol);
  if(typeof qty!=='number'||!Number.isFinite(qty)||qty<=0||qty>100||(market==='foreign'&&!Number.isInteger(qty)))throw new Error('Enter a valid quantity up to 100 (whole shares for US stocks).');
  const order=await request('/orders','POST',{symbol:alpacaSymbol,qty:String(qty),side:'buy',type:'market',time_in_force:market==='crypto'?'gtc':'day'});
  if(!order||typeof order.id!=='string')throw new Error('Alpaca did not confirm the order. Check the broker before retrying.');
  return {id:order.id,status:typeof order.status==='string'?order.status:'submitted'};
 }
 async function close(market,symbol) {
  const list=await positions(market);if(!list.some(p=>p.symbol===symbol))throw new Error('Paper position not found in this market.');
  const order=await request('/positions/'+encodeURIComponent(symbol),'DELETE');return {status:typeof order?.status==='string'?order.status:'submitted'};
 }
 return {configured,positions,open,close};
}
