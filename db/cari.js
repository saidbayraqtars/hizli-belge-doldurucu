'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  CARİ KARTI AÇMA
// ═══════════════════════════════════════════════════════════════════════════
//
// Kart doğrudan Vega'nın kendi tablosuna (F{firma}TBLCARI) yazılır — programın
// ayrı bir müşteri listesi yok. Hangi alanların doldurulacağı tahminle değil,
// CANLI VERİDEN çıkarıldı: bu kurulumdaki 493 gerçek kartın 491'i tam olarak
// aşağıdaki alan kümesini taşıyor, geri kalan 100+ sütun hepsinde NULL.
//
//   Kullanıcıdan     : FIRMAKODU, FIRMAADI, FIRMATIPI
//   Kullanıcıdan (ops): TELEFON1, TELEFON2, SEHIR, ADRESPOSTA, UNVAN
//   Vega'nın sabitleri: KAYITTARIHI, PARABIRIMI='TL', STATUS=1, STATU=0,
//                       TAKSITTIPI=1, ZIMFIYAT=1, ISLETMETURU=0,
//                       ISKONTO/AYLIKVADE/OPSIYON/GECIKMEFAIZI/BAKIYE/
//                       ODEMEBAKIYESI = 0, DELETED = 0
//
// FIRMAKODU otomatik üretilmiyor: bu kurulumda kod düzeni tutarsız ("8", "16",
// "148-", "332-"), program kendi kafasına göre bir numara uydurursa
// işletmenin kendi düzenini bozar. Kullanıcı yazar, program yalnızca aynı
// kodun ikinci kez kullanılmasını engeller.
//
// ALAN ADI EŞLEŞMESİ (haftalık rapor başlığı bu kartlardan okunuyor):
//   ADRESİ   → SEHIR (yoksa ADRESPOSTA)
//   TELEFON  → TELEFON1
//   baba adı → UNVAN  (bu işletmede serbest not olarak kullanılıyor:
//              "ALİ OĞLU", "ESKİ MUHTAR", "kefili bekir")

const { sorgu } = require('./sql');
const { ayarOku } = require('./ayar');
const { dogrula, kart, tablo } = require('./firma');
const { kolonVarMi } = require('./vega');
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

// Kart açarken kullanıcıya hangi alanların sorulacağını arayüz buradan okur —
// alan listesi tek yerde dursun, sütun gerçekten var mı diye de bakılsın
// (Vega kurulumları arasında sütun farkı olabiliyor).
async function kartAlanlari(secenek) {
  const { firma } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const t = kart(vt(), firma, 'TBLCARI');
  const tanim = [
    { ad: 'kod', kolon: 'FIRMAKODU', etiket: 'Cari Kodu', zorunlu: true, uzunluk: 25 },
    { ad: 'unvan1', kolon: 'FIRMAADI', etiket: 'Adı Soyadı', zorunlu: true, uzunluk: 100 },
    { ad: 'telefon', kolon: 'TELEFON1', etiket: 'Telefon', zorunlu: false, uzunluk: 25 },
    { ad: 'telefon2', kolon: 'TELEFON2', etiket: 'İkinci Telefon', zorunlu: false, uzunluk: 25 },
    { ad: 'sehir', kolon: 'SEHIR', etiket: 'Adresi (köy / ilçe)', zorunlu: false, uzunluk: 50 },
    { ad: 'adres', kolon: 'ADRESPOSTA', etiket: 'Açık Adres', zorunlu: false, uzunluk: 200 },
    { ad: 'not', kolon: 'UNVAN', etiket: 'Not / Baba adı', zorunlu: false, uzunluk: 100 }
  ];
  const sonuc = [];
  for (const a of tanim) {
    if (await kolonVarMi(t, a.kolon)) sonuc.push(a);
  }
  return sonuc;
}

async function kodKullanimda(v, firma, kod) {
  const r = await sorgu(
    `SELECT TOP 1 IND FROM ${kart(v, firma, 'TBLCARI')}
     WHERE LTRIM(RTRIM(ISNULL(FIRMAKODU, ''))) = @kod AND ISNULL(DELETED, 0) = 0`,
    { kod: String(kod).trim() }
  );
  return r.length ? Number(r[0].IND) : 0;
}

async function cariKartiAc(secenek) {
  yazma.kilitKontrol();

  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const cariTablosu = kart(v, firma, 'TBLCARI');

  const kod = String(secenek.kod || '').trim();
  const ad = String(secenek.ad || '').trim();
  if (!kod) throw new Error('Cari kodu girilmeli.');
  if (!ad) throw new Error('Adı soyadı girilmeli.');

  const cakisan = await kodKullanimda(v, firma, kod);
  if (cakisan) {
    throw new Error(`"${kod}" kodu zaten kullanılıyor (kart no ${cakisan}). Başka bir kod yazın.`);
  }

  const firmaTipi = tipCoz(secenek.tip);

  // Sütun adı → değer. Var olmayan sütun sessizce atlanır.
  const istenen = {
    FIRMAKODU: kod,
    FIRMAADI: ad,
    UNVAN: secenek.not ? String(secenek.not).trim().substring(0, 100) : null,
    TELEFON1: secenek.telefon ? String(secenek.telefon).trim().substring(0, 25) : null,
    TELEFON2: secenek.telefon2 ? String(secenek.telefon2).trim().substring(0, 25) : null,
    SEHIR: secenek.sehir ? String(secenek.sehir).trim().substring(0, 50) : null,
    ADRESPOSTA: secenek.adres ? String(secenek.adres).trim().substring(0, 200) : null,
    FIRMATIPI: firmaTipi,
    KAYITTARIHI: new Date(secenek.tarih || Date.now()),
    PARABIRIMI: 'TL',
    STATUS: 1,
    STATU: 0,
    TAKSITTIPI: 1,
    ZIMFIYAT: 1,
    ISLETMETURU: 0,
    ISKONTO: 0,
    AYLIKVADE: 0,
    OPSIYON: 0,
    GECIKMEFAIZI: 0,
    BAKIYE: 0,
    ODEMEBAKIYESI: 0,
    DELETED: 0
  };

  const kolonlar = [];
  const degerler = [];
  const parametreler = {};
  let sira = 0;
  for (const [kolon, deger] of Object.entries(istenen)) {
    if (deger === null || deger === undefined) continue;
    if (!(await kolonVarMi(cariTablosu, kolon))) continue;
    const p = 'p' + sira++;
    kolonlar.push(`[${kolon}]`);
    degerler.push('@' + p);
    parametreler[p] = deger;
  }

  const r = await sorgu(
    `INSERT INTO ${cariTablosu} (${kolonlar.join(', ')})
     OUTPUT INSERTED.IND AS ind
     VALUES (${degerler.join(', ')})`,
    parametreler
  );
  const cariInd = Number(r[0] && r[0].ind);
  if (!cariInd) throw new Error('Cari kartı yazıldı ama kart numarası okunamadı.');

  return {
    tamam: true,
    cariInd,
    kod,
    ad,
    tip: tipAdi(firmaTipi),
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
      ${tipFiltresi} ${bakiyeFiltresi}
    ORDER BY ${adIfadesi}
  `);

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
  kartAlanlari,
  cariKartiAc,
  carileriListele,
  tipAdi
};
