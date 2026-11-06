import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validPin,hashPin,verifyPin} from '../lib/pin.mjs';
test('host PIN requires 6–12 digits and stores a salted hash',()=>{
 assert.equal(validPin('12345'),false);assert.equal(validPin('123456'),true);assert.equal(validPin('1234567890123'),false);assert.equal(validPin('123a56'),false);
 const a=hashPin('123456'),b=hashPin('123456');assert.notEqual(a.salt,b.salt);assert.notEqual(a.hash,b.hash);assert.notEqual(a.hash,'123456');assert.equal(verifyPin('123456',a.salt,a.hash),true);assert.equal(verifyPin('654321',a.salt,a.hash),false);
});
