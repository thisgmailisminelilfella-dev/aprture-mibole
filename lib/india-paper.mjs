import {randomUUID} from 'node:crypto';

// Local simulation only: fills use the last available daily close, not an exchange quote.
export function createIndiaPaper(db, {now=()=>Date.now()}={}) {
 db.exec(`CREATE TABLE IF NOT EXISTS india_paper_trades (
 id TEXT PRIMARY KEY, symbol TEXT NOT NULL, strategy TEXT NOT NULL, qty INTEGER NOT NULL,
 entry REAL NOT NULL, entry_bar TEXT NOT NULL, opened_at TEXT NOT NULL,
 exit REAL, exit_bar TEXT, closed_at TEXT
 ); CREATE UNIQUE INDEX IF NOT EXISTS india_paper_one_open ON india_paper_trades(symbol) WHERE closed_at IS NULL;`);
 function quote(snapshot,symbol) {
  const s=snapshot.signals.find(item=>item.symbol===symbol);
  const time=Date.parse(s?.dataTime || '');
  if(!s || !Number.isFinite(s.rawClose) || s.rawClose<=0 || !Number.isFinite(time) || time>now()+300000 || now()-time>72*3600000) throw new Error('A daily close no older than 72 hours is required. Run a new Indian scan.');
  return s;
 }
 function open(snapshot,symbol,qty) {
  if(typeof symbol!=='string'||!/^[A-Z][A-Z0-9-]{0,19}\.NS$/.test(symbol))throw new Error('The local simulator supports NSE cash symbols only.');
  if(!Number.isSafeInteger(qty)||qty<1||qty>100)throw new Error('Quantity must be a whole number from 1 to 100.');
  const s=quote(snapshot,symbol);if(s.rawClose*qty>100000)throw new Error('Local paper order exceeds the ₹100,000 notional cap.');if(s.direction!=='LONG')throw new Error('Only long signals can be opened in this simulator.');
  if(db.prepare('SELECT 1 FROM india_paper_trades WHERE symbol=? AND closed_at IS NULL').get(symbol))throw new Error('A paper position is already open for this symbol.');
  const id=randomUUID();db.prepare('INSERT INTO india_paper_trades (id,symbol,strategy,qty,entry,entry_bar,opened_at) VALUES (?,?,?,?,?,?,?)').run(id,symbol,s.strategy,qty,s.rawClose,s.dataTime,new Date(now()).toISOString());return id;
 }
 function close(snapshot,id) {
  const pos=db.prepare('SELECT * FROM india_paper_trades WHERE id=? AND closed_at IS NULL').get(id);if(!pos)throw new Error('Paper position not found.');
  const s=quote(snapshot,pos.symbol);if(Date.parse(s.dataTime)<Date.parse(pos.entry_bar))throw new Error('The available price predates this position. Run a fresh scan.');const result=db.prepare('UPDATE india_paper_trades SET exit=?,exit_bar=?,closed_at=? WHERE id=? AND closed_at IS NULL').run(s.rawClose,s.dataTime,new Date(now()).toISOString(),id);
  if(!result.changes)throw new Error('Paper position is no longer open.');
 }
 function positions(snapshot) {return db.prepare('SELECT * FROM india_paper_trades WHERE closed_at IS NULL ORDER BY opened_at DESC').all().map(p=>{
  const s=snapshot.signals.find(item=>item.symbol===p.symbol), mark=Number.isFinite(s?.rawClose) && s.rawClose>0?s.rawClose:null;
  return {id:p.id,symbol:p.symbol,direction:'LONG',qty:p.qty,entry:p.entry,mark,markTime:mark===null?null:s.dataTime,pl:mark===null?null:(mark-p.entry)*p.qty,openedAt:p.opened_at,source:'Local simulator',strategy:p.strategy};
 });}
 function learning() {return db.prepare(`SELECT strategy,COUNT(*) AS trades,SUM(CASE WHEN exit>entry THEN 1 ELSE 0 END) AS wins,AVG((exit-entry)*qty) AS expectancy FROM india_paper_trades WHERE closed_at IS NOT NULL GROUP BY strategy`).all().map(row=>({strategy:row.strategy,trades:row.trades,wins:row.wins,winRate:row.trades>=3?row.wins/row.trades:null,expectancy:row.trades>=3?row.expectancy:null}));}
 return {open,close,positions,learning};
}
