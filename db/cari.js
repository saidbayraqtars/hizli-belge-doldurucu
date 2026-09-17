'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  CARİ KARTI AÇMA
// ═══════════════════════════════════════════════════════════════════════════
//
// Kart doğrudan Vega'nın kendi tablosuna (F{firma}TBLCARI) tek satır olarak
// yazılır — programın ayrı bir müşteri listesi yok.
//
// 17.09.2026: DESEN YENİDEN ÇIKARILDI. Eski desen müşterinin 491 kartından
// alınmıştı ama o kartların hepsi 22.08.2026'da Access'ten TOPLU AKTARILMIŞ
// kartlardı, Vega ekranından açılmış değil. Program o desenle kart açınca
// (IND 603-605) Vega'nın kendi kartlarından farklı kaldı; 605 numaralı kart
// kullanıcı tarafından Vega'dan aynı telefonla yeniden açıldı (609). Yeni desen
// Vega'nın ekranından açılmış 77 kartın ortak alanlarıdır (VEGADB F0101/F0102/
// F0103, müşteri kopyası F0102, cazgir F0126, özdemirkaya F0101):
//
//   Hepsinde aynı      : PARABIRIMI='TL', STATUS=1, STATU=0, TAKSITTIPI=1,
//                        ISKONTO/AYLIKVADE/OPSIYON/GECIKMEFAIZI=0,
//                        BAKIYE/ODEMEBAKIYESI=0, ZIMFIYAT=0 (eski kod 1 yazıyordu),
//                        KREDILIMITIKONTROL=2, CARIPOZISYON=0, KURTIPI=1,
//                        NACEKODU='', SMSGONDER=1, EMAILGONDER=1,
//                        SATIS/TAHSILAT/ODEME/ALIS/SIPARIS-YAPILMASIN=0,
//                        IADEFATURASIKESILMESIN=0, UID='{GUID}',
//                        KAYITTARIHI = gün (saatsiz)
//   Firmaya göre       : SUBEADI (çoğunda 'MERKEZ'), DEPOIND (çoğunda 1) —
//                        o firmanın Vega'dan açılmış kartlarında en sık değer
//   Kart türü          : ISLETMETURU 1 = şahıs (ADI/SOYADI dolu), 0 = firma
//                        (10 haneli VKN). Özdemirkaya'da 21.625 şahıs kartının
//                        21.430'unda ADI dolu.
//   Ad                 : FIRMAADI (nvarchar(100) = 50 karakter; Vega uzun ünvanı
//                        50'de kesiyor) ve UNVAN tam ad. Müşteri kartlarının
//                        498/504'ünde UNVAN = FIRMAADI. Eski kod UNVAN'a "baba
//                        adı" notu yazıyordu — UNVAN faturaya ünvan olarak
//                        basıldığı için kaldırıldı.
//   Özel Kod 1         : KOD1; seçenekler F{firma}TBLCARIKODTAN (CATEGORY 1)
//                        ile kartlarda kullanılan değerler.
//
// Vega kart açarken başka tabloya satır yazmıyor: müşteri kopyasında bütün
// CARIIND/FIRMANO sütunları tarandı. 609'daki boş TBLCARIBANKAKARTLARI /
// TBLCARIKREDIKARTLARI satırları 602/606/608'de yok — kart ekranında o sekme
// açılınca oluşuyor, zorunlu değil. FIRMATIPI'nin 4 biti bir kurulumda
// personel, bir kurulumda perakende için kullanılmış; anlamı net olmadığı için
// yalnız Alıcı (1) / Satıcı (2) / ikisi (3) yazılır.
//
// FIRMAKODU kullanıcı yazar; program yalnız öneri verir (son açılan kısa sayısal
// kod + 1, bu işletmede 5000'li seri) ve aynı kodun ikinci kez kullanılmasını
// aynı transaction içinde kilitle engeller.
//
// ALAN ADI EŞLEŞMESİ (listeler ve rapor başlığı bu kartlardan okunuyor):
//   Adresi (köy / ilçe) → SEHIR   Açık adres → ADRESPOSTA   Telefon → TELEFON1

