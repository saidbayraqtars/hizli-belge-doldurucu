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

assert.strictEqual(_test.odemeAciklamasi({
  izahat: '13',
  belgeAciklama: '7 Eylül pazar tahsilatı',
  evrakNo: 'H0001'
}), 'Tahsilat · 7 Eylül pazar tahsilatı · H0001');
assert.strictEqual(_test.odemeAciklamasi({
  izahat: '13',
  belgeAciklama: 'Tahsilat',
  evrakNo: 'H0002'
}), 'Tahsilat · H0002');

// Ödeme geçmişi: Vega ödeme aracı + program açıklaması → yöntem.
assert.strictEqual(_test.odemeYontemiCoz('13', 1, null), 'nakit');
assert.strictEqual(_test.odemeYontemiCoz('13', 11, 'HAVALE'), 'havale');
assert.strictEqual(_test.odemeYontemiCoz('13', 11, 'EFT'), 'eft');
assert.strictEqual(_test.odemeYontemiCoz('13', 11, 'Kredi kartı'), 'kart');
assert.strictEqual(_test.odemeYontemiCoz('13', 11, 'ödeme'), 'banka');
assert.strictEqual(_test.odemeYontemiCoz('83', null, null), 'havale');
assert.strictEqual(_test.odemeYontemiCoz('13', null, null), 'diger');
assert.strictEqual(_test.odemeNotu('HAVALE - Ziraat', 'HAVALE'), 'Ziraat');
assert.strictEqual(_test.odemeNotu('NAKİT tahsilat', null), '');
assert.strictEqual(_test.odemeNotu('EFT - pazar', 'EFT'), 'pazar');
assert.strictEqual(_test.odemeNotu('Tahsilat', 'Kredi kartı'), 'Tahsilat · Kredi kartı');

console.log('Rapor birim testleri geçti: fiş no, kasa türü, tahsilat açıklaması ve ödeme yöntemi.');
