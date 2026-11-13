import {readFile, mkdir, chmod, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBookKnowledge} from '../lib/book-knowledge.mjs';

const [action,arg]=process.argv.slice(2);
if(!['import','list','remove'].includes(action)||(['import','remove'].includes(action)&&!arg)){
 console.error('Usage: npm run book-notes -- import notes.json | list | remove NOTE_ID');process.exit(1);
}
const data=resolve(process.env.APERTURE_DATA_DIR||'data');
await mkdir(data,{recursive:true,mode:0o700});await chmod(data,0o700);
const path=resolve(data,'aperture.sqlite');const db=new DatabaseSync(path);await chmod(path,0o600);
try{
 const knowledge=createBookKnowledge(db);
 if(action==='import'){
  const file=resolve(arg), info=await stat(file);if(info.size>1024*1024)throw new Error('Import file exceeds 1 MB. Use your own concise notes, not a full book.');
  const n=knowledge.addMany(JSON.parse(await readFile(file,'utf8')));console.log(`Imported ${n} user-authored note(s) locally.`);
 }else if(action==='list')console.log(JSON.stringify(knowledge.list(),null,2));
 else if(!knowledge.remove(arg)){console.error('Note ID not found.');process.exitCode=1;}
 else console.log('Note removed.');
}catch(e){console.error(`Book notes: ${e.message}`);process.exitCode=1;}finally{db.close();}