const { sorgu, islem } = require('./sql');
const { ayarOku } = require('./ayar');
const { dogrula, kart, tablo } = require('./firma');
const { kolonVarMi, musteriTipiFiltresi, ozelKod1Degerleri } = require('./vega');
const yazma = require('./yazma');

function vt() {
  return ayarOku().vegaVeritabani;
}

const TIP_ALICI = 1;
const TIP_SATICI = 2;

function tipCoz(ham) {
  const t = String(ham || 'alici').toLowerCase();
  if (t === 'satici') return TIP_SATICI;
  if (t === 'ikisi' || t === 'hepsi') return TIP_ALICI | TIP_SATICI;
  return TIP_ALICI;
}

function tipAdi(firmaTipi) {
  const t = Number(firmaTipi) || 0;
  const alici = (t & TIP_ALICI) === TIP_ALICI;
  const satici = (t & TIP_SATICI) === TIP_SATICI;
  if (alici && satici) return 'Alıcı + Satıcı';
  if (satici) return 'Satıcı';
  if (alici) return 'Alıcı';
  return 'Diğer';
}

// Vega ekranından açılmış kartlarda ortak değerler (yukarıdaki açıklama).
const VEGA_KART_VARSAYILANLARI = {
  PARABIRIMI: 'TL',
  STATUS: 1,
  STATU: 0,
  TAKSITTIPI: 1,
  ISKONTO: 0,
  AYLIKVADE: 0,
  OPSIYON: 0,
  GECIKMEFAIZI: 0,
  BAKIYE: 0,
  ODEMEBAKIYESI: 0,
  ZIMFIYAT: 0,
  KREDILIMITIKONTROL: 2,
  CARIPOZISYON: 0,
  KURTIPI: 1,
  NACEKODU: '',
  SMSGONDER: true,
  EMAILGONDER: true,
  SATISYAPILMASIN: false,
  TAHSILATYAPILMASIN: false,
  IADEFATURASIKESILMESIN: false,
  ODEMEYAPILMASIN: false,
  ALISYAPILMASIN: false,
  SIPARISYAPILMASIN: false
};

function metin(deger) {
  return String(deger == null ? '' : deger).replace(/\s+/g, ' ').trim();
}

