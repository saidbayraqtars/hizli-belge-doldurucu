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
  'TBLSTOKHAREKETLERI', 'TBLDEPOENVANTER'
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
  for (const t of ['BD_KasaHareket', 'BD_Islem']) {
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

  // Örnek: 10,8 kg × 30 TL = 324,00 TL ürün + 1 kasa × 100 TL depozito.
  function ornekSatirlar() {
    return [
      {
        stokNo: stoklar[0].stokNo, stokKodu: stoklar[0].kod, stokAdi: stoklar[0].ad,
        birim: stoklar[0].birim, birimEx: stoklar[0].birimEx,
        daraliMiktar: 10.8, fiyat: 30, tutar: 324,
        kasaAdedi: 1, kasaStokNo: kasa.id, kasaTipiKod: kasa.kod,
        kasaDepozito: 100, kasaTutari: 100
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
  kontrol('Kasa dekontu ayri belge no aldi',
    !!yazmaA.kasaBelgeNo && yazmaA.kasaBelgeNo !== yazmaA.belgeNo, yazmaA.kasaBelgeNo);
  kontrol('Tahsilat ayri belge no aldi',
    !!yazmaA.tahsilatBelgeNo && yazmaA.tahsilatBelgeNo !== yazmaA.belgeNo, yazmaA.tahsilatBelgeNo);

  const sA = await tumSayilar();
  kontrol('Satis faturasi basligi 1 satir', sA.TBLSATFATBASLIK === 1, String(sA.TBLSATFATBASLIK));
  kontrol('Fatura satirlari 2 satir', sA.TBLSATFATHAREKET === 2, String(sA.TBLSATFATHAREKET));
  kontrol('Stok hareketi 2 satir', sA.TBLSTOKHAREKETLERI === 2, String(sA.TBLSTOKHAREKETLERI));
  kontrol('Depo envanteri 2 satir', sA.TBLDEPOENVANTER === 2, String(sA.TBLDEPOENVANTER));
  kontrol('Kasa dekontu basligi 1 satir (cikis)', sA.TBLCARCIKBASLIK === 1, String(sA.TBLCARCIKBASLIK));
  kontrol('Tahsilat basligi 1 satir (giris)', sA.TBLCARGIRBASLIK === 1, String(sA.TBLCARGIRBASLIK));
  kontrol('Cari hareketi 3 satir (fatura + kasa + tahsilat)', sA.TBLCARIHAREKETLERI === 3,
    String(sA.TBLCARIHAREKETLERI));
  kontrol('Cari genel hareketi de 3 satir (her cari harekete eslik ediyor)',
    sA.TBLCARIGENELHAREKET === 3, String(sA.TBLCARIGENELHAREKET));

  // TBLCARIGENELHAREKET: satis/kasa BORC (belgelink NULL), tahsilat ALACAK
  // (belgelink -1) yazmali; izahat kodlari fatura=21, cikis=11, giris=13.
  const genelHareket = await sql.sorgu(`
    SELECT BELGEIZAHAT, ISLEMIZAHAT, BORC, ALACAK, BELGELINK
    FROM ${vtAdi('TBLCARIGENELHAREKET', true)} ORDER BY IND`);
  kontrol('Genel hareket izahat kodlari dogru (21, 11, 13)',
    genelHareket.map((r) => Number(r.BELGEIZAHAT)).join(',') === '21,11,13',
    genelHareket.map((r) => r.BELGEIZAHAT).join(','));
  kontrol('Genel hareket BELGEIZAHAT = ISLEMIZAHAT her satirda',
    genelHareket.every((r) => Number(r.BELGEIZAHAT) === Number(r.ISLEMIZAHAT)));
  kontrol('Tahsilat satiri BELGELINK=-1, digerleri NULL',
    genelHareket[2].BELGELINK === -1 && genelHareket[0].BELGELINK === null && genelHareket[1].BELGELINK === null,
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
  kontrol('Fatura satiri basliga bagli', Number(b.satirBasligaBagli) === 2, String(b.satirBasligaBagli));
  kontrol('Stok hareketi basliga bagli (BELGENO = baslik IND)',
    Number(b.stokBasligaBagli) === 2, String(b.stokBasligaBagli));
  kontrol('Stok hareketi satira bagli (LN = satir IND)',
    Number(b.stokSatiraBagli) === 2, String(b.stokSatiraBagli));
  kontrol('Envanter basliga bagli', Number(b.envanterBasligaBagli) === 2,
    String(b.envanterBasligaBagli));
  kontrol('Envanter satira bagli', Number(b.envanterSatiraBagli) === 2,
    String(b.envanterSatiraBagli));
  kontrol('Kasa dekontu satiri basliga bagli', Number(b.dekontBasligaBagli) === 1,
    String(b.dekontBasligaBagli));

  // Envanter farkı satışta eksi olmalı — artı yazılsa stok satışta ARTAR.
  const env = await sql.sorgu(`SELECT SUM(ENVANTER) AS toplam FROM ${vtAdi('TBLDEPOENVANTER', true)}`);
  kontrol('Envanter farki eksi (satista stok duser)',
    Number(env[0].toplam) === -(10.8 + 5), String(env[0].toplam));

  const cikan = await sql.sorgu(`
    SELECT SUM(CIKAN) AS cikan, SUM(GIREN) AS giren FROM ${vtAdi('TBLSTOKHAREKETLERI', true)}`);
  kontrol('Stok hareketi cikis yonunde',
    Number(cikan[0].cikan) === 15.8 && Number(cikan[0].giren) === 0,
    `cikan ${cikan[0].cikan} · giren ${cikan[0].giren}`);

  const bakiyeA = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi urun + kasa - tahsilat kadar artti',
    Math.abs(bakiyeA - BEKLENEN_BORC) < 0.01, `${bakiyeA} (beklenen ${BEKLENEN_BORC})`);

  // Ekstrede kasa satırı ayrı görünmeli ve "KASA TUTARI" yazmalı.
  const ekstreA = await vega.cariEkstre({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Ekstrede uc ayri satir var (fatura + kasa + tahsilat)', ekstreA.satirlar.length === 3,
    `${ekstreA.satirlar.length} satir`);
  const kasaSatiri = ekstreA.satirlar.find((s) => (s.aciklama || '').indexOf('KASA TUTARI') >= 0);
  kontrol('Kasa satiri "KASA TUTARI" aciklamasiyla gorunuyor', !!kasaSatiri,
    kasaSatiri ? `${kasaSatiri.aciklama} · ${kasaSatiri.borc} TL` : 'bulunamadi');
  if (kasaSatiri) {
    kontrol('Kasa satirinin tutari 100 TL', Number(kasaSatiri.borc) === 100, String(kasaSatiri.borc));
  }
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
  kontrol('Islem gunluge yazildi', gunlukA.length > 0 && gunlukA[0].BelgeNo === yazmaA.belgeNo + ' / ' + yazmaA.kasaBelgeNo + ' / ' + yazmaA.tahsilatBelgeNo,
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
  bolum('B — Cari cikis olarak yazma');

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
  kontrol('Iki cari cikis basligi (urun + kasa)', sB.TBLCARCIKBASLIK === 2,
    String(sB.TBLCARCIKBASLIK));
  kontrol('Cari hareketi 2 satir', sB.TBLCARIHAREKETLERI === 2, String(sB.TBLCARIHAREKETLERI));

  // İki belge farklı numara almalı — sayaç çalışıyor mu?
  const numaralar = await sql.sorgu(`
    SELECT BELGENO FROM ${vtAdi('TBLCARCIKBASLIK', true)} ORDER BY IND`);
  const farkli = new Set(numaralar.map((x) => x.BELGENO)).size === numaralar.length;
  kontrol('Iki belge farkli numara aldi', farkli,
    numaralar.map((x) => x.BELGENO).join(', '));

  // Ödeme aracı alanları boş kalmalı: nakit işaretlenirse Vega kasa raporunda
  // karşılığı olmayan para görünür.
  const arac = await sql.sorgu(`
    SELECT COUNT(*) AS adet FROM ${vtAdi('TBLCARCIKHAREKET', true)}
    WHERE ISNULL(IZAHAT, 0) <> 0 OR ISNULL(PORTNO, 0) <> 0`);
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
  kontrol('Belge yazildi', belgeC.tamam, belgeC.kasaBelgeNo);

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
  kontrol('Cari giris basligi olustu', sC.TBLCARGIRBASLIK === 1, String(sC.TBLCARGIRBASLIK));

  const alacak = await sql.sorgu(`
    SELECT SUM(ISNULL(ALACAK,0)) AS alacak FROM ${vtAdi('TBLCARIHAREKETLERI', true)}`);
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
