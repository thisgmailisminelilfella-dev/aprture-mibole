// Deterministic, offline provider responses for paper-order integration tests only.
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
 const url=String(input);
 if(url.startsWith('https://query1.finance.yahoo.com/')){
  const sec=Math.floor(Date.now()/1000),closes=Array.from({length:60},(_,i)=>100+i);
  return Response.json({chart:{result:[{timestamp:closes.map(()=>sec),meta:{currency:url.includes('.NS')?'INR':'USD'},indicators:{quote:[{close:closes}]}}]}});
 }
 if(url.startsWith('https://paper-api.alpaca.markets/v2/')){
  if(url.endsWith('/positions')&&options.method==='GET')return Response.json([{symbol:'AAPL',asset_class:'us_equity',qty:'1',avg_entry_price:'150',current_price:'159',unrealized_pl:'9'}]);
  return Response.json({id:'fake-paper-order',status:'accepted'});
 }
 return originalFetch(input,options);
};
