import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createIndiaPaper} from '../lib/india-paper.mjs';
import {createAlpacaPaper} from '../lib/alpaca-paper.mjs';

const now=Date.parse('2026-11-13T12:00:00Z');
const sheet=(price=100,direction='LONG',time=new Date(now).toISOString())=>({signals:[{symbol:'INFY.NS',rawClose:price,direction,dataTime:time,strategy:'20 / 50 day trend'}]});
test('India paper ledger uses daily closes, validates risk and stores strategy statistics',()=>{
 const db=new DatabaseSync(':memory:');const paper=createIndiaPaper(db,{now:()=>now});
 assert.throws(()=>paper.open(sheet(),'INFY.NS',0),/Quantity/);assert.throws(()=>paper.open(sheet(),'INFY.NS',1.5),/Quantity/);
 assert.throws(()=>paper.open(sheet(100,'SHORT'),'INFY.NS',1),/long/);assert.throws(()=>paper.open(sheet(),'AAPL',1),/NSE/);
 assert.throws(()=>paper.open(sheet(2000),'INFY.NS',100),/notional/);assert.throws(()=>paper.open(sheet(100,'LONG','2026-01-01T00:00:00Z'),'INFY.NS',1),/72 hours/);
 const id=paper.open(sheet(),'INFY.NS',2);assert.throws(()=>paper.open(sheet(),'INFY.NS',1),/already open/);
 assert.deepEqual(paper.positions(sheet(110)).map(p=>[p.symbol,p.qty,p.entry,p.mark,p.pl]),[['INFY.NS',2,100,110,20]]);
 assert.throws(()=>paper.close(sheet(110,'LONG','2026-01-01T00:00:00Z'),id),/72 hours/);
 paper.close(sheet(110),id);assert.equal(paper.positions(sheet()).length,0);assert.throws(()=>paper.close(sheet(),id),/not found/);
 assert.deepEqual(paper.learning().map(x=>[x.trades,x.wins,x.winRate,x.expectancy]),[[1,1,null,null]]);
 for(let i=0;i<2;i++){const trade=paper.open(sheet(),'INFY.NS',1);paper.close(sheet(90),trade);}
 const stats=paper.learning()[0];assert.equal(stats.trades,3);assert.equal(stats.wins,1);assert.equal(stats.winRate,1/3);assert.equal(stats.expectancy,0);db.close();
});

test('Alpaca adapter only uses fixed paper host and never exposes credentials',async()=>{
 const calls=[];const key='PK_TEST_KEY',secret='SECRET_TEST';
 const fetcher=async(url,options)=>{calls.push({url,options});if(url.endsWith('/positions')&&options.method==='GET')return new Response(JSON.stringify([{symbol:'AAPL',asset_class:'us_equity',qty:'1',avg_entry_price:'100',current_price:'102',unrealized_pl:'2'},{symbol:'BTC/USD',asset_class:'crypto',qty:'0.01',avg_entry_price:'50000',current_price:'51000',unrealized_pl:'10'}]),{status:200});return new Response(JSON.stringify({id:'paper-order',status:'accepted'}),{status:200});};
 const paper=createAlpacaPaper({keyId:key,secretKey:secret,fetcher});assert.equal(paper.configured,true);
 const stocks=await paper.positions('foreign');assert.deepEqual(stocks.map(x=>x.symbol),['AAPL']);assert.equal(JSON.stringify(stocks).includes(secret),false);
 assert.deepEqual((await paper.positions('crypto')).map(x=>x.symbol),['BTC/USD']);
 await paper.open('foreign','AAPL',1);await paper.open('crypto','BTC-USD',0.001);await paper.close('crypto','BTC/USD');
 assert.ok(calls.every(c=>c.url.startsWith('https://paper-api.alpaca.markets/v2/')&&c.options.redirect==='error'));
 assert.ok(calls.every(c=>c.options.headers['APCA-API-SECRET-KEY']===secret&&!c.url.includes(secret)));
 const posts=calls.filter(c=>c.options.method==='POST').map(c=>JSON.parse(c.options.body));assert.equal(posts[0].symbol,'AAPL');assert.equal(posts[1].symbol,'BTC/USD');assert.equal(posts[1].time_in_force,'gtc');
 await assert.rejects(paper.open('foreign','RELIANCE.NS',1),/not supported/);await assert.rejects(paper.open('indian','AAPL',1),/not supported/);await assert.rejects(paper.open('foreign','AAPL',1.1),/quantity/i);
 const offline=createAlpacaPaper({});await assert.rejects(offline.positions('foreign'),/not configured/);
 const reject=createAlpacaPaper({keyId:key,secretKey:secret,fetcher:async()=>new Response(secret,{status:403})});await assert.rejects(reject.positions('foreign'),e=>!e.message.includes(secret));
});
