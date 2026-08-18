'use strict';

// VEGADB'YE YAZMA SINAMASI
//
//     sqlcmd -S localhost -E -C -i kurulum\vega-test-olustur.sql   (bir kez)
//     node kurulum/test-yazma.js
//
// GERÇEK MÜŞTERİ VERİSİNE DOKUNMAZ. Yapısı VEGADB'den kopyalanmış boş bir
// VEGA_TEST veritabanında çalışır; kendi kayıtlarını da BELGE_DOLDURUCU_TEST
// içinde tutar. Sınama başlarken bu iki veritabanının adını doğrular ve adı
// beklenenden farklıysa hiçbir şey yapmadan çıkar — yanlışlıkla canlı
// veritabanına yazmanın önünü kesen tek koruma bu.
//
// Sınadığı şey: belge yazıldığında beş tablonun da doğru bağ alanlarıyla
// dolduğu, cari bakiyenin doğru değiştiği ve geri almanın hiç iz bırakmadığı.

const fs = require('fs');
const path = require('path');
const os = require('os');

const VEGA_TEST = 'VEGA_TEST';
const KENDI_TEST = 'BELGE_DOLDURUCU_TEST';

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
  kendiVeritabani: KENDI_TEST,
  vegayaYazmaAktif: true,
  varsayilanFirma: 'F0102',
  varsayilanDonem: 'D0002',
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
const kayit = require('../db/kayit');
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
const DONEM = 'D0002';

function vtAdi(ad, donemli) {
  return `[${VEGA_TEST}].dbo.${FIRMA}${donemli ? DONEM : ''}${ad}`;
}

async function satirSayisi(ad, donemli) {
  const r = await sql.sorgu(`SELECT COUNT(*) AS adet FROM ${vtAdi(ad, donemli)}`);
  return Number(r[0].adet);
}

// Yazma yolunun dokunduğu bütün tablolar. Geri almadan sonra hepsi sıfır olmalı.
const HAREKET_TABLOLARI = [
  'TBLCARIHAREKETLERI',
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
  // Bağ sırası önemli değil: hepsi aynı sınama veritabanında ve dış anahtar yok.
  for (const t of HAREKET_TABLOLARI) {
    await sql.calistir(`DELETE FROM ${vtAdi(t, true)}`);
  }
}

async function kendiKayitlariTemizle() {
  const db = kayit.p();
  for (const t of ['KasaHareket', 'BelgeSatir', 'Belge', 'Islem']) {
    await sql.calistir(`
      IF OBJECT_ID('[${db}].dbo.${t}', 'U') IS NOT NULL DELETE FROM [${db}].dbo.${t}
    `);
  }
}

