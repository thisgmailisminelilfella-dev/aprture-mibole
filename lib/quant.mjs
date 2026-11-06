/** Deterministic daily-close trend analysis. This is not a forecast or advice. */
export function analyze(symbol, closes, currency = '$') {
  const values = closes.filter(x => typeof x === 'number' && Number.isFinite(x) && x > 0);
  if (values.length < 50) throw new Error('At least 50 daily closes are required');
  const mean = n => values.slice(-n).reduce((a,b)=>a+b,0)/n;
  const last = values.at(-1), ma20 = mean(20), ma50 = mean(50);
  const returns = values.slice(-21).slice(1).map((v,i)=>v/values.slice(-21)[i]-1);
  const volatility = Math.sqrt(returns.reduce((sum,v)=>sum+v*v,0)/returns.length);
  const distance = Math.max(0.02, Math.min(0.12, volatility * 2));
  const direction = ma20 > ma50 * 1.005 && last > ma20 ? 'LONG' : ma20 < ma50 * 0.995 && last < ma20 ? 'SHORT' : 'WATCH';
  const conviction = direction === 'WATCH' ? 2 : Math.min(4, 2 + Number(Math.abs(ma20/ma50-1) > .02) + Number(Math.abs(last/ma20-1) > .02));
  const fmt = value => currency + value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const stop = direction === 'SHORT' ? last*(1+distance) : last*(1-distance);
  const target = direction === 'SHORT' ? last*(1-2*distance) : last*(1+2*distance);
  return {symbol, name:symbol, direction, conviction, thesis:`Daily close is ${last >= ma20 ? 'above' : 'below'} the 20-day average; the 20-day average is ${ma20 >= ma50 ? 'above' : 'below'} the 50-day average.`, entry:fmt(last), stop: direction === 'WATCH' ? '—' : fmt(stop), target:direction === 'WATCH' ? '—' : fmt(target), horizon:'Daily', strategy:'20 / 50 day trend', quant:`20-day mean ${fmt(ma20)}; 50-day mean ${fmt(ma50)}; 20-day daily RMS return ${(volatility*100).toFixed(2)}%. Levels are illustrative, not orders.`, invalidation:direction === 'WATCH'?'No directional setup is present.':`A daily close crossing the 20-day mean (${fmt(ma20)}) invalidates this simple trend setup.`};
}
