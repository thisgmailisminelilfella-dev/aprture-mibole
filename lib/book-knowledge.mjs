import { randomUUID } from 'node:crypto';

// Independent notes supplied by the user, not book texts or automated claims of comprehension.
export function createBookKnowledge(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS book_notes (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, locator TEXT NOT NULL,
 market TEXT NOT NULL, strategy TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
 ); CREATE INDEX IF NOT EXISTS book_notes_lookup ON book_notes(market, strategy);`);
 const required=(v,name,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`${name} must be non-empty text of at most ${max} characters.`);return v.trim();};
 function addMany(entries){
  if(!Array.isArray(entries)||entries.length<1||entries.length>100)throw new Error('Import must be a JSON array containing 1–100 notes.');
  const rows=entries.map(e=>{
   if(!e||typeof e!=='object'||Array.isArray(e))throw new Error('Each note must be an object.');
   const market=required(e.market,'market',10);if(!['indian','foreign','crypto','all'].includes(market))throw new Error('market must be indian, foreign, crypto, or all.');
   return {id:randomUUID(),title:required(e.title,'title',200),author:required(e.author,'author',200),locator:required(e.locator,'locator',120),market,strategy:required(e.strategy,'strategy',100),note:required(e.note,'note',1500),created_at:new Date().toISOString()};
  });
  db.exec('BEGIN');try{const insert=db.prepare('INSERT INTO book_notes VALUES (?,?,?,?,?,?,?,?)');for(const r of rows)insert.run(r.id,r.title,r.author,r.locator,r.market,r.strategy,r.note,r.created_at);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  return rows.length;
 }
 function list(){return db.prepare('SELECT * FROM book_notes ORDER BY created_at, id').all();}
 function forSignal(market,strategy){return db.prepare('SELECT title,author,locator,note FROM book_notes WHERE (market=? OR market=\'all\') AND strategy=? COLLATE NOCASE ORDER BY created_at, id LIMIT 5').all(market,strategy);}
 function remove(id){return db.prepare('DELETE FROM book_notes WHERE id=?').run(id).changes>0;}
 return {addMany,list,forSignal,remove};
}