// Kart formundaki girdiyi Vega sütunlarına çevirir ve denetler. Veritabanına
// dokunmaz; birim sınamada da kullanılıyor.
function kartSatiriKur(secenek, firmaBilgisi) {
  const kod = metin(secenek.kod);
  if (!kod) throw new Error('Cari kodu girilmeli.');

  const sahis = String(secenek.tur || 'sahis') !== 'firma';
  const adi = metin(secenek.adi);
  const soyadi = metin(secenek.soyadi);
  const unvanGirdi = metin(secenek.unvan);
  let tamAd;
  if (sahis) {
    if (!adi) throw new Error('Adı girilmeli.');
    tamAd = soyadi ? `${adi} ${soyadi}` : adi;
  } else {
    if (!unvanGirdi) throw new Error('Firma ünvanı girilmeli.');
    tamAd = unvanGirdi;
  }
  tamAd = tamAd.toLocaleUpperCase('tr-TR');

  const vergiNo = metin(secenek.vergiNo).replace(/\s/g, '');
  if (vergiNo && !/^\d{10,11}$/.test(vergiNo)) {
    throw new Error('Vergi / TC kimlik no 10 ya da 11 rakam olmalı.');
  }

  const ozelKod1 = metin(secenek.ozelKod1);
  if (ozelKod1 && firmaBilgisi && Array.isArray(firmaBilgisi.ozelKod1)) {
    const gecerli = firmaBilgisi.ozelKod1.find((d) =>
      d.toLocaleUpperCase('tr-TR') === ozelKod1.toLocaleUpperCase('tr-TR'));
    if (!gecerli) throw new Error(`Özel Kod 1 "${ozelKod1}" Vega'da tanımlı değil.`);
  }

  // Bağlantı tarihleri UTC olarak yazıyor (db/sql.js); Vega'daki gibi saatsiz
  // "gün 00:00" görünsün diye yerel günün UTC gece yarısı veriliyor.
  const yerel = /^\d{4}-\d{2}-\d{2}$/.test(String(secenek.tarih || ''))
    ? new Date(`${secenek.tarih}T00:00:00`)
    : new Date(secenek.tarih || Date.now());
  const bugun = new Date(Date.UTC(yerel.getFullYear(), yerel.getMonth(), yerel.getDate()));

  const bosIse = (m) => (m ? m : null);
  const buyuk = (m) => (m ? m.toLocaleUpperCase('tr-TR') : null);

  return Object.assign({}, VEGA_KART_VARSAYILANLARI, {
    FIRMAKODU: kod,
    FIRMAADI: tamAd,
    UNVAN: tamAd,
    ADI: sahis ? buyuk(adi) : null,
    SOYADI: sahis ? buyuk(soyadi) || null : null,
    ISLETMETURU: sahis ? 1 : 0,
    FIRMATIPI: tipCoz(secenek.tip),
    TELEFON1: bosIse(metin(secenek.telefon)),
    TELEFON2: bosIse(metin(secenek.telefon2)),
    SEHIR: buyuk(metin(secenek.sehir)),
    ADRESPOSTA: bosIse(metin(secenek.adres)),
    VERGIDAIRESI: buyuk(metin(secenek.vergiDairesi)),
    VERGINO: bosIse(vergiNo),
    KOD1: ozelKod1
      ? firmaBilgisi.ozelKod1.find((d) => d.toLocaleUpperCase('tr-TR') === ozelKod1.toLocaleUpperCase('tr-TR'))
      : null,
    KAYITTARIHI: bugun,
    SUBEADI: (firmaBilgisi && firmaBilgisi.subeAdi) || 'MERKEZ',
    DEPOIND: (firmaBilgisi && firmaBilgisi.depoInd) || 1
  });
}

// Şube adı ve depo — o firmanın Vega'dan açılmış (UID'li) kartlarında en sık
// geçen değer; hiç yoksa MERKEZ / ayarlardaki depo.
async function firmaKartBilgisi(v, firma, donem) {
  const cariTablosu = kart(v, firma, 'TBLCARI');
  const bilgi = { subeAdi: 'MERKEZ', depoInd: Number(ayarOku().varsayilanDepo) || 1, ozelKod1: [] };

  if ((await kolonVarMi(cariTablosu, 'UID')) && (await kolonVarMi(cariTablosu, 'SUBEADI'))) {
    const s = await sorgu(
      `SELECT TOP 1 LTRIM(RTRIM(SUBEADI)) AS deger FROM ${cariTablosu}
       WHERE UID IS NOT NULL AND LTRIM(RTRIM(ISNULL(SUBEADI, ''))) <> ''
       GROUP BY LTRIM(RTRIM(SUBEADI)) ORDER BY COUNT(*) DESC`);
    if (s[0] && s[0].deger) bilgi.subeAdi = String(s[0].deger).trim();
  }
  if ((await kolonVarMi(cariTablosu, 'UID')) && (await kolonVarMi(cariTablosu, 'DEPOIND'))) {
    const d = await sorgu(
      `SELECT TOP 1 DEPOIND AS deger FROM ${cariTablosu}
       WHERE UID IS NOT NULL AND ISNULL(DEPOIND, 0) > 0
       GROUP BY DEPOIND ORDER BY COUNT(*) DESC`);
    if (d[0] && Number(d[0].deger)) bilgi.depoInd = Number(d[0].deger);
  }

  // Özel Kod 1: Vega'nın tanım tablosu + kartlarda fiilen yazılı değerler.
  const degerler = new Map();
  const kodTablosu = kart(v, firma, 'TBLCARIKODTAN');
  try {
    const r = await sorgu(
      `SELECT LTRIM(RTRIM(KOD)) AS kod FROM ${kodTablosu}
       WHERE CATEGORY = 1 AND LTRIM(RTRIM(ISNULL(KOD, ''))) <> '' ORDER BY IND`);
    for (const s of r) degerler.set(String(s.kod).toLocaleUpperCase('tr-TR'), String(s.kod));
  } catch (e) { /* tanım tablosu olmayan kurulum: yalnız kartlardaki değerler */ }
  try {
    for (const s of await ozelKod1Degerleri({ firma, donem })) {
      const anahtar = s.deger.toLocaleUpperCase('tr-TR');
      if (!degerler.has(anahtar)) degerler.set(anahtar, s.deger);
    }
  } catch (e) { /* KOD1 sütunu yoksa liste boş kalır */ }
  bilgi.ozelKod1 = [...degerler.values()];
  return bilgi;
}

