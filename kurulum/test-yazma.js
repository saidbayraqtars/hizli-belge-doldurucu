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
const yardimci = require('../db/yardimci');
const yazma = require('../db/yazma');

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

const FIRMA = 'F0102';
const DONEM = 'D0001';

function vtAdi(ad, donemli) {
  return `[${VEGA_TEST}].dbo.${FIRMA}${donemli ? DONEM : ''}${ad}`;
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
  // BD_BelgeSatir geri alma sırasında silinmez, yalnız işaretlenir. Her
  // sınama temiz bir rapor günlüğüyle başlasın diye test veritabanında bunu
  // da fiziksel olarak temizliyoruz.
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

  // Kasa tipi — Vega'da karsiligi yok, dogrudan BD_KasaTipi'de olusturuluyor.
  // Sinama tekrar calistirilirsa (VEGA_TEST yeniden kurulmadan) ayni kod
  // zaten var olabilir — varsa onu kullan, yoksa olustur (UNIQUE Kod).
  const mevcutTipler = await yardimci.kasaTipleriGetir();
  let kasa = mevcutTipler.find((k) => k.kod === 'SINAMA-KASA');
  if (!kasa) {
    const kasaKayit = await yardimci.kasaTipiKaydet({ kod: 'SINAMA-KASA', ad: 'Sinama Kasa', dara: 1.5, depozito: 100 });
    kasa = { id: kasaKayit.id, kod: 'SINAMA-KASA', ad: 'Sinama Kasa', dara: 1.5, depozito: 100 };
  }
  kontrol('Kasa tipi hazir', !!kasa.id, `${kasa.kod} (Id ${kasa.id})`);

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
        daraliMiktar: 5, fiyat: 20, tutar: 100,
        kasaAdedi: 0, kasaStokNo: null, kasaTipiKod: null,
        kasaDepozito: 0, kasaTutari: 0
      }
    ];
  }

  const URUN_TOPLAM = 424;   // 324 + 100
  const KASA_TOPLAM = 100;
  const TAHSILAT = 200;
  const BEKLENEN_BORC = URUN_TOPLAM + KASA_TOPLAM - TAHSILAT;

  // ======================================================================
  bolum('A — Satis faturasi olarak yazma (+ tahsilat)');

  const yazmaA = await yazma.belgeYaz({
    firma: FIRMA, donem: DONEM, tarih: new Date(),
    cariInd: cari.cariInd, cariAd: cari.ad,
    belgeTuru: 'satisFaturasi', fisNo: 'SINAMA-A',
    satirlar: ornekSatirlar(),
    tahsilat: TAHSILAT
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
  kontrol('Kasa icin ayri cikis dekontu YOK (fatura icine girdi)', sA.TBLCARCIKBASLIK === 0, String(sA.TBLCARCIKBASLIK));
  kontrol('Tahsilat basligi 1 satir (giris)', sA.TBLCARGIRBASLIK === 1, String(sA.TBLCARGIRBASLIK));
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
  kontrol('Genel hareket BELGEIZAHAT = ISLEMIZAHAT her satirda',
    genelHareket.every((r) => Number(r.BELGEIZAHAT) === Number(r.ISLEMIZAHAT)));
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

  const tahsilatSatiri = ekstreA.satirlar.find((s) => (s.aciklama || '').indexOf('Tahsilat') >= 0);
  kontrol('Tahsilat satiri ALACAK olarak gorunuyor', !!tahsilatSatiri && tahsilatSatiri.alacak === TAHSILAT,
    tahsilatSatiri ? `${tahsilatSatiri.aciklama} · ${tahsilatSatiri.alacak} TL` : 'bulunamadi');
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

  // --- Geri alma ---
  const geriA = await yazma.belgeGeriAl({ islemId: yazmaA.islemId });
  kontrol('Geri alindi', geriA.tamam, `${geriA.silinenSatir} satir silindi`);

  const sonrasiA = await tumSayilar();
  kontrol('Geri almadan sonra hicbir iz kalmadi', toplamSatir(sonrasiA) === 0,
    JSON.stringify(sonrasiA));

  const bakiyeSifir = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi eski haline dondu', Math.abs(bakiyeSifir) < 0.01, String(bakiyeSifir));

  const acikKasaSifir = await yardimci.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Kasa defteri de geri alindi', acikKasaSifir.length === 0, `${acikKasaSifir.length} kayit kaldi`);

  // Aynı işlem iki kez geri alınamamalı.
  let ciftGeriAlmaReddedildi = false;
  try {
    await yazma.belgeGeriAl({ islemId: yazmaA.islemId });
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
      kasaAdedi: 3, kasaStokNo: kasa.id, kasaTipiKod: kasa.kod,
      kasaDepozito: 100, kasaTutari: 300
    }]
  });
  kontrol('Belge yazildi', belgeC.tamam, belgeC.belgeNo);

  const acik = await yardimci.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Musteride 3 kasa acik gorunuyor',
    acik.length === 1 && Number(acik[0].acikAdet) === 3,
    acik.length ? `${acik[0].kasaTipiKod} ${acik[0].acikAdet} adet · ${acik[0].acikTutar} TL` : 'yok');

  // Elde olandan fazlası iade alınamamalı.
  let fazlaIadeReddedildi = false;
  try {
    await yazma.kasaIadesiYaz({
      firma: FIRMA, donem: DONEM, cariInd: cari.cariInd, cariAd: cari.ad,
      stokNo: kasa.id, stokKodu: kasa.kod, depozito: 100, adet: 5
    });
  } catch (e) {
    fazlaIadeReddedildi = true;
  }
  kontrol('Acik adetten fazla iade reddedildi', fazlaIadeReddedildi);

  const bakiyeOnce = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });

  const iade = await yazma.kasaIadesiYaz({
    firma: FIRMA, donem: DONEM, cariInd: cari.cariInd, cariAd: cari.ad,
    stokNo: kasa.id, stokKodu: kasa.kod, depozito: 100, adet: 2
  });
  kontrol('Iade Vegaya yazildi', iade.tamam, `${iade.adet} adet · ${iade.tutar} TL · ${iade.belgeNo}`);
  kontrol('Kalan acik adet 1', iade.kalanAdet === 1, String(iade.kalanAdet));

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
    stkGirSatir.length === 1 && Number(stkGirSatir[0].MIKTAR) === 2 && Number(stkGirSatir[0].FIYATI) === 100,
    stkGirSatir.length ? `${stkGirSatir[0].MIKTAR} adet × ${stkGirSatir[0].FIYATI} TL` : 'yok');

  const stokHarIade = await sql.sorgu(`
    SELECT SUM(ISNULL(GIREN,0)) AS giren, SUM(ISNULL(CIKAN,0)) AS cikan
    FROM ${vtAdi('TBLSTOKHAREKETLERI', true)} WHERE IZAHAT = '34'`);
  kontrol('Stok hareketi GIREN yoninde (kasa fiziksel stoga geri girdi)',
    Number(stokHarIade[0].giren) === 2 && Number(stokHarIade[0].cikan) === 0,
    `giren ${stokHarIade[0].giren} · cikan ${stokHarIade[0].cikan}`);

  const envanterIade = await sql.sorgu(`
    SELECT SUM(ENVANTER) AS envanter FROM ${vtAdi('TBLDEPOENVANTER', true)} WHERE BELGETIPI = 34`);
  kontrol('Envanter farki arti (iade ile stok geri girer)', Number(envanterIade[0].envanter) === 2,
    String(envanterIade[0].envanter));

  const alacak = await sql.sorgu(`
    SELECT SUM(ISNULL(ALACAK,0)) AS alacak FROM ${vtAdi('TBLCARIHAREKETLERI', true)}
    WHERE IZAHAT = '34'`);
  kontrol('Iade ALACAK olarak yazildi', Number(alacak[0].alacak) === 200,
    String(alacak[0].alacak));

  const bakiyeSonra = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi iade kadar dustu',
    Math.abs((bakiyeOnce - bakiyeSonra) - 200) < 0.01,
    `${bakiyeOnce} → ${bakiyeSonra}`);

  const acikIadeSonrasi = await yardimci.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Kasa defterinde 1 kasa kaldi', acikIadeSonrasi.length === 1 && acikIadeSonrasi[0].acikAdet === 1,
    acikIadeSonrasi.length ? `${acikIadeSonrasi[0].acikAdet} adet` : 'yok');

  await yazma.belgeGeriAl({ islemId: iade.islemId });
  const bakiyeGeri = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Iade geri alindi, bakiye eski haline dondu',
    Math.abs(bakiyeGeri - bakiyeOnce) < 0.01, String(bakiyeGeri));

  // ======================================================================
  bolum('Temizlik');
  await hareketleriTemizle();
  await yardimciTablolariTemizle();
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
    try { await sql.havuzKapat(); } catch (x) { /* yoksay */ }
    process.exit(1);
  });
