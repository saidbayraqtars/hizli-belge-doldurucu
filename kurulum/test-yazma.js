'use strict';

// VEGADB'YE YAZMA SINAMASI
//
//     sqlcmd -S localhost -E -C -i kurulum\vega-test-olustur.sql   (bir kez)
//     node kurulum/test-yazma.js
//
// GERÇEK MÜŞTERİ VERİSİNE DOKUNMAZ. Yapısı VEGADB'den kopyalanmış boş bir
// VEGA_TEST veritabanında çalışır. Program kendi ayrı bir veritabanı
// tutmuyor — üç küçük yardımcı tablo da (dara, kasa defteri, yazma günlüğü)
// bizzat VEGA_TEST'in içine kurulur, tıpkı canlıda VEGADB'nin içine
// kurulacağı gibi. Sınama başlarken veritabanının adını doğrular ve adı
// beklenenden farklıysa hiçbir şey yapmadan çıkar — yanlışlıkla canlı
// veritabanına yazmanın önünü kesen tek koruma bu.
//
// Sınadığı şey: belge yazıldığında beş tablonun da doğru bağ alanlarıyla
// dolduğu, cari bakiyenin doğru değiştiği, tahsilatın ayrı bir cari giriş
// olarak yazıldığı, kasa defterinin (BD_KasaHareket) doğru işlediği ve geri
// almanın hiç iz bırakmadığı.

const fs = require('fs');
const path = require('path');
const os = require('os');

const VEGA_TEST = 'VEGA_TEST';

// Ayar dosyası, db modülleri yüklenmeden önce hazırlanmalı: ayar.js yolu ilk
// okumada belirliyor ve bir daha değiştirmiyor.
const proje = path.join(__dirname, '..');
let canli = {};
try {
  canli = JSON.parse(fs.readFileSync(path.join(proje, 'ayarlar.json'), 'utf8').replace(/^﻿/, ''));
} catch (e) {
  console.error(
    'Once projenin kokunde ayarlar.json olusturun (sunucu adi, kullanici, sifre).\n' +
    'Sinama baglanti bilgilerini oradan aliyor.'
  );
  process.exit(1);
}

const sinamaAyari = Object.assign({}, canli, {
  vegaVeritabani: VEGA_TEST,
  vegayaYazmaAktif: true,
  varsayilanFirma: 'F0102',
  varsayilanDonem: 'D0001',
  varsayilanDepo: 1,
  varsayilanKdv: 0,
  belgeOneki: 'H'
});

const ayarDosyasi = path.join(os.tmpdir(), 'belge-doldurucu-sinama-ayar.json');
fs.writeFileSync(ayarDosyasi, JSON.stringify(sinamaAyari, null, 2), 'utf8');
process.env.BELGE_AYAR_DOSYASI = ayarDosyasi;

const { ayarOku } = require('../db/ayar');
const sql = require('../db/sql');
const firma = require('../db/firma');
const vega = require('../db/vega');
const rapor = require('../db/rapor');
const yardimci = require('../db/yardimci');
const yazma = require('../db/yazma');
const gecmisBakim = require('./gecmis-belgeleri-duzelt');
const kasaOnar = require('./kasa-kartlarini-onar');

let gecen = 0;
let kalan = 0;

function kontrol(baslik, kosul, not) {
  if (kosul) {
    gecen++;
    console.log(`  [gecti] ${baslik}${not ? ' — ' + not : ''}`);
  } else {
    kalan++;
    console.log(`  [KALDI] ${baslik}${not ? ' — ' + not : ''}`);
  }
}

function bolum(ad) {
  console.log(`\n=== ${ad} ===`);
}

function tarihAnahtari(tarih) {
  const d = tarih instanceof Date ? tarih : new Date(tarih);
  return d.toISOString().slice(0, 10);
}

const FIRMA = 'F0102';
const DONEM = 'D0001';

function vtAdi(ad, donemli) {
  return `[${VEGA_TEST}].dbo.${FIRMA}${donemli ? DONEM : ''}${ad}`;
}

let geciciKasaKarti = null;

// VEGA_TEST'teki mevcut kartı değiştirmeden, şemasındaki zorunlu sütunları
// örnek karttan kopyalayarak yalnız bu teste ait bir kart oluşturur.
async function kartSatiriKopyala(tabloAdi, kaynakInd, degisiklikler) {
  const kolonlar = await sql.sorgu(`
    SELECT name FROM [${VEGA_TEST}].sys.columns
    WHERE object_id = OBJECT_ID(@tablo) AND is_identity = 0 AND is_computed = 0
      AND system_type_id <> 189 AND generated_always_type = 0
    ORDER BY column_id`, { tablo: tabloAdi });
  if (!kolonlar.length) throw new Error(`Test kartı sütunları okunamadı: ${tabloAdi}`);
  const parametreler = { kaynakInd };
  const adlar = kolonlar.map((k) => `[${k.name}]`);
  const degerler = kolonlar.map((k, i) => {
    if (!Object.prototype.hasOwnProperty.call(degisiklikler, k.name)) return `[${k.name}]`;
    parametreler[`deger${i}`] = degisiklikler[k.name];
    return `@deger${i}`;
  });
  const sonuc = await sql.sorgu(`
    INSERT INTO ${tabloAdi} (${adlar.join(', ')}) OUTPUT INSERTED.IND AS ind
    SELECT ${degerler.join(', ')} FROM ${tabloAdi} WHERE IND = @kaynakInd`, parametreler);
  if (sonuc.length !== 1) throw new Error(`Test kartı kaynak satırı bulunamadı: ${tabloAdi}/${kaynakInd}`);
  return Number(sonuc[0].ind);
}

// Yalnız sınamanın kendi kodlarıyla açılan kasa kartları, birimleri ve tipleri.
// HIZMET tipi, sistem kartıyla çakışma sınaması için geçici eklenen BD satırıdır;
// VEGA_TEST'teki HIZMET stok kartına dokunulmaz.
const SINAMA_KASA_KODLARI = "'SINAMA-KASA', 'SINAMA-EKSIK'";

async function sinamaKasalariniTemizle() {
  await sql.calistir(`DELETE B FROM ${vtAdi('TBLBIRIMLEREX', false)} B
    JOIN ${vtAdi('TBLSTOKLAR', false)} S ON S.IND = B.STOKNO
    WHERE S.STOKKODU IN (${SINAMA_KASA_KODLARI})`);
  await sql.calistir(`DELETE FROM ${vtAdi('TBLSTOKLAR', false)}
    WHERE STOKKODU IN (${SINAMA_KASA_KODLARI})`);
  await sql.calistir(`
    IF OBJECT_ID('[${VEGA_TEST}].dbo.BD_KasaTipi', 'U') IS NOT NULL
      DELETE FROM [${VEGA_TEST}].dbo.BD_KasaTipi WHERE Kod IN (${SINAMA_KASA_KODLARI}, 'HIZMET')`);
  geciciKasaKarti = null;
}

async function kartSayisi(ad) {
  const r = await sql.sorgu(`SELECT COUNT(*) AS adet FROM ${vtAdi(ad, false)}`);
  return Number(r[0].adet);
}

async function satirSayisi(ad, donemli) {
  const r = await sql.sorgu(`SELECT COUNT(*) AS adet FROM ${vtAdi(ad, donemli)}`);
  return Number(r[0].adet);
}

// Yazma yolunun dokunduğu bütün tablolar. Geri almadan sonra hepsi sıfır olmalı.
const HAREKET_TABLOLARI = [
  'TBLCARIHAREKETLERI', 'TBLCARIGENELHAREKET',
  'TBLCARCIKBASLIK', 'TBLCARCIKHAREKET',
  'TBLCARGIRBASLIK', 'TBLCARGIRHAREKET',
  'TBLSATFATBASLIK', 'TBLSATFATHAREKET',
  'TBLSTOKHAREKETLERI', 'TBLDEPOENVANTER',
  'TBLSTKGIRBASLIK', 'TBLSTKGIRHAREKET'
];

async function tumSayilar() {
  const s = {};
  for (const t of HAREKET_TABLOLARI) s[t] = await satirSayisi(t, true);
  return s;
}

function toplamSatir(sayilar) {
  return Object.keys(sayilar).reduce((t, k) => t + sayilar[k], 0);
}

async function hareketleriTemizle() {
  for (const t of HAREKET_TABLOLARI) {
    await sql.calistir(`DELETE FROM ${vtAdi(t, true)}`);
  }
}

async function yardimciTablolariTemizle() {
  const v = VEGA_TEST;
  // Her sınama temiz bir yardımcı günlükle başlasın diye test veritabanındaki
  // olası eski/yarım kayıtları fiziksel olarak temizliyoruz.
  for (const t of ['BD_KasaHareket', 'BD_Islem', 'BD_BelgeSatir']) {
    await sql.calistir(`
      IF OBJECT_ID('[${v}].dbo.${t}', 'U') IS NOT NULL DELETE FROM [${v}].dbo.${t}
    `);
  }
}