// Önerilen kod: en son açılan kartlardan kısa (≤ 6 hane) sayısal kodu olanın
// bir fazlası, kullanılmayana kadar artırılır. Boşsa öneri yok.
async function kodOner(v, firma) {
  const cariTablosu = kart(v, firma, 'TBLCARI');
  const son = await sorgu(
    `SELECT TOP 50 LTRIM(RTRIM(FIRMAKODU)) AS kod FROM ${cariTablosu}
     WHERE IND >= 100 ORDER BY IND DESC`);
  const sayisal = son.map((s) => String(s.kod || '')).find((k) => /^\d{1,6}$/.test(k));
  if (!sayisal) return '';
  let aday = Number(sayisal) + 1;
  for (let i = 0; i < 200; i++, aday++) {
    if (!(await kodKullanimda(null, v, firma, String(aday)))) return String(aday);
  }
  return '';
}

async function kodKullanimda(t, v, firma, kod) {
  const sorgula = t ? t.sorgu : sorgu;
  const kilit = t ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
  const r = await sorgula(
    `SELECT TOP 1 IND FROM ${kart(v, firma, 'TBLCARI')}${kilit}
     WHERE LTRIM(RTRIM(ISNULL(FIRMAKODU, ''))) = @kod AND ISNULL(DELETED, 0) = 0`,
    { kod: String(kod).trim() }
  );
  return r.length ? Number(r[0].IND) : 0;
}

// Kart formunun ihtiyaç duyduğu bilgiler: kod önerisi, Özel Kod 1 seçenekleri.
async function kartFormBilgisi(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const bilgi = await firmaKartBilgisi(v, firma, donem);
  return {
    onerilenKod: await kodOner(v, firma),
    ozelKod1: bilgi.ozelKod1
  };
}

async function cariKartiAc(secenek) {
  yazma.kilitKontrol();

  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const cariTablosu = kart(v, firma, 'TBLCARI');
  const bilgi = await firmaKartBilgisi(v, firma, donem);
  const alanlar = kartSatiriKur(secenek || {}, bilgi);

  const cariInd = await islem(async (t) => {
    const cakisan = await kodKullanimda(t, v, firma, alanlar.FIRMAKODU);
    if (cakisan) {
      throw new Error(
        `"${alanlar.FIRMAKODU}" kodu zaten kullanılıyor (kart no ${cakisan}). Başka bir kod yazın.`
      );
    }
    return yazma.ekle(t, cariTablosu, alanlar, {
      zorunlu: ['FIRMAKODU', 'FIRMAADI', 'FIRMATIPI', 'STATUS'],
      ozel: { UID: "'{' + CAST(NEWID() AS NVARCHAR(36)) + '}'" }
    });
  });
  if (!cariInd) throw new Error('Cari kartı yazıldı ama kart numarası okunamadı.');

  return {
    tamam: true,
    cariInd,
    kod: alanlar.FIRMAKODU,
    ad: alanlar.FIRMAADI.substring(0, 50),
    adres: alanlar.SEHIR || alanlar.ADRESPOSTA || '',
    telefon: alanlar.TELEFON1 || '',
    tip: tipAdi(alanlar.FIRMATIPI),
    bakiye: 0,
    firma,
    donem
  };
}

