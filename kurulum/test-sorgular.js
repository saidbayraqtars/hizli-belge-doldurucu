'use strict';

// Veritabanı sınaması — Electron olmadan çalışır:
//
//     npm run test:db
//
// Yalnızca OKUR (yardımcı tablo kontrolü hariç — o da VEGADB'ye INSERT
// atmaz, yalnızca CREATE TABLE IF NOT EXISTS yapar). Yazma yolları bilerek
// sınanmıyor: bunun için yapısı kopyalanmış ayrı bir veritabanı gerekiyor
// (bkz. kurulum/BELGE-DESENI.md, npm run test:yazma).

const { ayarOku, ayarYolu } = require('../db/ayar');
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

async function calistir() {
  console.log('Hizli Belge Doldurucu — veritabani sinamasi');
  console.log('Ayar dosyasi: ' + ayarYolu());

  const a = ayarOku();
  console.log(`Sunucu: ${a.sunucu}  ·  Vega: ${a.vegaVeritabani}`);

  bolum('Baglanti');
  const t = await sql.baglantiTesti();
  kontrol('SQL Server baglantisi', t.tamam, t.surum);

  bolum('Firma ve donem kesfi');
  const firmalar = await firma.firmalariGetir(true);
  kontrol('En az bir firma bulundu', firmalar.length > 0, `${firmalar.length} firma`);
  for (const f of firmalar) {
    const bilgi = (f.donemBilgi || [])
      .map((b) => `${b.donem}:${b.hareket}`)
      .join(' ');
    console.log(`         ${f.kod} ${f.kisaAd} → ${bilgi}`);
  }

  const secili = a.varsayilanFirma
    ? firmalar.find((f) => f.kod === a.varsayilanFirma)
    : firmalar[0];

  if (!secili) {
    console.log('\nCalisilabilir firma bulunamadi; okuma sinamalari atlandi.');
    return ozet();
  }

  const donem = a.varsayilanDonem && secili.donemler.includes(a.varsayilanDonem)
    ? a.varsayilanDonem
    : secili.varsayilanDonem;
  const secenek = { firma: secili.kod, donem };
  console.log(`\nSinama firmasi: ${secili.kod} ${secili.kisaAd} / ${donem}`);

  const d = await firma.dogrula(secenek.firma, secenek.donem);
  kontrol('Firma/donem dogrulandi', d.firma === secili.kod && d.donem === donem);

  bolum('VEGADB okumalari');

  const depolar = await firma.depolariGetir();
  kontrol('Depo listesi okundu', Array.isArray(depolar), `${depolar.length} depo`);

  const cariler = await vega.carileriGetir(Object.assign({ limit: 20 }, secenek));
  kontrol('Cari kartlari okundu', Array.isArray(cariler), `${cariler.length} cari`);
  if (cariler.length) {
    const c = cariler[0];
    kontrol('Cari kaydinda ad ve numara var', !!c.ad && Number.isFinite(c.cariInd),
      `${c.ad} → ${c.bakiye}`);

    const bakiye = await vega.cariBakiye(Object.assign({ cariInd: c.cariInd }, secenek));
    kontrol('Cari bakiyesi hesaplandi', Number.isFinite(bakiye), String(bakiye));

    // Liste bakiyesi ile tek cari bakiyesi aynı formülden gelmeli; ayrılırsa
    // ekranda gösterilen sayı ekstredeki toplamla tutmaz.
    kontrol(
      'Liste bakiyesi ile tek cari bakiyesi ayni',
      Math.abs(bakiye - c.bakiye) < 0.01,
      `liste ${c.bakiye} · tek ${bakiye}`
    );

    const ekstre = await vega.cariEkstre(Object.assign({ cariInd: c.cariInd, limit: 50 }, secenek));
    kontrol('Ekstre okundu', Array.isArray(ekstre.satirlar), `${ekstre.satirlar.length} hareket`);
    if (ekstre.satirlar.length) {
      const son = ekstre.satirlar[ekstre.satirlar.length - 1];
      kontrol('Yuruyen bakiye son satirda tutuyor',
        Math.abs(son.bakiye - ekstre.sonBakiye) < 0.01);
    }
  }

  const stoklar = await vega.stoklariGetir(Object.assign({ limit: 20 }, secenek));
  kontrol('Stok kartlari okundu', Array.isArray(stoklar), `${stoklar.length} kart`);
  if (stoklar.length) {
    kontrol('Stok kaydinda ad ve numara var',
      !!stoklar[0].ad && Number.isFinite(stoklar[0].stokNo), stoklar[0].ad);
  }

  const aramaSonucu = await vega.stoklariGetir(Object.assign({ arama: 'A', limit: 5 }, secenek));
  kontrol('Stok aramasi calisiyor', Array.isArray(aramaSonucu), `${aramaSonucu.length} sonuc`);

  const seriTespit = await vega.satisSerisiTespitEt(secenek.firma, secenek.donem);
  kontrol('Fatura serisi tespiti calisiyor (bos donebilir)',
    seriTespit === null || /^[A-ZÇĞİÖŞÜ]$/.test(seriTespit),
    seriTespit || '(bu donemde fatura yok)');

  bolum('VEGADB icindeki yardimci tablolar (dara / kasa defteri / gunluk)');

  // Bu sinama SALT OKUNUR kalsin diye tabloyu BURADA kurdurmuyoruz — sadece
  // zaten var mi diye bakiyoruz. Kurulum ilk yazma anında kendiliğinden olur
  // (db/yazma.js → yardimci.hazirla()), ya da elle: npm run test:yazma.
  const v = ayarOku().vegaVeritabani;
  const varMi = await sql.sorgu(
    `SELECT CASE WHEN OBJECT_ID('[${v}].dbo.BD_Islem', 'U') IS NULL THEN 0 ELSE 1 END AS varMi`
  );
  if (Number(varMi[0].varMi) === 1) {
    const kasaTipleri = await yardimci.kasaTipleriGetir();
    kontrol('Kasa tipleri okundu', Array.isArray(kasaTipleri), `${kasaTipleri.length} tip`);

    const kasaBakiye = await yardimci.kasaBakiyesi({ firma: secili.kod });
    kontrol('Kasa bakiyesi okundu', Array.isArray(kasaBakiye), `${kasaBakiye.length} kayit`);

    const gunluk = await yardimci.sonIslemleriGetir({ firma: secili.kod, limit: 20 });
    kontrol('Islem gunlugu okundu', Array.isArray(gunluk), `${gunluk.length} kayit`);
  } else {
    console.log('  (yardimci tablolar henuz kurulmamis — ilk yazmada kendiliginden kurulur, atlandi)');
  }

  bolum('Yazma kilidi');

  // Kilit gerçekten kapalı mı? Sahte sınama olmasın diye ayarı geçici olarak
  // kapatıp yazma fonksiyonunun HATA verdiğini doğruluyoruz.
  const oncekiDurum = ayarOku().vegayaYazmaAktif;
  ayarOku().vegayaYazmaAktif = false;
  let kilitTuttu = false;
  let kilitKodu = null;
  try {
    await yazma.belgeYaz({ cariInd: 1, belgeTuru: 'cariCikis', satirlar: [{ stokNo: 1, tutar: 1 }] });
  } catch (e) {
    kilitTuttu = true;
    kilitKodu = e.kod;
  }
  ayarOku().vegayaYazmaAktif = oncekiDurum;

  kontrol('Yazma kapaliyken belge yazma reddedildi', kilitTuttu);
  kontrol('Ret kodu YAZMA_KAPALI', kilitKodu === 'YAZMA_KAPALI', String(kilitKodu));
  kontrol('Ayardaki yazma durumu okunabiliyor',
    typeof yazma.yazmaAcikMi() === 'boolean',
    yazma.yazmaAcikMi() ? 'ACIK' : 'kapali');

  let onekGecerli = false;
  try {
    onekGecerli = /^[A-Z]{1,3}$/.test(yazma.belgeOneki());
  } catch (e) {
    onekGecerli = false;
  }
  kontrol('Belge oneki gecerli', onekGecerli);

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
