'use strict';

const assert = require('assert');
const { _test } = require('../db/rapor');

assert.strictEqual(_test.fisNoCoz(' 123 ', 'H0001'), '123');
assert.strictEqual(_test.fisNoCoz('', ' H0001 '), 'H0001');

const satirlar = [
  { fisNo: '42', kasaTipiKod: 'UP', kasaAdedi: 2, kasaTutari: 200, netKg: 10, tutar: 500 },
  { fisNo: '42', kasaTipiKod: 'up', kasaAdedi: 3, kasaTutari: 300, netKg: 20, tutar: 800 },
  { fisNo: '42', kasaTipiKod: 'PK', kasaAdedi: 1, kasaTutari: 50, netKg: 5, tutar: 200 }
];

const gruplar = _test.fislereBol(satirlar);
assert.strictEqual(gruplar.length, 1);
assert.deepStrictEqual(gruplar[0].kasaTurleri, [
  { anahtar: 'UP', tur: 'UP', adet: 5, tutar: 500 },
  { anahtar: 'PK', tur: 'PK', adet: 1, tutar: 50 }
]);
assert.deepStrictEqual(gruplar[0].araToplam, {
  kasaAdedi: 6,
  kasaTutari: 550,
  netKg: 35,
  tutar: 1500
});

console.log('Rapor birim testleri geçti: fiş no yedeği ve kasa türü birleştirme.');
