import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../lib/quant.mjs';
test('trend analysis uses supplied prices and returns explicit risk levels',()=>{const prices=Array.from({length:70},(_,i)=>100+i);const signal=analyze('ABC',prices,'$');assert.equal(signal.direction,'LONG');assert.equal(signal.entry,'$169.00');assert.notEqual(signal.stop,'—');assert.match(signal.invalidation,/20-day/);});
test('insufficient or flat data never creates a directional recommendation',()=>{assert.throws(()=>analyze('ABC',[1,2,3]));assert.equal(analyze('ABC',Array(70).fill(100)).direction,'WATCH');});
