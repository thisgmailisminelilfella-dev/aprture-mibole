// Loaded only by the integration test: simulate an indefinitely waiting price feed.
const actualFetch=globalThis.fetch;
globalThis.fetch=(input,options={})=>{
 if(String(input).startsWith('https://query1.finance.yahoo.com/')) return new Promise((resolve,reject)=>{
  const abort=()=>{console.log('TEST_FEED_ABORTED');reject(new Error('feed aborted'));};
  if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
 });
 return actualFetch(input,options);
};
