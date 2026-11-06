import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function validPin(pin) { return typeof pin === 'string' && /^\d{6,12}$/.test(pin); }
export function hashPin(pin) { const salt = randomBytes(16).toString('hex'); return {salt, hash:scryptSync(pin, salt, 32).toString('hex')}; }
export function verifyPin(pin, salt, expectedHex) {
  if (typeof pin !== 'string' || pin.length > 128) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== 32) return false;
  return timingSafeEqual(scryptSync(pin, salt, 32), expected);
}

// Read directly from a terminal without echoing the PIN or placing it in shell history.
export async function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('First-time PIN setup requires an interactive terminal. Set APERTURE_PIN for non-interactive startup.');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new Error('PIN entry was interrupted.'));
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('PIN entry was interrupted.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0,-1);
        else if (value.length < 128) value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
    process.stdout.write(prompt);
  });
}

export async function choosePin() {
  const pin = await readSecret('Create a host PIN (6–12 digits): ');
  if (!validPin(pin)) throw new Error('PIN must be 6–12 digits. No PIN was saved.');
  const confirmation = await readSecret('Confirm host PIN: ');
  if (pin !== confirmation) throw new Error('PINs did not match. No PIN was saved.');
  return pin;
}