// Müşteri listesinden seçme ekranı — arama kutusundan farkı, hepsini
// gezilebilir bir liste olarak vermesi ve alıcı/satıcı süzgeci taşıması.
async function carileriListele(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const cariTablosu = kart(v, firma, 'TBLCARI');
  const hareketTablosu = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');
  const limit = Math.min(Number((secenek && secenek.limit) || 1000), 5000);

  let tipFiltresi = '';
  if (secenek && secenek.tip === 'alici') tipFiltresi = 'AND (ISNULL(C.FIRMATIPI, 0) & 1) = 1';
  if (secenek && secenek.tip === 'satici') tipFiltresi = 'AND (ISNULL(C.FIRMATIPI, 0) & 2) = 2';

  let bakiyeFiltresi = '';
  if (secenek && secenek.sadeceBakiyeli) bakiyeFiltresi = 'AND ISNULL(B.bakiye, 0) <> 0';

  // Özel Kod 1 süzgeci (cari kartındaki KOD1) — bkz. db/vega.js.
  const parametreler = {};
  const musteriTipi = await musteriTipiFiltresi(
    cariTablosu, secenek && secenek.musteriTipi, 'C', parametreler
  );

  const adIfadesi = `
    COALESCE(
      NULLIF(LTRIM(RTRIM(C.FIRMAADI)), ''),
      NULLIF(LTRIM(RTRIM(C.UNVAN)), ''),
      NULLIF(LTRIM(RTRIM(C.FIRMAKODU)), ''),
      '#' + CAST(C.IND AS NVARCHAR(20))
    )`;

  const satirlar = await sorgu(`
    SELECT TOP ${limit}
      C.IND AS cariInd,
      ISNULL(C.FIRMAKODU, '') AS kod,
      ${adIfadesi} AS ad,
      ISNULL(C.FIRMATIPI, 0) AS firmaTipi,
      COALESCE(NULLIF(LTRIM(RTRIM(C.SEHIR)), ''),
               NULLIF(LTRIM(RTRIM(CAST(C.ADRESPOSTA AS NVARCHAR(200)))), ''), '') AS adres,
      ISNULL(C.TELEFON1, '') AS telefon,
      ISNULL(B.bakiye, 0) AS bakiye
    FROM ${cariTablosu} C
    LEFT JOIN (
      SELECT FIRMANO, SUM(ISNULL(BORC, 0) - ISNULL(ALACAK, 0)) AS bakiye
      FROM ${hareketTablosu}
      WHERE ISNULL(OZELKOD, '') <> 'KREDIHESABI'
      GROUP BY FIRMANO
    ) B ON B.FIRMANO = C.IND
    WHERE ISNULL(C.DELETED, 0) = 0 AND ISNULL(C.STATUS, 1) <> 2 AND C.IND >= 100
      ${tipFiltresi} ${bakiyeFiltresi} ${musteriTipi}
    ORDER BY ${adIfadesi}
  `, parametreler);

  return satirlar.map((s) => ({
    cariInd: Number(s.cariInd),
    kod: String(s.kod || '').trim(),
    ad: String(s.ad || '').trim(),
    tip: tipAdi(s.firmaTipi),
    adres: String(s.adres || '').trim(),
    telefon: String(s.telefon || '').trim(),
    bakiye: Number(s.bakiye) || 0
  }));
}

module.exports = {
  kartFormBilgisi,
  cariKartiAc,
  carileriListele,
  tipAdi,
  _test: { kartSatiriKur, VEGA_KART_VARSAYILANLARI }
};