async function calistir() {
  console.log('Hizli Belge Doldurucu — YAZMA sinamasi');
  console.log('Ayar dosyasi: ' + ayarDosyasi);

  const a = ayarOku();

  // --- Emniyet: yanlış veritabanına yazma ---------------------------------
  bolum('Emniyet kontrolu');

  if (a.vegaVeritabani !== VEGA_TEST || a.kendiVeritabani !== KENDI_TEST) {
    console.error(
      `\nDURDURULDU. Sinama yalnizca ${VEGA_TEST} / ${KENDI_TEST} uzerinde calisir.\n` +
      `Su an: ${a.vegaVeritabani} / ${a.kendiVeritabani}`
    );
    process.exit(1);
  }
  kontrol('Sinama veritabanlari dogru', true, `${a.vegaVeritabani} / ${a.kendiVeritabani}`);

  const t = await sql.baglantiTesti();
  kontrol('Baglanti kuruldu', t.veritabani === VEGA_TEST, t.veritabani);

  // Kopya gerçekten boş mu? Doluysa canlı veritabanına bakıyor olabiliriz.
  await hareketleriTemizle();
  await kayit.hazirla(true);
  await kendiKayitlariTemizle();

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

  // Kasa tipine bilinen bir depozito bedeli ver: 100 TL (videodaki tutar).
  const tipler = await kayit.kasaTipleriGetir(true);
  const kasaTipi = tipler[0];
  await kayit.kasaTipiKaydet({
    id: kasaTipi.id, kod: kasaTipi.kod, ad: kasaTipi.ad, depozito: 100, aktif: true
  });
  const guncelTipler = await kayit.kasaTipleriGetir(true);
  const tip = guncelTipler.find((x) => x.id === kasaTipi.id);
  kontrol('Kasa tipi depozitosu ayarlandi', tip.depozito === 100, `${tip.kod} = ${tip.depozito} TL`);

  // Videodaki örnek: 10,8 kg × 30 TL = 324,00 TL ürün + 1 kasa × 100 TL.
  function ornekSatirlar() {
    return [
      {
        stokNo: stoklar[0].stokNo, stokKodu: stoklar[0].kod, stokAdi: stoklar[0].ad,
        birim: stoklar[0].birim, birimEx: stoklar[0].birimEx,
        daraliMiktar: 10.8, fiyat: 30, tutar: 324,
        kasaAdedi: 1, kasaTipiId: tip.id, kasaTipiKod: tip.kod,
        kasaDepozito: 100, kasaTutari: 100
      },
      {
        stokNo: stoklar[1].stokNo, stokKodu: stoklar[1].kod, stokAdi: stoklar[1].ad,
        birim: stoklar[1].birim, birimEx: stoklar[1].birimEx,
        daraliMiktar: 5, fiyat: 20, tutar: 100,
        kasaAdedi: 0, kasaTipiId: null, kasaTipiKod: null,
        kasaDepozito: 0, kasaTutari: 0
      }
    ];
  }

  const URUN_TOPLAM = 424;   // 324 + 100
  const KASA_TOPLAM = 100;
  const BEKLENEN_BORC = URUN_TOPLAM + KASA_TOPLAM;

  // ======================================================================
  bolum('A — Satis faturasi olarak yazma');

  const belgeA = await kayit.belgeKaydet({
    firma: FIRMA, donem: DONEM, tarih: new Date(),
    cariInd: cari.cariInd, cariKod: cari.kod, cariAd: cari.ad,
    belgeTuru: 'satisFaturasi', fisNo: 'SINAMA-A',
    satirlar: ornekSatirlar()
  });
  kontrol('Belge kendi veritabanina kaydedildi', belgeA.belgeId > 0, '#' + belgeA.belgeId);
  kontrol('Urun toplami dogru', belgeA.urunTutari === URUN_TOPLAM, String(belgeA.urunTutari));
  kontrol('Kasa tutari dogru', belgeA.kasaTutari === KASA_TOPLAM, String(belgeA.kasaTutari));

  const yazmaA = await yazma.belgeyiVegayaYaz({ belgeId: belgeA.belgeId });
  kontrol('Vegaya yazildi', yazmaA.tamam, yazmaA.belgeNo);
  kontrol('Belge numarasi H onekli', /(^|\/ )H\d{7}/.test(yazmaA.belgeNo), yazmaA.belgeNo);

  // Fatura ile kasa dekontu AYRI numara almalı. Sayaç tablo başına sayarsa
  // ikisi de H0000001 olur; o zaman cari ekstresi iki belgeyi ayirt edemez ve
  // kasa satirinin aciklamasi fatura satirina da yapisir.
  const parcalar = yazmaA.belgeNo.split(' / ').map((x) => x.trim());
  kontrol('Fatura ve kasa dekontu ayri numara aldi',
    parcalar.length === 2 && parcalar[0] !== parcalar[1], yazmaA.belgeNo);

  const sA = await tumSayilar();
  kontrol('Satis faturasi basligi 1 satir', sA.TBLSATFATBASLIK === 1, String(sA.TBLSATFATBASLIK));
  kontrol('Fatura satirlari 2 satir', sA.TBLSATFATHAREKET === 2, String(sA.TBLSATFATHAREKET));
  kontrol('Stok hareketi 2 satir', sA.TBLSTOKHAREKETLERI === 2, String(sA.TBLSTOKHAREKETLERI));
  kontrol('Depo envanteri 2 satir', sA.TBLDEPOENVANTER === 2, String(sA.TBLDEPOENVANTER));
  kontrol('Kasa dekontu basligi 1 satir', sA.TBLCARCIKBASLIK === 1, String(sA.TBLCARCIKBASLIK));
  kontrol('Cari hareketi 2 satir (fatura + kasa)', sA.TBLCARIHAREKETLERI === 2,
    String(sA.TBLCARIHAREKETLERI));

  // Bağ alanları: fatura satırı başlığın IND'ine, stok hareketi hem başlığa
  // hem satıra bağlanmalı. Yanlış bağlanan satır hatasız yazılır ama Vega'nın
  // hiçbir ekranında görünmez — sessiz bozulmanın en sık kaynağı bu.
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
  kontrol('Cari bakiyesi urun + kasa kadar artti',
    Math.abs(bakiyeA - BEKLENEN_BORC) < 0.01, `${bakiyeA} (beklenen ${BEKLENEN_BORC})`);

  // Ekstrede kasa satırı ayrı görünmeli ve "KASA TUTARI" yazmalı.
  const ekstreA = await vega.cariEkstre({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Ekstrede iki ayri satir var', ekstreA.satirlar.length === 2,
    `${ekstreA.satirlar.length} satir`);
  const kasaSatiri = ekstreA.satirlar.find((s) => (s.aciklama || '').indexOf('KASA TUTARI') >= 0);
  kontrol('Kasa satiri "KASA TUTARI" aciklamasiyla gorunuyor', !!kasaSatiri,
    kasaSatiri ? `${kasaSatiri.aciklamaAdi || kasaSatiri.aciklama} · ${kasaSatiri.borc} TL` : 'bulunamadi');
  if (kasaSatiri) {
    kontrol('Kasa satirinin tutari 100 TL', Number(kasaSatiri.borc) === 100, String(kasaSatiri.borc));
  }
  kontrol('Ekstre son bakiyesi cari bakiyesiyle ayni',
    Math.abs(ekstreA.sonBakiye - bakiyeA) < 0.01, `${ekstreA.sonBakiye}`);

  // Vega'ya yazılmış belge silinmemeli — iki taraf birbirini tutmaz.
  let silmeReddedildi = false;
  try {
    await kayit.belgeSil(belgeA.belgeId);
  } catch (e) {
    silmeReddedildi = true;
  }
  kontrol('Vegaya yazilmis belge silinmiyor', silmeReddedildi);

  // Aynı belge iki kez yazılmamalı.
  let ciftYazmaReddedildi = false;
  try {
    await yazma.belgeyiVegayaYaz({ belgeId: belgeA.belgeId });
  } catch (e) {
    ciftYazmaReddedildi = true;
  }
  kontrol('Ayni belge ikinci kez yazilmiyor', ciftYazmaReddedildi);

  // --- Geri alma ---
  const geriA = await yazma.belgeVegaGeriAl({ belgeId: belgeA.belgeId });
  kontrol('Geri alindi', geriA.tamam, `${geriA.silinenSatir} satir silindi`);

  const sonrasiA = await tumSayilar();
  kontrol('Geri almadan sonra hicbir iz kalmadi', toplamSatir(sonrasiA) === 0,
    JSON.stringify(sonrasiA));

  const bakiyeSifir = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Cari bakiyesi eski haline dondu', Math.abs(bakiyeSifir) < 0.01, String(bakiyeSifir));

  // Geri alınan belge yeniden gönderilebilmeli. Numaranın eskisiyle aynı
  // çıkması beklenen davranış: sayaç var olan satırların en büyüğünden türüyor,
  // geri alınan belgenin satırları silindiği için o numara yeniden serbest.
  const yeniden = await yazma.belgeyiVegayaYaz({ belgeId: belgeA.belgeId });
  kontrol('Geri alinan belge yeniden yazilabiliyor', yeniden.tamam, yeniden.belgeNo);
  const yeniParcalar = yeniden.belgeNo.split(' / ').map((x) => x.trim());
  kontrol('Yeniden yazmada da numaralar birbirinden farkli',
    yeniParcalar.length === 2 && yeniParcalar[0] !== yeniParcalar[1], yeniden.belgeNo);
  await yazma.belgeVegaGeriAl({ belgeId: belgeA.belgeId });

  // ======================================================================
  bolum('B — Cari cikis olarak yazma');

  await hareketleriTemizle();

  const belgeB = await kayit.belgeKaydet({
    firma: FIRMA, donem: DONEM, tarih: new Date(),
    cariInd: cari.cariInd, cariKod: cari.kod, cariAd: cari.ad,
    belgeTuru: 'cariCikis', fisNo: 'SINAMA-B',
    satirlar: ornekSatirlar()
  });
  const yazmaB = await yazma.belgeyiVegayaYaz({ belgeId: belgeB.belgeId });
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
    Math.abs(bakiyeB - BEKLENEN_BORC) < 0.01, `${bakiyeB} (beklenen ${BEKLENEN_BORC})`);

  await yazma.belgeVegaGeriAl({ belgeId: belgeB.belgeId });
  const sonrasiB = await tumSayilar();
  kontrol('Geri almadan sonra hicbir iz kalmadi', toplamSatir(sonrasiB) === 0,
    JSON.stringify(sonrasiB));

  // ======================================================================
  bolum('C — Kasa iadesi');

  await hareketleriTemizle();
  await kendiKayitlariTemizle();

  // İade edilebilmesi için önce kasanın verilmiş olması gerekiyor.
  const belgeC = await kayit.belgeKaydet({
    firma: FIRMA, donem: DONEM, tarih: new Date(),
    cariInd: cari.cariInd, cariKod: cari.kod, cariAd: cari.ad,
    belgeTuru: 'cariCikis', fisNo: 'SINAMA-C',
    satirlar: [{
      stokNo: stoklar[0].stokNo, stokKodu: stoklar[0].kod, stokAdi: stoklar[0].ad,
      birim: stoklar[0].birim, birimEx: stoklar[0].birimEx,
      daraliMiktar: 10, fiyat: 10, tutar: 100,
      kasaAdedi: 3, kasaTipiId: tip.id, kasaTipiKod: tip.kod,
      kasaDepozito: 100, kasaTutari: 300
    }]
  });
  await yazma.belgeyiVegayaYaz({ belgeId: belgeC.belgeId });

  const acik = await kayit.kasaBakiyesi({ firma: FIRMA, cariInd: cari.cariInd });
  kontrol('Musteride 3 kasa acik gorunuyor',
    acik.length === 1 && Number(acik[0].acikAdet) === 3,
    acik.length ? `${acik[0].kasaTipiKod} ${acik[0].acikAdet} adet · ${acik[0].acikTutar} TL` : 'yok');

  // Elde olandan fazlası iade alınamamalı.
  let fazlaIadeReddedildi = false;
  try {
    await kayit.kasaIadeKaydet({
      firma: FIRMA, donem: DONEM, cariInd: cari.cariInd, cariAd: cari.ad,
      kasaTipiId: tip.id, adet: 5
    });
  } catch (e) {
    fazlaIadeReddedildi = true;
  }
  kontrol('Acik adetten fazla iade reddedildi', fazlaIadeReddedildi);

  const bakiyeOnce = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });

  const iade = await kayit.kasaIadeKaydet({
    firma: FIRMA, donem: DONEM, cariInd: cari.cariInd, cariAd: cari.ad,
    kasaTipiId: tip.id, adet: 2
  });
  kontrol('Iade kaydedildi', iade.tamam, `${iade.adet} adet · ${iade.tutar} TL`);
  kontrol('Kalan acik adet 1', iade.kalanAdet === 1, String(iade.kalanAdet));

  const yazmaIade = await yazma.kasaIadesiniVegayaYaz({ kasaHareketId: iade.kasaHareketId });
  kontrol('Iade Vegaya yazildi', yazmaIade.tamam, yazmaIade.belgeNo);

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

  await yazma.kasaIadeVegaGeriAl({ kasaHareketId: iade.kasaHareketId });
  const bakiyeGeri = await vega.cariBakiye({ firma: FIRMA, donem: DONEM, cariInd: cari.cariInd });
  kontrol('Iade geri alindi, bakiye eski haline dondu',
    Math.abs(bakiyeGeri - bakiyeOnce) < 0.01, String(bakiyeGeri));

  // ======================================================================
  bolum('D — Islem gunlugu');

  const gunluk = await kayit.islemGunlugu(50);
  const yazmaKayitlari = gunluk.filter((g) => g.Konu === 'Vega yazma');
  kontrol('Yazma islemleri gunluge yazildi', yazmaKayitlari.length > 0,
    `${yazmaKayitlari.length} kayit`);
  kontrol('Gunlukte kullanici ve bilgisayar var',
    yazmaKayitlari.length > 0 && !!yazmaKayitlari[0].Kullanici && !!yazmaKayitlari[0].Bilgisayar,
    yazmaKayitlari.length ? `${yazmaKayitlari[0].Kullanici}@${yazmaKayitlari[0].Bilgisayar}` : '—');

  // ======================================================================
  bolum('Temizlik');
  await hareketleriTemizle();
  await kendiKayitlariTemizle();
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
