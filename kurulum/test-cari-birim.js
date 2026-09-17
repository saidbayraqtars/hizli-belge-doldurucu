'use strict';

// Cari kartı satırı — veritabanına dokunmadan. Vega'nın kendi ekranından açılan
// kartlarla karşılaştırma VEGA_TEST üzerinde elle yapıldı (bkz. db/cari.js başı);
// burada o desenin kodda korunduğu denetleniyor.

const assert = require('assert');
const { _test } = require('../db/cari');

const firma = { subeAdi: 'MERKEZ', depoInd: 1, ozelKod1: ['TOPTAN', 'PERAKENDE'] };

const sahis = _test.kartSatiriKur({
  kod: ' 5008 ', tur: 'sahis', adi: 'mustafa', soyadi: 'küskün', telefon: '5327035268',
  sehir: 'kocaköy', ozelKod1: 'perakende', tip: 'alici', tarih: '2026-09-17'
}, firma);
assert.strictEqual(sahis.FIRMAKODU, '5008');
assert.strictEqual(sahis.FIRMAADI, 'MUSTAFA KÜSKÜN');
assert.strictEqual(sahis.UNVAN, 'MUSTAFA KÜSKÜN');
assert.strictEqual(sahis.ADI, 'MUSTAFA');
assert.strictEqual(sahis.SOYADI, 'KÜSKÜN');
assert.strictEqual(sahis.ISLETMETURU, 1);
assert.strictEqual(sahis.FIRMATIPI, 1);
assert.strictEqual(sahis.KOD1, 'PERAKENDE');
assert.strictEqual(sahis.SEHIR, 'KOCAKÖY');
assert.strictEqual(sahis.SUBEADI, 'MERKEZ');
assert.strictEqual(sahis.KAYITTARIHI.toISOString(), '2026-09-17T00:00:00.000Z');

// Vega ekranından açılmış kartların ortak değerleri (müşteri kopyası IND 609).
const vega609 = {
  PARABIRIMI: 'TL', STATUS: 1, STATU: 0, TAKSITTIPI: 1, ISKONTO: 0, AYLIKVADE: 0,
  OPSIYON: 0, GECIKMEFAIZI: 0, BAKIYE: 0, ODEMEBAKIYESI: 0, ZIMFIYAT: 0,
  KREDILIMITIKONTROL: 2, CARIPOZISYON: 0, KURTIPI: 1, SMSGONDER: true, EMAILGONDER: true,
  SATISYAPILMASIN: false, TAHSILATYAPILMASIN: false, IADEFATURASIKESILMESIN: false,
  ODEMEYAPILMASIN: false, ALISYAPILMASIN: false, SIPARISYAPILMASIN: false, DEPOIND: 1
};
for (const [kolon, deger] of Object.entries(vega609)) {
  assert.strictEqual(sahis[kolon], deger, `${kolon} Vega kartından farklı`);
}

const firmaKarti = _test.kartSatiriKur({
  kod: 'F1', tur: 'firma', unvan: 'örnek gıda ltd', vergiNo: '1234567890', tip: 'ikisi'
}, firma);
assert.strictEqual(firmaKarti.ISLETMETURU, 0);
assert.strictEqual(firmaKarti.ADI, null);
assert.strictEqual(firmaKarti.FIRMAADI, 'ÖRNEK GIDA LTD');
assert.strictEqual(firmaKarti.FIRMATIPI, 3);

assert.throws(() => _test.kartSatiriKur({ kod: '', adi: 'a' }, firma), /Cari kodu/);
assert.throws(() => _test.kartSatiriKur({ kod: '1', adi: '' }, firma), /Adı/);
assert.throws(() => _test.kartSatiriKur({ kod: '1', tur: 'firma' }, firma), /ünvanı/);
assert.throws(() => _test.kartSatiriKur({ kod: '1', adi: 'a', vergiNo: '12a' }, firma), /Vergi/);
assert.throws(() => _test.kartSatiriKur({ kod: '1', adi: 'a', ozelKod1: 'UYDURMA' }, firma), /tanımlı değil/);

console.log('Cari kartı birim testleri geçti: şahıs/firma alanları, Vega varsayılanları, denetimler.');
