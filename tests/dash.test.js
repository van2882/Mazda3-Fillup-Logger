// node tests/dash.test.js
const assert = require('assert');
const P = require('../parse.js');
const trip = (t) => P.parseTrip(t);
assert.strictEqual(trip('TRIP A 631.9 km'), 631.9);
assert.strictEqual(trip('A 631.9km'), 631.9);
assert.strictEqual(trip('TRIP A 63I.9 km'), 631.9);      // I read for 1
assert.strictEqual(trip('A 1O12.4 km'), 1012.4);         // O read for 0
assert.strictEqual(trip('412,3 km'), 412.3);             // comma decimal
assert.strictEqual(trip('TRIP A 631 9 km'), 631.9);      // dot read as a space
assert.strictEqual(trip('TRIP A 6319 km'), 631.9);       // dot lost
assert.strictEqual(trip('ODO 45210 km'), null);          // odometer is not the trip
assert.strictEqual(trip('6.8 L/100km'), null);           // fuel economy
assert.strictEqual(trip('22.5°C 10:42'), null);          // temperature / clock
const odo = P.parseDash('TRIP A 631.9 km\nODO 128455 km').find((c) => c.kind === 'odo');
assert.strictEqual(odo.value, 128455);
// voting: anchored readings beat stray numbers; litres sanity check breaks ties
assert.strictEqual(P.pickTrip([{ kind: 'trip', value: 631.9, w: 6 }, { kind: 'trip', value: 63.1, w: 2 }]).value, 631.9);
assert.strictEqual(P.pickTrip([{ value: 63.1, w: 3 }, { value: 631.9, w: 3 }], { litres: 43 }).value, 631.9);
console.log('dash parsing: all passed');
