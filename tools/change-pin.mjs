import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readSecret, choosePin, verifyPin, hashPin } from '../lib/pin.mjs';

const path = resolve(process.env.APERTURE_DATA_DIR || 'data', 'aperture.sqlite');
if (!existsSync(path)) throw new Error('No host database found. Start Aperture first.');
const db = new DatabaseSync(path);
try {
  const get = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const salt = get('pin_salt'), hash = get('pin_hash');
  if (!salt || !hash) throw new Error('No PIN is configured. Start Aperture first.');
  const oldPin = await readSecret('Current host PIN: ');
  if (!verifyPin(oldPin,salt,hash)) throw new Error('Incorrect PIN. Nothing changed.');
  const pin = await choosePin(), next = hashPin(pin);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(next.salt,'pin_salt');
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(next.hash,'pin_hash');
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  console.log('PIN updated. Restart Aperture to invalidate previous sessions.');
} finally { db.close(); }