async function calistir() {
  console.log('Hizli Belge Doldurucu — YAZMA sinamasi');
  console.log('Ayar dosyasi: ' + ayarDosyasi);

  const a = ayarOku();

  // --- Emniyet: yanlış veritabanına yazma ---------------------------------
  bolum('Emniyet kontrolu');

  if (a.vegaVeritabani !== VEGA_TEST) {
    console.error(
      `\nDURDURULDU. Sinama yalnizca ${VEGA_TEST} uzerinde calisir.\n` +
      `Su an: ${a.vegaVeritabani}`
    );
    process.exit(1);
  }
  kontrol('Sinama veritabani dogru', true, a.vegaVeritabani);

  const t = await sql.baglantiTesti();
  kontrol('Baglanti kuruldu', t.veritabani === VEGA_TEST, t.veritabani);

  // Kopya gerçekten boş mu? Doluysa canlı veritabanına bakıyor olabiliriz.
  await hareketleriTemizle();
  await yardimci.hazirla(true);
  await yardimciTablolariTemizle();

  const baslangic = await tumSayilar();
  kontrol('Hareket tablolari bos', toplamSatir(baslangic) === 0,
    `${toplamSatir(baslangic)} satir`);

  kontrol('Yazma acik', yazma.yazmaAcikMi());

  // --- Sınama verisi -------------------------------------------------------
  bolum('Sinama verisi');

  firma.onbellekTemizle();
  const firmalar = await firma.firmalariGetir(true);
  const f = firmalar.find((x) => x.kod === FIRMA);
  kontrol('Kopyada firma bulundu', !!f, f ? f.kisaAd : '—');
  if (!f) return ozet();

  const cariler = await vega.carileriGetir({ firma: FIRMA, donem: DONEM, limit: 5 });
  kontrol('Kopyada cari kartlari var', cariler.length > 0, `${cariler.length} cari`);
  const stoklar = await vega.stoklariGetir({ firma: FIRMA, donem: DONEM, limit: 5 });
  kontrol('Kopyada stok kartlari var', stoklar.length >= 2, `${stoklar.length} kart`);
  if (!cariler.length || stoklar.length < 2) return ozet();

  const cari = cariler[0];
  console.log(`         Musteri: ${cari.ad} (IND ${cari.cariInd}), baslangic bakiyesi ${cari.bakiye}`);

  // Önceki başarısız sınamadan kalabilecek, yalnız sınama koduyla açılmış
  // kasa kartlarını ve tiplerini sil; sistem kartlarına hiçbir koşulda dokunma.
  await sinamaKasalariniTemizle();

  // ======================================================================
  bolum('Kasa tipi programdan acilinca Vega karti');

  const stokKartiOnce = await kartSayisi('TBLSTOKLAR');
  let cakismaHatasi = '';
  try {
    await yardimci.kasaTipiKaydet({ firma: FIRMA, donem: DONEM,
      kod: 'HIZMET', ad: 'Cakisma Sinamasi', dara: 0, depozito: 5 });
  } catch (e) { cakismaHatasi = e.message; }
  kontrol('KASA isaretsiz karttaki kod kasaya cevrilmedi',
    /HIZMET.*kasa olarak işaretlenmemiş/.test(cakismaHatasi), cakismaHatasi);
  const cakisanTipSatiri = await sql.sorgu(
    `SELECT COUNT(*) AS adet FROM [${VEGA_TEST}].dbo.BD_KasaTipi WHERE Kod = 'HIZMET'`);
  kontrol('Cakisan kodda ne BD_KasaTipi ne Vega karti kaldi',
    Number(cakisanTipSatiri[0].adet) === 0 && (await kartSayisi('TBLSTOKLAR')) === stokKartiOnce);

  const kasaKayit = await yardimci.kasaTipiKaydet({ firma: FIRMA, donem: DONEM,
    kod: 'SINAMA-KASA', ad: '[TEST] Sinama Kasa', dara: 1.5, depozito: 100 });
  const kasaVegaStokNo = Number(kasaKayit.stokNo);
  kontrol('Programdan eklenen kasa tipi Vega kartini acti',
    kasaKayit.kartAcildi === true && kasaVegaStokNo > 0, `kart ${kasaVegaStokNo}`);
  const acilanKart = await sql.sorgu(`
    SELECT S.KOD1, S.STOKTIPI, S.MALINCINSI, S.ANABIRIM, S.BIRIMEX, S.KDVGRUBU, S.DEPO,
           S.UID AS stokUid, S.KARTINACILMATARIHI,
           B.IND AS birimEx, B.STOKNO, B.BIRIMADI, B.CARPAN, B.VARSAYILAN,
           B.ANABIRIM AS birimAna, B.AGIRLIK, B.SATISFIYATI1, B.PB1, B.UID AS birimUid
    FROM ${vtAdi('TBLSTOKLAR', false)} S
    JOIN ${vtAdi('TBLBIRIMLEREX', false)} B ON B.STOKNO = S.IND
    WHERE S.IND = @stokNo`, { stokNo: kasaVegaStokNo });
  const ak = acilanKart[0] || {};
  const kasaVegaBirimEx = Number(ak.birimEx);
  kontrol('Acilan kartin tek birimi var', acilanKart.length === 1, `${acilanKart.length} birim`);
  kontrol('Kart KOD1=KASA, STOKTIPI=0, adi tipten, acilis tarihi dolu',
    ak.KOD1 === 'KASA' && Number(ak.STOKTIPI) === 0 &&
      ak.MALINCINSI === '[TEST] Sinama Kasa' && !!ak.KARTINACILMATARIHI);
  kontrol('Kart ve birim cift yonlu bagli (BIRIMEX = ANABIRIM = birim IND)',
    Number(ak.ANABIRIM) === kasaVegaBirimEx && Number(ak.BIRIMEX) === kasaVegaBirimEx &&
      Number(ak.STOKNO) === kasaVegaStokNo);
  kontrol('Birim ADET, carpan 1, varsayilan ve ana birim',
    ak.BIRIMADI === 'ADET' && Number(ak.CARPAN) === 1 && ak.VARSAYILAN === true && ak.birimAna === true);
  kontrol('Dara AGIRLIK, depozito SATISFIYATI1 alaninda',
    Number(ak.AGIRLIK) === 1.5 && Number(ak.SATISFIYATI1) === 100 && ak.PB1 === 'TL');
  kontrol('Kart ve birim Vega UID bicimini tasiyor',
    /^\{[0-9A-F-]{36}\}$/.test(ak.stokUid || '') && /^\{[0-9A-F-]{36}\}$/.test(ak.birimUid || ''));
  kontrol('Kartta depo ve KDV grubu dolu', Number(ak.DEPO) === 1 && Number(ak.KDVGRUBU) === 1,
    `depo ${ak.DEPO} · kdv grubu ${ak.KDVGRUBU}`);

  const tipler = await yardimci.kasaTipleriGetir({ firma: FIRMA, donem: DONEM, sadeceAktif: true });
  const kasa = tipler.find((k) => k.kod === 'SINAMA-KASA');
  kontrol('Kasa tipi listede, dara/depozito Vega kartindan',
    !!kasa && kasa.dara === 1.5 && kasa.depozito === 100, kasa ? `${kasa.kod} (Id ${kasa.id})` : 'yok');
  if (!kasa) return ozet();
  kontrol('Testte kasa tipi, Vega karti ve birimi farkli',
    kasa.id !== kasaVegaStokNo && kasa.id !== kasaVegaBirimEx &&
      kasaVegaStokNo !== kasaVegaBirimEx);

  await yardimci.kasaTipiKaydet({ firma: FIRMA, donem: DONEM, id: kasa.id,
    kod: 'SINAMA-KASA', ad: '[TEST] Sinama Kasa', dara: 1.5, depozito: 120 });
  const fiyatSonra = await sql.sorgu(`SELECT SATISFIYATI1, ESKIFIYAT1
    FROM ${vtAdi('TBLBIRIMLEREX', false)} WHERE IND = @birimEx`, { birimEx: kasaVegaBirimEx });
  kontrol('Kaydet Vega depozitosunu guncelledi, eski fiyat ESKIFIYAT1de',
    Number(fiyatSonra[0].SATISFIYATI1) === 120 && Number(fiyatSonra[0].ESKIFIYAT1) === 100);
  // Kod baş/son boşluktan arınır. Harf büyüklüğü Vega'nın Türkçe harmanına
  // bırakılır: orada 'sinama' büyütülünce 'SİNAMA' olur, 'SINAMA' ile başka koddur.
  const tekrarEkleme = await yardimci.kasaTipiKaydet({ firma: FIRMA, donem: DONEM,
    kod: '  SINAMA-KASA ', ad: '[TEST] Sinama Kasa', dara: 1.5, depozito: 100 });
  kontrol('Ayni kodla (bosluklu) ekleme ayni tipi ve karti kullandi',
    tekrarEkleme.id === kasa.id && tekrarEkleme.kartAcildi === false &&
      Number(tekrarEkleme.stokNo) === kasaVegaStokNo);
  let kodDegisimHatasi = '';
  try {
    await yardimci.kasaTipiKaydet({ firma: FIRMA, donem: DONEM, id: kasa.id,
      kod: 'SINAMA-BASKA', ad: 'Baska', dara: 1.5, depozito: 100 });
  } catch (e) { kodDegisimHatasi = e.message; }
  kontrol('Kayitli kasa tipinin kodu degistirilemedi', /değiştirilemez/.test(kodDegisimHatasi),
    kodDegisimHatasi);

  // Çoklu varsayılan birim sınaması için karta ikinci (varsayılan olmayan) birim.
  geciciKasaKarti = { stokNo: kasaVegaStokNo, birimIdleri: [] };
  geciciKasaKarti.birimIdleri.push(await kartSatiriKopyala(vtAdi('TBLBIRIMLEREX', false),
    kasaVegaBirimEx, { VARSAYILAN: 0 }));

  // Örnek: 12,3 kg brüt - 1×1,5 kg dara = 10,8 kg × 30 TL = 324,00 TL ürün
  // + 1 kasa × 100 TL depozito.
  function ornekSatirlar() {
    return [
      {
        stokNo: stoklar[0].stokNo, stokKodu: stoklar[0].kod, stokAdi: stoklar[0].ad,
        birim: stoklar[0].birim, birimEx: stoklar[0].birimEx,
        brutMiktar: 12.3, daraliMiktar: 10.8, fiyat: 30, tutar: 324,
        kasaAdedi: 1, kasaDarasi: kasa.dara, kasaStokNo: kasa.id, kasaTipiKod: kasa.kod,
        kasaDepozito: 100, kasaTutari: 100,
        aciklama: 'ELLE YAZILAN NOT'
      },
      {
        stokNo: stoklar[1].stokNo, stokKodu: stoklar[1].kod, stokAdi: stoklar[1].ad,
        birim: stoklar[1].birim, birimEx: stoklar[1].birimEx,
        brutMiktar: 5, daraliMiktar: 5, fiyat: 20, tutar: 100,
        kasaAdedi: 0, kasaStokNo: null, kasaTipiKod: null,
        kasaDepozito: 0, kasaTutari: 0
      }
    ];
  }

  const URUN_TOPLAM = 424;   // 324 + 100
  const KASA_TOPLAM = 100;
  const TAHSILAT = 200;
  const TAHSILAT_ACIKLAMA = 'TEST TAHSILAT BELGE ACIKLAMASI';
  const BEKLENEN_BORC = URUN_TOPLAM + KASA_TOPLAM - TAHSILAT;
  // Bugünden farklı ama halen raporlanan hafta içinde bir iş tarihi. Böylece
  // Son Belgeler'in kayıt anını değil belge tarihini gösterdiği kanıtlanır.
  const SATIS_TARIHI = rapor.haftaAraligi(new Date()).baslangic;

  bolum('Kart eşleşmesi güvenliği');
  // Güncellemeden önce programdan kartsız eklenmiş eski tipin taklidi.
  const eksikKayit = await sql.sorgu(`INSERT INTO [${VEGA_TEST}].dbo.BD_KasaTipi (Kod, Ad, Dara, Depozito)
    OUTPUT INSERTED.Id AS id VALUES ('SINAMA-EKSIK', 'Kartsiz Sinama', 0.7, 15)`);
  const eksikTip = { id: Number(eksikKayit[0].id), kod: 'SINAMA-EKSIK' };
  const secilebilir = await yardimci.kasaTipleriGetir({ firma: FIRMA, donem: DONEM, sadeceAktif: true });
  kontrol('Vega karti olmayan tip secim listesine gelmedi',
    !secilebilir.some((k) => k.kod === 'SINAMA-EKSIK') && secilebilir.some((k) => k.kod === 'SINAMA-KASA'));
  const tipSorunlari = await yardimci.kasaTipiSorunlari({ firma: FIRMA, donem: DONEM });
  kontrol('Kartsiz tip ayar ekraninda nedeniyle bildirildi',
    tipSorunlari.some((x) => x.kod === 'SINAMA-EKSIK' && /Vega/.test(x.neden)));
  let eksikKartHatasi = '';
  try {
    await yazma.belgeYaz({
      firma: FIRMA, donem: DONEM, tarih: SATIS_TARIHI,
      cariInd: cari.cariInd, cariAd: cari.ad,
      belgeTuru: 'satisFaturasi', fisNo: 'SINAMA-EKSIK',
      satirlar: [{ ...ornekSatirlar()[0], kasaStokNo: eksikTip.id,
        kasaTipiKod: eksikTip.kod }]
    });
  } catch (e) { eksikKartHatasi = e.message; }
  kontrol('Vega karti olmayan kasa tipi acik hatayla reddedildi',
    /SINAMA-EKSIK.*Vega/i.test(eksikKartHatasi), eksikKartHatasi);
  let tipsizHata = '';
  try {
    await yazma.belgeYaz({
      firma: FIRMA, donem: DONEM, tarih: SATIS_TARIHI,
      cariInd: cari.cariInd, belgeTuru: 'satisFaturasi',
      satirlar: [{ ...ornekSatirlar()[0], kasaStokNo: null }]
    });
  } catch (e) { tipsizHata = e.message; }
  kontrol('Kasa adedi olup tipi olmayan satir reddedildi', /kasa tipi seçilmeli/i.test(tipsizHata));
  let urunKartiHatasi = '';
  try {
    await yazma.belgeYaz({
      firma: FIRMA, donem: DONEM, tarih: SATIS_TARIHI,
      cariInd: cari.cariInd, belgeTuru: 'satisFaturasi',
      satirlar: [{ ...ornekSatirlar()[1], stokNo: 999999 }]
    });
  } catch (e) { urunKartiHatasi = e.message; }
  kontrol('Vega karti olmayan urun satiri reddedildi',
    /bulunmayan stok kartı: 999999/i.test(urunKartiHatasi));
  let cokluBirimHatasi = '';
  try {
    await sql.calistir(`UPDATE ${vtAdi('TBLBIRIMLEREX', false)}
      SET VARSAYILAN=1 WHERE IND=@id AND STOKNO=@stokNo`,
    { id:geciciKasaKarti.birimIdleri[0], stokNo:kasaVegaStokNo });
    await yazma.belgeYaz({ firma:FIRMA, donem:DONEM, cariInd:cari.cariInd,
      belgeTuru:'satisFaturasi', satirlar:[ornekSatirlar()[0]] });
  } catch (e) { cokluBirimHatasi=e.message; }
  finally {
    await sql.calistir(`UPDATE ${vtAdi('TBLBIRIMLEREX', false)}
      SET VARSAYILAN=0 WHERE IND=@id AND STOKNO=@stokNo`,
    { id:geciciKasaKarti.birimIdleri[0], stokNo:kasaVegaStokNo });
  }
  kontrol('Birden fazla varsayilan birim acik hatayla reddedildi',
    /birden çok varsayılan birim/i.test(cokluBirimHatasi),cokluBirimHatasi);
  let silinmisKartHatasi = '', silinmisUrunHatasi = '';
  try {
    const etkilenen = await sql.calistir(`UPDATE ${vtAdi('TBLSTOKLAR', false)}
      SET DELETED = 1 WHERE IND = @stokNo AND STOKKODU = 'SINAMA-KASA'`,
      { stokNo: kasaVegaStokNo });
    if (etkilenen[0] !== 1) throw new Error('Test kasa kartı silinmiş işaretlenemedi.');
    try { await yazma.belgeYaz({
      firma: FIRMA, donem: DONEM, tarih: SATIS_TARIHI,
      cariInd: cari.cariInd, belgeTuru: 'satisFaturasi',
      satirlar: [ornekSatirlar()[0]]
    }); } catch (e) { silinmisKartHatasi = e.message; }
    try { await yazma.belgeYaz({
      firma:FIRMA, donem:DONEM, tarih:SATIS_TARIHI,
      cariInd:cari.cariInd, belgeTuru:'satisFaturasi',
      satirlar:[{...ornekSatirlar()[1], stokNo:kasaVegaStokNo}]
    }); } catch (e) { silinmisUrunHatasi=e.message; }
  } finally {
    // Bu kart yalnız testin geçici kopyasıdır.
    await sql.calistir(`UPDATE ${vtAdi('TBLSTOKLAR', false)}
      SET DELETED = 0 WHERE IND = @stokNo AND STOKKODU = 'SINAMA-KASA'`,
      { stokNo: kasaVegaStokNo });
  }
  kontrol('Silinmis Vega kasa karti reddedildi',
    /SINAMA-KASA.*Vega/i.test(silinmisKartHatasi), silinmisKartHatasi);
  kontrol('Silinmis Vega urun karti reddedildi',
    /bulunmayan stok kartı/i.test(silinmisUrunHatasi), silinmisUrunHatasi);
  kontrol('Reddedilen faturadan hareket kalmadi',
    toplamSatir(await tumSayilar()) === 0);

  // ======================================================================
  bolum('Guncelleme bakimi — Vega kartsiz kasa tipleri');

  const cakisanTip = await sql.sorgu(`INSERT INTO [${VEGA_TEST}].dbo.BD_KasaTipi (Kod, Ad, Dara, Depozito)
    OUTPUT INSERTED.Id AS id VALUES ('HIZMET', 'Cakisan Sinama', 0, 5)`);
  const hizmetKarti = async () => JSON.stringify(await sql.sorgu(`SELECT IND, KOD1, MALINCINSI, BIRIMEX
    FROM ${vtAdi('TBLSTOKLAR', false)} WHERE STOKKODU = 'HIZMET'`));
  const hizmetOnce = await hizmetKarti();
  const kartTarama = await kasaOnar.eksikKartlariTara({ firma: FIRMA });
  kontrol('Bakim kartsiz tipi acilacak buldu',
    kartTarama.acilacak.length === 1 && kartTarama.acilacak[0].kod === 'SINAMA-EKSIK',
    kartTarama.acilacak.map((x) => x.kod).join(', ') || 'yok');
  kontrol('Bakim KASA isaretsiz karttaki kodu acilamaz saydi',
    kartTarama.engelli.some((x) => x.kod === 'HIZMET'));
  const kartAcma = await kasaOnar.eksikKartlariAc(kartTarama);
  kontrol('Bakim kartsiz tipin Vega kartini acti',
    kartAcma.acilan.length === 1 && kartAcma.hatalar.length === 0,
    kartAcma.hatalar.map((x) => x.neden).join('; '));
  kontrol('Cakisan urun kartina dokunulmadi', (await hizmetKarti()) === hizmetOnce);
  const eksikArtikHazir = (await yardimci.kasaTipleriGetir({ firma: FIRMA, donem: DONEM, sadeceAktif: true }))
    .find((k) => k.kod === 'SINAMA-EKSIK');
  kontrol('Acilan kart eski tipin dara ve depozitosunu tasiyor',
    !!eksikArtikHazir && eksikArtikHazir.id === eksikTip.id &&
      eksikArtikHazir.dara === 0.7 && eksikArtikHazir.depozito === 15);
  kontrol('Ikinci taramada acilacak kart kalmadi',
    (await kasaOnar.eksikKartlariTara({ firma: FIRMA })).acilacak.length === 0);
  await sql.calistir(`DELETE FROM [${VEGA_TEST}].dbo.BD_KasaTipi WHERE Id = @id AND Kod = 'HIZMET'`,
    { id: Number(cakisanTip[0].id) });

  const bakimDurumu = path.join(os.tmpdir(), `kasa-karti-bakim-sinama-${process.pid}.json`);
  const oto1 = await kasaOnar.otomatikCalistir({ surum: 'sinama', durumYolu: bakimDurumu });
  const oto2 = await kasaOnar.otomatikCalistir({ surum: 'sinama', durumYolu: bakimDurumu });
  kontrol('Otomatik kasa bakimi tamamlandi, ayni surumde tekrar calismadi',
    oto1.tamamlandi === true && oto2.atlandi === true && oto2.neden === 'daha-once-tamamlandi');
  for (const dosya of [bakimDurumu, oto1.kartDosyasi, oto1.dogrulamaDosyasi, oto1.yedek]) {
    if (dosya && fs.existsSync(dosya)) fs.unlinkSync(dosya);
  }

  // ======================================================================
  bolum('A — Satis faturasi olarak yazma (+ tahsilat)');

  const yazmaA = await yazma.belgeYaz({
    firma: FIRMA, donem: DONEM, tarih: SATIS_TARIHI,
    cariInd: cari.cariInd, cariAd: cari.ad,
    belgeTuru: 'satisFaturasi', fisNo: 'SINAMA-A',
    satirlar: ornekSatirlar(),
    tahsilat: TAHSILAT,
    tahsilatAciklama: TAHSILAT_ACIKLAMA
  });
  kontrol('Vegaya yazildi', yazmaA.tamam, yazmaA.belgeNo);
  kontrol('Urun toplami dogru', yazmaA.urunTutari === URUN_TOPLAM, String(yazmaA.urunTutari));
  kontrol('Kasa tutari dogru', yazmaA.kasaTutari === KASA_TOPLAM, String(yazmaA.kasaTutari));
  kontrol('Belge numarasi H onekli', /^H\d{7}/.test(yazmaA.belgeNo), yazmaA.belgeNo);
  kontrol('Kasa artik ayri belge acmiyor (fatura icine 2. kalem oldu)',
    yazmaA.kasaBelgeNo === null, String(yazmaA.kasaBelgeNo));
  kontrol('Tahsilat ayri belge no aldi',
    !!yazmaA.tahsilatBelgeNo && yazmaA.tahsilatBelgeNo !== yazmaA.belgeNo, yazmaA.tahsilatBelgeNo);

  const sA = await tumSayilar();
  kontrol('Satis faturasi basligi 1 satir', sA.TBLSATFATBASLIK === 1, String(sA.TBLSATFATBASLIK));
  kontrol('Fatura satirlari 3 satir (2 urun + 1 kasa)', sA.TBLSATFATHAREKET === 3, String(sA.TBLSATFATHAREKET));
  kontrol('Stok hareketi 3 satir', sA.TBLSTOKHAREKETLERI === 3, String(sA.TBLSTOKHAREKETLERI));
  kontrol('Depo envanteri 3 satir', sA.TBLDEPOENVANTER === 3, String(sA.TBLDEPOENVANTER));
  const kasaBaglari = await sql.sorgu(`
    SELECT H.IND AS satirInd, H.STOKNO AS satirStok, H.BIRIMEX AS satirBirim,
           S.IND AS hareketInd, S.STOKNO AS hareketStok, S.BIRIMEX AS hareketBirim,
           E.IND AS envanterInd, E.STOKNO AS envanterStok
    FROM ${vtAdi('TBLSATFATHAREKET', true)} H
    JOIN ${vtAdi('TBLSTOKHAREKETLERI', true)} S ON S.LN = H.IND
    JOIN ${vtAdi('TBLDEPOENVANTER', true)} E ON E.HAREKETIND = H.IND
    WHERE H.ACIKLAMA = 'KASA'`);
  kontrol('Fatura kasasi uc Vega tablosunda gercek karta bagli',
    kasaBaglari.length === 1 &&
      [kasaBaglari[0].satirStok, kasaBaglari[0].hareketStok,
        kasaBaglari[0].envanterStok].every((n) => Number(n) === kasaVegaStokNo));
  kontrol('Fatura kasasinda varsayilan birim karttan alindi',
    kasaBaglari.length === 1 &&
      Number(kasaBaglari[0].satirBirim) === kasaVegaBirimEx &&
      Number(kasaBaglari[0].hareketBirim) === kasaVegaBirimEx);

  // Geçmişteki hatayı üç bağlı satırda üret, tarama → yedekli UPDATE →
  // geri alma → yeniden UPDATE zincirini gerçek VEGA_TEST satırında kanıtla.
  const kasaBag = kasaBaglari[0];
  await sql.islem(async (t) => {
    await t.calistir(`UPDATE ${vtAdi('TBLSATFATHAREKET', true)}
      SET STOKNO=1,BIRIMEX=1 WHERE IND=@id`, { id:kasaBag.satirInd });
    await t.calistir(`UPDATE ${vtAdi('TBLSTOKHAREKETLERI', true)}
      SET STOKNO=1,BIRIMEX=1 WHERE IND=@id`, { id:kasaBag.hareketInd });
    await t.calistir(`UPDATE ${vtAdi('TBLDEPOENVANTER', true)}
      SET STOKNO=1 WHERE IND=@id`, { id:kasaBag.envanterInd });
  });
  const bozukKasa = await kasaOnar.tara({ firma:FIRMA, fis:'SINAMA-A' });
  kontrol('Kasa kartı bakımı yanlış sistem kartını buldu',
    bozukKasa.duzeltmeler.length===1 && bozukKasa.duzeltmeler[0].eski.hStok===1);
  const onarim = await kasaOnar.uygula(bozukKasa);
  kontrol('Kasa kartı bakımı transaction ile düzeltti',
    onarim.adet===1 && (await kasaOnar.tara({firma:FIRMA,fis:'SINAMA-A'})).duzeltmeler.length===0);
  const geriAlmaYedegi = JSON.parse(fs.readFileSync(onarim.yedek,'utf8'));
  const geriAlinan = await kasaOnar.geriAl(geriAlmaYedegi);
  kontrol('Kasa kartı bakımının JSON yedeği geri aldı',
    geriAlinan===1 && (await kasaOnar.tara({firma:FIRMA,fis:'SINAMA-A'})).duzeltmeler.length===1);
  const tekrarOnarim = await kasaOnar.uygula(await kasaOnar.tara({firma:FIRMA,fis:'SINAMA-A'}));
  kontrol('Kasa kartı bakımı ikinci onarımda idempotent',
    tekrarOnarim.adet===1 && (await kasaOnar.tara({firma:FIRMA,fis:'SINAMA-A'})).duzeltmeler.length===0);
  fs.unlinkSync(onarim.yedek);
  fs.unlinkSync(tekrarOnarim.yedek);
  kontrol('Kasa icin ayri cikis dekontu YOK (fatura icine girdi)', sA.TBLCARCIKBASLIK === 0, String(sA.TBLCARCIKBASLIK));
  kontrol('Tahsilat basligi 1 satir (giris)', sA.TBLCARGIRBASLIK === 1, String(sA.TBLCARGIRBASLIK));
  const tahsilatAciklamaKaydi = await sql.sorgu(`
    SELECT B.ACIKLAMA AS baslikAciklama, H.ACIKLAMA AS satirAciklama
    FROM ${vtAdi('TBLCARGIRBASLIK', true)} B
    JOIN ${vtAdi('TBLCARGIRHAREKET', true)} H ON H.EVRAKNO = B.IND
    WHERE B.BELGENO = @belgeNo`, { belgeNo: yazmaA.tahsilatBelgeNo });
  kontrol('Tahsilat aciklamasi belge basligina yazildi',
    tahsilatAciklamaKaydi.length === 1 &&
      String(tahsilatAciklamaKaydi[0].baslikAciklama || '').trim() === TAHSILAT_ACIKLAMA,
    tahsilatAciklamaKaydi.length ? tahsilatAciklamaKaydi[0].baslikAciklama : 'bulunamadi');
  kontrol('Tahsilat hareket satiri aciklamasi bos birakildi',
    tahsilatAciklamaKaydi.length === 1 &&
      !String(tahsilatAciklamaKaydi[0].satirAciklama || '').trim(),
    tahsilatAciklamaKaydi.length ? `"${tahsilatAciklamaKaydi[0].satirAciklama || ''}"` : 'bulunamadi');
  kontrol('Cari hareketi 2 satir (fatura[+kasa birlesik] + tahsilat)', sA.TBLCARIHAREKETLERI === 2,
    String(sA.TBLCARIHAREKETLERI));
  kontrol('Cari genel hareketi de 2 satir (her cari harekete eslik ediyor)',
    sA.TBLCARIGENELHAREKET === 2, String(sA.TBLCARIGENELHAREKET));

  // TBLCARIGENELHAREKET: fatura(kasa dahil) BORC (belgelink NULL), tahsilat
  // ALACAK (belgelink -1) yazmali; izahat kodlari fatura=21, giris=13.
  const genelHareket = await sql.sorgu(`
    SELECT BELGEIZAHAT, ISLEMIZAHAT, BORC, ALACAK, BELGELINK
    FROM ${vtAdi('TBLCARIGENELHAREKET', true)} ORDER BY IND`);
  kontrol('Genel hareket izahat kodlari dogru (21, 13)',
    genelHareket.map((r) => Number(r.BELGEIZAHAT)).join(',') === '21,13',
    genelHareket.map((r) => r.BELGEIZAHAT).join(','));
  // ISLEMIZAHAT fatura/stok belgelerinde belge tipiyle AYNI, cari giris/cikis
  // belgelerinde ODEME ARACI kodudur (canli Vega kayitlariyla dogrulandi:
  // 13/1 = nakit tahsilat, 13/11 = kart-havale). Nakit tahsilat fisinde 1
  // bekliyoruz.
  kontrol('Fatura satirinda BELGEIZAHAT = ISLEMIZAHAT',
    genelHareket[0] && Number(genelHareket[0].BELGEIZAHAT) === Number(genelHareket[0].ISLEMIZAHAT),
    genelHareket[0] ? `${genelHareket[0].BELGEIZAHAT}/${genelHareket[0].ISLEMIZAHAT}` : '—');
  kontrol('Nakit tahsilat satirinda ISLEMIZAHAT = 1 (odeme araci)',
    genelHareket[1] && Number(genelHareket[1].ISLEMIZAHAT) === 1,
    genelHareket[1] ? `${genelHareket[1].BELGEIZAHAT}/${genelHareket[1].ISLEMIZAHAT}` : '—');
  kontrol('Tahsilat satiri BELGELINK=-1, fatura satiri NULL',
    genelHareket[1] && genelHareket[1].BELGELINK === -1 && genelHareket[0].BELGELINK === null,
    genelHareket.map((r) => r.BELGELINK).join(','));

  // Bağ alanları: fatura satırı başlığın IND'ine, stok hareketi hem başlığa
  // hem satıra bağlanmalı.
  const bag = await sql.sorgu(`
    SELECT
      (SELECT COUNT(*) FROM ${vtAdi('TBLSATFATHAREKET', true)} H
        JOIN ${vtAdi('TBLSATFATBASLIK', true)} B ON B.IND = H.EVRAKNO)          AS satirBasligaBagli,
      (SELECT COUNT(*) FROM ${vtAdi('TBLSTOKHAREKETLERI', true)} S
        JOIN ${vtAdi('TBLSATFATBASLIK', true)} B ON B.IND = S.BELGENO)          AS stokBasligaBagli,
      (SELECT COUNT(*) FROM ${vtAdi('TBLSTOKHAREKETLERI', true)} S
        JOIN ${vtAdi('TBLSATFATHAREKET', true)} H ON H.IND = S.LN)              AS stokSatiraBagli,
      (SELECT COUNT(*) FROM ${vtAdi('TBLDEPOENVANTER', true)} E
        JOIN ${vtAdi('TBLSATFATBASLIK', true)} B ON B.IND = E.BELGEIND)         AS envanterBasligaBagli,
      (SELECT COUNT(*) FROM ${vtAdi('TBLDEPOENVANTER', true)} E
        JOIN ${vtAdi('TBLSATFATHAREKET', true)} H ON H.IND = E.HAREKETIND)      AS envanterSatiraBagli,
      (SELECT COUNT(*) FROM ${vtAdi('TBLCARCIKHAREKET', true)} K
        JOIN ${vtAdi('TBLCARCIKBASLIK', true)} B ON B.IND = K.EVRAKNO)          AS dekontBasligaBagli
  `);
  const b = bag[0];
  kontrol('Fatura satiri basliga bagli', Number(b.satirBasligaBagli) === 3, String(b.satirBasligaBagli));
  kontrol('Stok hareketi basliga bagli (BELGENO = baslik IND)',
    Number(b.stokBasligaBagli) === 3, String(b.stokBasligaBagli));
  kontrol('Stok hareketi satira bagli (LN = satir IND)',
    Number(b.stokSatiraBagli) === 3, String(b.stokSatiraBagli));
  kontrol('Envanter basliga bagli', Number(b.envanterBasligaBagli) === 3,
    String(b.envanterBasligaBagli));
  kontrol('Envanter satira bagli', Number(b.envanterSatiraBagli) === 3,
    String(b.envanterSatiraBagli));
  kontrol('Kasa icin ayri dekont satiri yok', Number(b.dekontBasligaBagli) === 0,
    String(b.dekontBasligaBagli));

  // Envanter farkı satışta eksi olmalı (10,8 + 5 kg ürün + 1 kasa/adet) —
  // artı yazılsa stok satışta ARTAR.
  const env = await sql.sorgu(`SELECT SUM(ENVANTER) AS toplam FROM ${vtAdi('TBLDEPOENVANTER', true)}`);
  kontrol('Envanter farki eksi (satista stok duser)',
    Number(env[0].toplam) === -(10.8 + 5 + 1), String(env[0].toplam));

  const cikan = await sql.sorgu(`
    SELECT SUM(CIKAN) AS cikan, SUM(GIREN) AS giren FROM ${vtAdi('TBLSTOKHAREKETLERI', true)}`);
  kontrol('Stok hareketi cikis yonunde',
    Number(cikan[0].cikan) === 15.8 + 1 && Number(cikan[0].giren) === 0,
    `cikan ${cikan[0].cikan} · giren ${cikan[0].giren}`);

  const bakiyeA = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi urun + kasa - tahsilat kadar artti',
    Math.abs(bakiyeA - BEKLENEN_BORC) < 0.01, `${bakiyeA} (beklenen ${BEKLENEN_BORC})`);

  // Ekstrede artik kasa icin ayri satir yok — fatura+kasa tek satirda
  // birlesik (524 TL), tahsilat ayri.
  const ekstreA = await vega.cariEkstre({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Ekstrede iki ayri satir var (fatura[+kasa] + tahsilat)', ekstreA.satirlar.length === 2,
    `${ekstreA.satirlar.length} satir`);

  // Kasa artik fatura satirinda ("KASA" aciklamali) — TBLSATFATHAREKET'te.
  const faturaKasaSatiri = await sql.sorgu(
    `SELECT GERCEKTOPLAM FROM ${vtAdi('TBLSATFATHAREKET', true)} WHERE ACIKLAMA='KASA'`);
  kontrol('Fatura icinde "KASA" aciklamali satir var', faturaKasaSatiri.length === 1,
    faturaKasaSatiri.length ? `${faturaKasaSatiri.length} satir` : 'bulunamadi');
  if (faturaKasaSatiri.length) {
    kontrol('Kasa satirinin tutari 100 TL', Number(faturaKasaSatiri[0].GERCEKTOPLAM) === 100,
      String(faturaKasaSatiri[0].GERCEKTOPLAM));
  }

  // Elle yazilan satir aciklamasi yalniz uygulama rapor notudur; 03.09.2026
  // istegiyle gercek Vega fatura satirina aktarimi kaldirildi.
  const satirAciklamalari = await sql.sorgu(
    `SELECT ACIKLAMA FROM ${vtAdi('TBLSATFATHAREKET', true)} WHERE MIKTAR=10.8`);
  kontrol('Kullanici notu Vega fatura satirina yazilmiyor',
    satirAciklamalari.length === 1 &&
      !String(satirAciklamalari[0].ACIKLAMA || '').trim(),
    satirAciklamalari.length ? `"${satirAciklamalari[0].ACIKLAMA || ''}"` : 'bulunamadi');

  const raporNotlari = await sql.sorgu(
    `SELECT Aciklama FROM [${VEGA_TEST}].dbo.BD_BelgeSatir WHERE DaraliMiktar=10.8`);
  kontrol('Kullanici notu ayrintili rapor gunlugunde saklaniyor',
    raporNotlari.length === 1 &&
      String(raporNotlari[0].Aciklama || '').trim() === 'ELLE YAZILAN NOT',
    raporNotlari.length ? raporNotlari[0].Aciklama : 'bulunamadi');

  // Aciklama girilmemis satirda program bir sey uydurmamali.
  const bosAciklamali = await sql.sorgu(
    `SELECT ACIKLAMA FROM ${vtAdi('TBLSATFATHAREKET', true)} WHERE MIKTAR=5`);
  kontrol('Aciklama girilmeyen satir bos kaliyor (otomatik hesap yazilmiyor)',
    bosAciklamali.length === 1 && !String(bosAciklamali[0].ACIKLAMA || '').trim(),
    bosAciklamali.length ? `"${bosAciklamali[0].ACIKLAMA}"` : 'bulunamadi');

  const tahsilatSatiri = ekstreA.satirlar.find((s) => (s.aciklama || '').indexOf(TAHSILAT_ACIKLAMA) >= 0);
  kontrol('Tahsilat satiri ALACAK olarak gorunuyor', !!tahsilatSatiri && tahsilatSatiri.alacak === TAHSILAT,
    tahsilatSatiri ? `${tahsilatSatiri.aciklama} · ${tahsilatSatiri.alacak} TL` : 'bulunamadi');
  const buHafta = rapor.haftaAraligi(new Date());
  const ayrintiliEkstreA = await rapor.haftalikDetay({
    firma: FIRMA,
    donem: DONEM,
    cariInd: cari.cariInd,
    baslangic: buHafta.baslangic,
    bitis: buHafta.bitis
  });
  const ayrintiliTahsilat = ayrintiliEkstreA.odemeler.find((s) =>
    (s.aciklama || '').indexOf(TAHSILAT_ACIKLAMA) >= 0
  );
  kontrol('Tahsilat belge aciklamasi ayrintili Ekstre ODEME satirinda gorunuyor',
    !!ayrintiliTahsilat,
    ayrintiliTahsilat ? ayrintiliTahsilat.aciklama : 'bulunamadi');
  kontrol('Ekstre son bakiyesi cari bakiyesiyle ayni',
    Math.abs(ekstreA.sonBakiye - bakiyeA) < 0.01, `${ekstreA.sonBakiye}`);

  // Kasa defteri (BD_KasaHareket) — müşteride 1 kasa açık görünmeli.
  const acikKasa = await yardimci.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Kasa defterinde 1 kasa acik gorunuyor',
    acikKasa.length === 1 && Number(acikKasa[0].acikAdet) === 1,
    acikKasa.length ? `${acikKasa[0].kasaTipiKod} ${acikKasa[0].acikAdet} adet` : 'yok');

  // İşlem günlüğü — geri alma bilgisi burada durmalı.
  const gunlukA = await yardimci.sonIslemleriGetir({ firma: FIRMA, limit: 10 });
  kontrol('Islem gunluge yazildi', gunlukA.length > 0 && gunlukA[0].BelgeNo === yazmaA.belgeNo + ' / ' + yazmaA.tahsilatBelgeNo,
    gunlukA.length ? gunlukA[0].BelgeNo : '—');
  kontrol('Son Belgeler kayit anini degil belge tarihini gosteriyor',
    gunlukA.length > 0 && tarihAnahtari(gunlukA[0].Tarih) === tarihAnahtari(SATIS_TARIHI),
    gunlukA.length ? tarihAnahtari(gunlukA[0].Tarih) : 'bulunamadi');

  // Geçmiş bakım aracı: kayıt tarihini ve kasa defterini bilinçli bozup üç
  // kaynaktan tespit, güvenli düzeltme, geri alma ve yeniden düzeltmeyi kanıtla.
  await sql.calistir(`UPDATE [${VEGA_TEST}].dbo.BD_Islem
                      SET Tarih = DATEADD(day, 1, Tarih) WHERE Id = @id`, { id: yazmaA.islemId });
  await sql.calistir(`UPDATE [${VEGA_TEST}].dbo.BD_KasaHareket
                      SET Adet = Adet + 1, Tutar = Tutar + Depozito WHERE IslemId = @id`,
    { id: yazmaA.islemId });
  const bozukBakim = await gecmisBakim.tara({ firma: FIRMA, fis: 'SINAMA-A' });
  kontrol('Bakim araci tarih karisikligini buldu', bozukBakim.tarihDuzeltmeleri.length === 1,
    `${bozukBakim.tarihDuzeltmeleri.length} kayit`);
  kontrol('Bakim araci kasa defteri farkini iki kaynaktan kanitladi',
    bozukBakim.kasaDuzeltmeleri.length === 1, `${bozukBakim.kasaDuzeltmeleri.length} kayit`);
  await gecmisBakim.guvenliDuzelt(bozukBakim);
  const bakimSonrasi = await gecmisBakim.tara({ firma: FIRMA, fis: 'SINAMA-A' });
  kontrol('Bakim sonrasi kanitlanmis sorun kalmadi',
    bakimSonrasi.tarihDuzeltmeleri.length === 0 && bakimSonrasi.kasaDuzeltmeleri.length === 0,
    `${bakimSonrasi.sorunlar.length} sorun`);
  await gecmisBakim.geriAl({
    veritabani: bozukBakim.veritabani,
    tarihDuzeltmeleri: bozukBakim.tarihDuzeltmeleri,
    kasaDuzeltmeleri: bozukBakim.kasaDuzeltmeleri
  });
  const geriAlinanBakim = await gecmisBakim.tara({ firma: FIRMA, fis: 'SINAMA-A' });
  kontrol('Bakim geri alma eski durumu aynen getirdi',
    geriAlinanBakim.tarihDuzeltmeleri.length === 1 && geriAlinanBakim.kasaDuzeltmeleri.length === 1);
  await gecmisBakim.guvenliDuzelt(geriAlinanBakim);
  const ikinciBakim = await gecmisBakim.tara({ firma: FIRMA, fis: 'SINAMA-A' });
  kontrol('Bakim tekrar calistirilinca idempotent',
    ikinciBakim.tarihDuzeltmeleri.length === 0 && ikinciBakim.kasaDuzeltmeleri.length === 0);

  // Güncellemeyle gelen otomatik bakım aynı sürüm/veritabanı için yalnız bir
  // kez çalışmalı. Çıktı ve durum dosyaları yalnız sistemin geçici klasörüne gider.
  const otomatikDizin = fs.mkdtempSync(path.join(os.tmpdir(), 'belge-bakim-sinama-'));
  const otomatikDurum = path.join(otomatikDizin, 'durum.json');
  const otomatikIlk = await gecmisBakim.otomatikCalistir({
    surum: 'sinama-1.7.2', durumYolu: otomatikDurum, ciktiKlasoru: otomatikDizin
  });
  const otomatikIkinci = await gecmisBakim.otomatikCalistir({
    surum: 'sinama-1.7.2', durumYolu: otomatikDurum, ciktiKlasoru: otomatikDizin
  });
  kontrol('Guncelleme bakimi ilk acilista tamamlandi ve yedek aldi',
    !otomatikIlk.atlandi && fs.existsSync(otomatikIlk.yedekYolu),
    otomatikIlk.yedekYolu || 'yedek yok');
  kontrol('Guncelleme bakimi ayni surum ve veritabaninda ikinci kez yazmadi',
    otomatikIkinci.atlandi && otomatikIkinci.neden === 'daha-once-tamamlandi');

  // --- Son Belgeler > kalem ile düzenleme ---
  const detayA = await yardimci.islemDetayGetir({ islemId: yazmaA.islemId });
  kontrol('Belge duzenleme icin iki satirla acildi', detayA.satirlar.length === 2,
    `${detayA.satirlar.length} satir`);
  kontrol('Duzenleme tahsilat aciklamasini koruyor',
    detayA.tahsilatAciklama === TAHSILAT_ACIKLAMA, detayA.tahsilatAciklama);

  const duzeltilenSatirlar = ornekSatirlar();
  duzeltilenSatirlar[0].brutMiktar = 13.3;
  duzeltilenSatirlar[0].daraliMiktar = 11.8;
  duzeltilenSatirlar[0].tutar = 354;
  const yazmaD = await yazma.belgeYaz({
    firma: FIRMA, donem: DONEM, tarih: SATIS_TARIHI,
    cariInd: cari.cariInd, cariAd: cari.ad,
    belgeTuru: 'satisFaturasi', fisNo: 'SINAMA-A',
    satirlar: duzeltilenSatirlar,
    tahsilat: TAHSILAT,
    tahsilatAciklama: TAHSILAT_ACIKLAMA,
    duzenlenenIslemId: yazmaA.islemId
  });
  kontrol('Belge tek transaction ile duzenlendi', yazmaD.duzenlendi, yazmaD.belgeNo);
  const duzeltilenFatura = await sql.sorgu(
    `SELECT MIKTAR, GERCEKTOPLAM FROM ${vtAdi('TBLSATFATHAREKET', true)} WHERE MIKTAR=11.8`);
  kontrol('Duzeltilen kilo ve tutar Vegaya yansidi',
    duzeltilenFatura.length === 1 && Number(duzeltilenFatura[0].GERCEKTOPLAM) === 354,
    duzeltilenFatura.length ? `${duzeltilenFatura[0].MIKTAR} kg / ${duzeltilenFatura[0].GERCEKTOPLAM} TL` : 'bulunamadi');
  const duzenlemeGunlugu = await sql.sorgu(`
    SELECT
      (SELECT COUNT(*) FROM [${VEGA_TEST}].dbo.BD_Islem) AS islem,
      (SELECT COUNT(*) FROM [${VEGA_TEST}].dbo.BD_BelgeSatir) AS satir,
      (SELECT COUNT(*) FROM [${VEGA_TEST}].dbo.BD_KasaHareket) AS kasa`);
  kontrol('Duzenleme eski yardimci kayitlari cogaltmadi',
    Number(duzenlemeGunlugu[0].islem) === 1 &&
      Number(duzenlemeGunlugu[0].satir) === 2 && Number(duzenlemeGunlugu[0].kasa) === 1,
    JSON.stringify(duzenlemeGunlugu[0]));
  const duzenlemeSonBelgeler = await yardimci.sonIslemleriGetir({ firma: FIRMA, limit: 10 });
  kontrol('Duzenlenen belge Son Belgelerde secilen tarihi koruyor',
    duzenlemeSonBelgeler.length > 0 &&
      tarihAnahtari(duzenlemeSonBelgeler[0].Tarih) === tarihAnahtari(SATIS_TARIHI),
    duzenlemeSonBelgeler.length ? tarihAnahtari(duzenlemeSonBelgeler[0].Tarih) : 'bulunamadi');
  const duzenlemeBakiyesi = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Duzeltilen kilo cari bakiyesini bir kez degistirdi',
    Math.abs(duzenlemeBakiyesi - 354) < 0.01, String(duzenlemeBakiyesi));

  // --- Geri alma ---
  const geriA = await yazma.belgeGeriAl({ islemId: yazmaD.islemId });
  kontrol('Geri alindi', geriA.tamam, `${geriA.silinenSatir} satir silindi`);

  const sonrasiA = await tumSayilar();
  kontrol('Geri almadan sonra hicbir iz kalmadi', toplamSatir(sonrasiA) === 0,
    JSON.stringify(sonrasiA));

  const bakiyeSifir = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi eski haline dondu', Math.abs(bakiyeSifir) < 0.01, String(bakiyeSifir));

  const acikKasaSifir = await yardimci.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Kasa defteri de geri alindi', acikKasaSifir.length === 0, `${acikKasaSifir.length} kayit kaldi`);

  const yardimciSifir = await sql.sorgu(`
    SELECT
      (SELECT COUNT(*) FROM [${VEGA_TEST}].dbo.BD_Islem) AS islem,
      (SELECT COUNT(*) FROM [${VEGA_TEST}].dbo.BD_BelgeSatir) AS satir,
      (SELECT COUNT(*) FROM [${VEGA_TEST}].dbo.BD_KasaHareket) AS kasa`);
  kontrol('Geri alma yardimci kayitlari da tamamen sildi',
    Number(yardimciSifir[0].islem) === 0 && Number(yardimciSifir[0].satir) === 0 &&
      Number(yardimciSifir[0].kasa) === 0,
    JSON.stringify(yardimciSifir[0]));

  // Aynı işlem iki kez geri alınamamalı.
  let ciftGeriAlmaReddedildi = false;
  try {
    await yazma.belgeGeriAl({ islemId: yazmaD.islemId });
  } catch (e) {
    ciftGeriAlmaReddedildi = true;
  }
  kontrol('Ayni islem ikinci kez geri alinamiyor', ciftGeriAlmaReddedildi);

  // ======================================================================
  bolum('B — Cari giris olarak yazma (faturasiz)');

  await hareketleriTemizle();
  await yardimciTablolariTemizle();

  const yazmaB = await yazma.belgeYaz({
    firma: FIRMA, donem: DONEM, tarih: new Date(),
    cariInd: cari.cariInd, cariAd: cari.ad,
    belgeTuru: 'cariCikis', fisNo: 'SINAMA-B',
    satirlar: ornekSatirlar()
  });
  kontrol('Vegaya yazildi', yazmaB.tamam, yazmaB.belgeNo);

  const sB = await tumSayilar();
  kontrol('Satis faturasi olusmadi', sB.TBLSATFATBASLIK === 0, String(sB.TBLSATFATBASLIK));
  kontrol('Stok hareketi olusmadi (cari cikista stok etkilenmez)',
    sB.TBLSTOKHAREKETLERI === 0, String(sB.TBLSTOKHAREKETLERI));
  kontrol('Depo envanteri etkilenmedi', sB.TBLDEPOENVANTER === 0, String(sB.TBLDEPOENVANTER));
  // Urun VE kasa artik TEK Cari Giris belgesinde birlesik — "bize para
  // girer, mal/kasa cikar" (kullanicinin tarifi, 24.08.2026). Cari CIKIS
  // hic olusmaz.
  kontrol('Cari cikis basligi olusmadi (hepsi girise tasindi)', sB.TBLCARCIKBASLIK === 0, String(sB.TBLCARCIKBASLIK));
  kontrol('Tek cari giris basligi (urun + kasa birlesik)', sB.TBLCARGIRBASLIK === 1, String(sB.TBLCARGIRBASLIK));
  kontrol('Giris hareketinde 2 kalem (urun + kasa)', sB.TBLCARGIRHAREKET === 2, String(sB.TBLCARGIRHAREKET));
  kontrol('Cari hareketi 1 satir (tek belge, tek borc)', sB.TBLCARIHAREKETLERI === 1, String(sB.TBLCARIHAREKETLERI));

  // Ödeme aracı alanları boş kalmalı: nakit işaretlenirse Vega kasa raporunda
  // karşılığı olmayan para görünür.
  const arac = await sql.sorgu(`
    SELECT
      (SELECT COUNT(*) FROM ${vtAdi('TBLCARCIKHAREKET', true)}
        WHERE ISNULL(IZAHAT, 0) <> 0 OR ISNULL(PORTNO, 0) <> 0) +
      (SELECT COUNT(*) FROM ${vtAdi('TBLCARGIRHAREKET', true)}
        WHERE ISNULL(IZAHAT, 0) <> 0 OR ISNULL(PORTNO, 0) <> 0) AS adet`);
  kontrol('Odeme araci alanlari bos (kasaya postalanmiyor)',
    Number(arac[0].adet) === 0, `${arac[0].adet} satirda dolu`);

  // ŞUBE / KASA — Vega'nin ekraninda bos olamaz. Bos birakilinca kullanici
  // belgeyi acip elle dolduruyor, kaydedince Vega cariye IKINCI bir hareket
  // yaziyor ("mukerrer belge", 05.09.2026). Basligin OZELKOD1/OZELKOD2'si.
  const subeKasa = await sql.sorgu(`
    SELECT ISNULL(OZELKOD1, '') AS sube, ISNULL(OZELKOD2, '') AS kasa,
           ISNULL(UID, '') AS uid
    FROM ${vtAdi('TBLCARGIRBASLIK', true)}`);
  kontrol('Cari giris basliginda sube ve kasa dolu',
    subeKasa.every((r) => String(r.sube).trim() && String(r.kasa).trim()),
    subeKasa.map((r) => `${r.sube}/${r.kasa}`).join(' · ') || '—');
  kontrol('Cari giris basliginda UID uretildi',
    subeKasa.every((r) => /^\{.+\}$/.test(String(r.uid).trim())),
    subeKasa.map((r) => r.uid).join(' · ') || '—');

  // Hareket satiri Vega'nin kendi kestigi satirlarla ayni kalipta olmali:
  // BELGENO satirda BOS, BELGELINK = -1, STATUS = 0, VADE dolu.
  const girisSatiri = await sql.sorgu(`
    SELECT ISNULL(BELGENO, '') AS belgeNo, BELGELINK, STATUS, VADE
    FROM ${vtAdi('TBLCARGIRHAREKET', true)}`);
  kontrol('Giris satiri Vega kalibinda (BELGENO bos, BELGELINK=-1, STATUS=0, VADE dolu)',
    girisSatiri.every((r) => String(r.belgeNo).trim() === '' && Number(r.BELGELINK) === -1 &&
      Number(r.STATUS) === 0 && !!r.VADE),
    girisSatiri.map((r) => `"${r.belgeNo}"/${r.BELGELINK}/${r.STATUS}`).join(' · ') || '—');

  const bakiyeB = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi urun + kasa kadar artti',
    Math.abs(bakiyeB - (URUN_TOPLAM + KASA_TOPLAM)) < 0.01, `${bakiyeB}`);

  await yazma.belgeGeriAl({ islemId: yazmaB.islemId });
  const sonrasiB = await tumSayilar();
  kontrol('Geri almadan sonra hicbir iz kalmadi', toplamSatir(sonrasiB) === 0,
    JSON.stringify(sonrasiB));

  // ======================================================================
  bolum('C — Kasa iadesi');

  await hareketleriTemizle();
  await yardimciTablolariTemizle();

  // İade edilebilmesi için önce kasanın verilmiş olması gerekiyor.
  const belgeC = await yazma.belgeYaz({
    firma: FIRMA, donem: DONEM, tarih: new Date(),
    cariInd: cari.cariInd, cariAd: cari.ad,
    belgeTuru: 'cariCikis', fisNo: 'SINAMA-C',
    satirlar: [{
      stokNo: stoklar[0].stokNo, stokKodu: stoklar[0].kod, stokAdi: stoklar[0].ad,
      birim: stoklar[0].birim, birimEx: stoklar[0].birimEx,
      daraliMiktar: 10, fiyat: 10, tutar: 100,
      kasaAdedi: 9, kasaStokNo: kasa.id, kasaTipiKod: kasa.kod,
      kasaDepozito: 500, kasaTutari: 4500
    }]
  });
  kontrol('Belge yazildi', belgeC.tamam, belgeC.belgeNo);

  const acik = await yardimci.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Musteride 9 kasa ve 4500 TL acik gorunuyor',
    acik.length === 1 && Number(acik[0].acikAdet) === 9 && Number(acik[0].acikTutar) === 4500,
    acik.length ? `${acik[0].kasaTipiKod} ${acik[0].acikAdet} adet · ${acik[0].acikTutar} TL` : 'yok');

  // Elde olandan fazlası iade alınamamalı.
  let fazlaIadeReddedildi = false;
  try {
    await yazma.kasaIadesiYaz({
      firma: FIRMA, donem: DONEM, cariInd: cari.cariInd, cariAd: cari.ad,
      stokNo: kasa.id, stokKodu: kasa.kod, depozito: 300, adet: 10
    });
  } catch (e) {
    fazlaIadeReddedildi = true;
  }
  kontrol('Acik adetten fazla iade reddedildi', fazlaIadeReddedildi);

  const bakiyeOnce = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });

  // Kasa kartının bugünkü bedeli 300 TL kabul edilse bile müşteri bu 9 kasayı
  // 500 TL'den aldı. Tümünü getirince 9 × 500 = 4500 TL tamamen kapanmalı.
  const iade = await yazma.kasaIadesiYaz({
    firma: FIRMA, donem: DONEM, cariInd: cari.cariInd, cariAd: cari.ad,
    stokNo: kasa.id, stokKodu: kasa.kod, depozito: 300, adet: 9
  });
  kontrol('Iade Vegaya yazildi', iade.tamam, `${iade.adet} adet · ${iade.tutar} TL · ${iade.belgeNo}`);
  kontrol('9 kasa iadesi eski 4500 TL borcu tamamen kapatti',
    iade.kalanAdet === 0 && iade.kalanTutar === 0 && iade.tutar === 4500,
    `${iade.kalanAdet} adet / ${iade.kalanTutar} TL`);

  const sC = await tumSayilar();
  // sC.TBLCARGIRBASLIK: belgeC'nin urun+kasa'si TEK belgede birlesik (Cari
  // Giris, borc). Iade artik Cari Cikis DEGIL — Stok Giris Iade Fisi
  // (TBLSTKGIRBASLIK, 24.08.2026'da degisti): TBLCARCIKBASLIK'ta Sube/Kasa/
  // Depo sutunu hic yok, Vega'nin kendi ekraninda belge bu yuzden kapanmiyordu.
  kontrol('Tek cari giris basligi (belgeC: urun + kasa birlesik)', sC.TBLCARGIRBASLIK === 1, String(sC.TBLCARGIRBASLIK));
  kontrol('Cari cikis basligi olusmadi (iade artik Stok Giris Iade Fisi)', sC.TBLCARCIKBASLIK === 0, String(sC.TBLCARCIKBASLIK));
  kontrol('Bir stok giris iade fisi basligi (iade)', sC.TBLSTKGIRBASLIK === 1, String(sC.TBLSTKGIRBASLIK));
  kontrol('Stok giris iade fisinde 1 satir', sC.TBLSTKGIRHAREKET === 1, String(sC.TBLSTKGIRHAREKET));

  const stkGirSatir = await sql.sorgu(`SELECT TOP 1 * FROM ${vtAdi('TBLSTKGIRHAREKET', true)}`);
  kontrol('Stok giris satirinda miktar/fiyat dogru',
    stkGirSatir.length === 1 && Number(stkGirSatir[0].MIKTAR) === 9 && Number(stkGirSatir[0].FIYATI) === 500,
    stkGirSatir.length ? `${stkGirSatir[0].MIKTAR} adet × ${stkGirSatir[0].FIYATI} TL` : 'yok');
  const iadeMaliyet = await sql.sorgu(`SELECT TOP 1 H.AFIYATI, S.BIRIMMALIYET
    FROM ${vtAdi('TBLSTKGIRHAREKET', true)} H
    JOIN ${vtAdi('TBLSTOKHAREKETLERI', true)} S ON S.LN=H.IND AND S.IZAHAT=34`);
  kontrol('Iade maliyet alanlari eski deseninde kaldi',
    iadeMaliyet.length===1 && Number(iadeMaliyet[0].AFIYATI)===1 &&
      Number(iadeMaliyet[0].BIRIMMALIYET)===500);
  const iadeBaglari = await sql.sorgu(`
    SELECT H.IND AS satirInd, H.STOKNO AS satirStok, H.BIRIMEX AS satirBirim,
           S.IND AS hareketInd, S.STOKNO AS hareketStok, S.BIRIMEX AS hareketBirim,
           E.IND AS envanterInd, E.STOKNO AS envanterStok
    FROM ${vtAdi('TBLSTKGIRHAREKET', true)} H
    JOIN ${vtAdi('TBLSTOKHAREKETLERI', true)} S ON S.LN = H.IND
    JOIN ${vtAdi('TBLDEPOENVANTER', true)} E ON E.HAREKETIND = H.IND`);
  kontrol('Iade kasasi uc Vega tablosunda gercek karta bagli',
    iadeBaglari.length === 1 &&
      [iadeBaglari[0].satirStok, iadeBaglari[0].hareketStok,
        iadeBaglari[0].envanterStok].every((n) => Number(n) === kasaVegaStokNo));
  kontrol('Iade varsayilan birimi stok numarasindan ayri',
    iadeBaglari.length === 1 &&
      Number(iadeBaglari[0].satirBirim) === kasaVegaBirimEx &&
      Number(iadeBaglari[0].hareketBirim) === kasaVegaBirimEx);
  const iadeBag = iadeBaglari[0];
  await sql.islem(async (t) => {
    await t.calistir(`UPDATE ${vtAdi('TBLSTKGIRHAREKET', true)}
      SET STOKNO=1,BIRIMEX=1 WHERE IND=@id`, { id:iadeBag.satirInd });
    await t.calistir(`UPDATE ${vtAdi('TBLSTOKHAREKETLERI', true)}
      SET STOKNO=1,BIRIMEX=1 WHERE IND=@id`, { id:iadeBag.hareketInd });
    await t.calistir(`UPDATE ${vtAdi('TBLDEPOENVANTER', true)}
      SET STOKNO=1 WHERE IND=@id`, { id:iadeBag.envanterInd });
  });
  const bozukIade = await kasaOnar.tara({ firma:FIRMA });
  kontrol('Bakım aracı kasa iadesi hatasını da buldu',
    bozukIade.duzeltmeler.length===1 && bozukIade.duzeltmeler[0].tur==='kasaIade');
  const onarilanIade = await kasaOnar.uygula(bozukIade);
  kontrol('Bakım aracı kasa iadesini yerinde onardı',
    onarilanIade.adet===1 && (await kasaOnar.tara({firma:FIRMA})).duzeltmeler.length===0);
  fs.unlinkSync(onarilanIade.yedek);

  const stokHarIade = await sql.sorgu(`
    SELECT SUM(ISNULL(GIREN,0)) AS giren, SUM(ISNULL(CIKAN,0)) AS cikan
    FROM ${vtAdi('TBLSTOKHAREKETLERI', true)} WHERE IZAHAT = '34'`);
  kontrol('Stok hareketi GIREN yoninde (kasa fiziksel stoga geri girdi)',
    Number(stokHarIade[0].giren) === 9 && Number(stokHarIade[0].cikan) === 0,
    `giren ${stokHarIade[0].giren} · cikan ${stokHarIade[0].cikan}`);

  const envanterIade = await sql.sorgu(`
    SELECT SUM(ENVANTER) AS envanter FROM ${vtAdi('TBLDEPOENVANTER', true)} WHERE BELGETIPI = 34`);
  kontrol('Envanter farki arti (iade ile stok geri girer)', Number(envanterIade[0].envanter) === 9,
    String(envanterIade[0].envanter));

  const alacak = await sql.sorgu(`
    SELECT SUM(ISNULL(ALACAK,0)) AS alacak FROM ${vtAdi('TBLCARIHAREKETLERI', true)}
    WHERE IZAHAT = '34'`);
  kontrol('Iade ALACAK olarak eski depozito tutariyla yazildi', Number(alacak[0].alacak) === 4500,
    String(alacak[0].alacak));

  const bakiyeSonra = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi iade kadar dustu',
    Math.abs((bakiyeOnce - bakiyeSonra) - 4500) < 0.01,
    `${bakiyeOnce} → ${bakiyeSonra}`);

  const acikIadeSonrasi = await yardimci.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Kasa defterinde adet ve tutar sifirlandi', acikIadeSonrasi.length === 0,
    acikIadeSonrasi.length ? `${acikIadeSonrasi[0].acikAdet} adet` : 'yok');

  await yazma.belgeGeriAl({ islemId: iade.islemId });
  const bakiyeGeri = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Iade geri alindi, bakiye eski haline dondu',
    Math.abs(bakiyeGeri - bakiyeOnce) < 0.01, String(bakiyeGeri));

  // ======================================================================
  bolum('Temizlik');
  await hareketleriTemizle();
  await yardimciTablolariTemizle();
  await sinamaKasalariniTemizle();
  const son = await tumSayilar();
  kontrol('Sinama veritabani temizlendi', toplamSatir(son) === 0);

  return ozet();
}

function ozet() {
  console.log(`\n────────────────────────────────`);
  console.log(`Gecen: ${gecen}   Kalan: ${kalan}`);
  return kalan === 0;
}

calistir()
  .then(async (tamam) => {
    await sql.havuzKapat();
    process.exit(tamam ? 0 : 1);
  })
  .catch(async (e) => {
    console.error('\nSinama hata verdi: ' + (e && e.message ? e.message : e));
    if (e && e.stack) console.error(e.stack);
    try { await hareketleriTemizle(); await yardimciTablolariTemizle();
      await sinamaKasalariniTemizle(); } catch (x) { /* ilk hatayı koru */ }
    try { await sql.havuzKapat(); } catch (x) { /* yoksay */ }
    process.exit(1);
  });
