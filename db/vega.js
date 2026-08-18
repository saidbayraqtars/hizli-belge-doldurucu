'use strict';

// VEGADB OKUMALARI — bu dosyada tek satır yazma yoktur.
//
// Formüller Vega'nın kendi ekranlarından çıkarılmış olanlardır:
//   Cari bakiye = SUM(BORC - ALACAK), 'KREDIHESABI' özel kodlu satırlar hariç.
//   Pozitif bakiye = cari BİZE borçlu.
//
// Eski sunucularda da çalışması gerektiği için (Windows 7 kurulumlarında SQL
// Server 2008 çıkabiliyor) TRY_CAST, OFFSET/FETCH ve benzeri 2012+ söz dizimi
// kullanılmaz; sıralama TOP ile, tip dönüşümü JavaScript tarafında yapılır.

const { sorgu } = require('./sql');
const { ayarOku } = require('./ayar');
const { dogrula, tablo, kart, tabloVarMi } = require('./firma');

function vt() {
  return ayarOku().vegaVeritabani;
}

// Vega'nın cari hareket açıklaması (IZAHAT) sayı taşıyan bir metin alanıdır.
const IZAHAT_ADI = {
  11: 'Cari Çıkış',
  13: 'Tahsilat',
  20: 'Alış Faturası',
  21: 'Satış Faturası',
  22: 'Alış İade',
  23: 'Satış İade',
  32: 'Stok Giriş Fişi',
  33: 'Stok Çıkış Fişi',
  83: 'Banka Girişi',
  84: 'Banka Çıkışı',
  103: 'Devir Girişi',
  104: 'Devir Çıkışı'
};

function izahatAdi(ham) {
  const no = Number(ham);
  if (Number.isFinite(no) && IZAHAT_ADI[no]) return IZAHAT_ADI[no];
  return String(ham == null ? '' : ham).trim() || '—';
}

// Müşteri veritabanları arasında alan farkı olabiliyor: DELETED bazı
// kurulumlarda hiç yok. Sorguyu kurmadan önce bir kez soruyoruz.
const kolonOnbellek = new Map();

async function kolonVarMi(tamTabloAdi, kolon) {
  const anahtar = tamTabloAdi + '.' + kolon;
  if (kolonOnbellek.has(anahtar)) return kolonOnbellek.get(anahtar);
  const bekleyen = (async () => {
    const r = await sorgu(
      `SELECT CASE WHEN COL_LENGTH(@tablo, @kolon) IS NULL THEN 0 ELSE 1 END AS varMi`,
      { tablo: tamTabloAdi, kolon }
    );
    const sonuc = !!(r[0] && Number(r[0].varMi) === 1);
    kolonOnbellek.set(anahtar, sonuc);
    return sonuc;
  })();
  kolonOnbellek.set(anahtar, bekleyen);
  return bekleyen;
}

// Silinmiş kayıt filtresi. Alan satırların neredeyse tamamında NULL olduğu için
// "DELETED = 0" yazmak listeyi boş döndürür — ISNULL şart.
async function silinmemis(tamTabloAdi, takmaAd) {
  if (await kolonVarMi(tamTabloAdi, 'DELETED')) {
    return `AND ISNULL(${takmaAd}.DELETED, 0) = 0`;
  }
  return '';
}

// --- Cari (müşteri) kartları -----------------------------------------------

async function carileriGetir(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const cariTablosu = kart(v, firma, 'TBLCARI');
  const hareketTablosu = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');
  const arama = String((secenek && secenek.arama) || '').trim();
  const limit = Math.min(Number((secenek && secenek.limit) || 300), 2000);

  const filtre = await silinmemis(cariTablosu, 'C');
  const aramaFiltresi = arama
    ? `AND (C.FIRMAADI LIKE @arama OR C.UNVAN LIKE @arama OR C.FIRMAKODU LIKE @arama)`
    : '';

  // FIRMAADI kartların bir kısmında NULL değil, BOŞ METİN. ISNULL boş metne
  // düşmediği için ad alanı boş kalıyordu ve adsız kartlar listenin başına
  // geçiyordu. NULLIF ile boş metni de NULL sayıp sıradaki alana geçiyoruz.
  const adIfadesi = `
    COALESCE(
      NULLIF(LTRIM(RTRIM(C.FIRMAADI)), ''),
      NULLIF(LTRIM(RTRIM(C.UNVAN)), ''),
      NULLIF(LTRIM(RTRIM(C.FIRMAKODU)), ''),
      '#' + CAST(C.IND AS NVARCHAR(20))
    )`;

  const satirlar = await sorgu(
    `
    SELECT TOP ${limit}
      C.IND AS cariInd,
      ISNULL(C.FIRMAKODU, '') AS kod,
      ${adIfadesi} AS ad,
      ISNULL(C.UNVAN, '') AS unvan,
      ISNULL(B.bakiye, 0) AS bakiye
    FROM ${cariTablosu} C
    LEFT JOIN (
      SELECT FIRMANO, SUM(ISNULL(BORC, 0) - ISNULL(ALACAK, 0)) AS bakiye
      FROM ${hareketTablosu}
      WHERE ISNULL(OZELKOD, '') <> 'KREDIHESABI'
      GROUP BY FIRMANO
    ) B ON B.FIRMANO = C.IND
    WHERE 1 = 1 ${filtre} ${aramaFiltresi}
    ORDER BY ${adIfadesi}
  `,
    arama ? { arama: '%' + arama + '%' } : null
  );

  return satirlar.map((s) => ({
    cariInd: Number(s.cariInd),
    kod: String(s.kod || '').trim(),
    ad: String(s.ad || '').trim(),
    unvan: String(s.unvan || '').trim(),
    bakiye: Number(s.bakiye) || 0
  }));
}

async function cariBakiye(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const r = await sorgu(
    `
    SELECT SUM(ISNULL(BORC, 0) - ISNULL(ALACAK, 0)) AS bakiye
    FROM ${tablo(v, firma, donem, 'TBLCARIHAREKETLERI')}
    WHERE FIRMANO = @cariInd AND ISNULL(OZELKOD, '') <> 'KREDIHESABI'
  `,
    { cariInd: Number(secenek.cariInd) }
  );
  return Number(r[0] && r[0].bakiye) || 0;
}

// --- Stok kartları ---------------------------------------------------------
//
// Fiyat kasten okunmuyor: sebze-meyve fiyatı günlük değişiyor, kullanıcı her
// satırda elle giriyor (videodaki ekranda da öyle). Karttan yalnızca ad, kod ve
// varsayılan birim geliyor.

async function stoklariGetir(secenek) {
  const { firma } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const stokTablosu = kart(v, firma, 'TBLSTOKLAR');
  const arama = String((secenek && secenek.arama) || '').trim();
  const limit = Math.min(Number((secenek && secenek.limit) || 300), 2000);

  const filtre = await silinmemis(stokTablosu, 'S');
  const aramaFiltresi = arama
    ? `AND (S.MALINCINSI LIKE @arama OR S.STOKKODU LIKE @arama)`
    : '';

  // Kartların bir kısmında MALINCINSI boş (bu veritabanında 1 kart: adı yok,
  // kodu "ŞALGAM ACILI 1 L"). Adı boş bırakmak o kartı listede görünmez ama
  // seçilebilir hale getiriyor ve sıralamada başa atıyor; koda düşüyoruz.
  const adIfadesi = `
    COALESCE(
      NULLIF(LTRIM(RTRIM(S.MALINCINSI)), ''),
      NULLIF(LTRIM(RTRIM(S.STOKKODU)), ''),
      '#' + CAST(S.IND AS NVARCHAR(20))
    )`;

  const satirlar = await sorgu(
    `
    SELECT TOP ${limit}
      S.IND AS stokNo,
      ISNULL(S.STOKKODU, '') AS kod,
      ${adIfadesi} AS ad,
      ISNULL(S.STOKTIPI, 0) AS stokTipi,
      ISNULL(S.KDVGRUBU, 0) AS kdvGrubu,
      ISNULL(B.BIRIMADI, '') AS birim,
      ISNULL(B.IND, 0) AS birimEx,
      ISNULL(B.CARPAN, 1) AS carpan
    FROM ${stokTablosu} S
    LEFT JOIN ${kart(v, firma, 'TBLBIRIMLEREX')} B
           ON B.STOKNO = S.IND AND B.VARSAYILAN = 1
    WHERE 1 = 1 ${filtre} ${aramaFiltresi}
    ORDER BY ${adIfadesi}
  `,
    arama ? { arama: '%' + arama + '%' } : null
  );

  return satirlar.map((s) => ({
    stokNo: Number(s.stokNo),
    kod: String(s.kod || '').trim(),
    ad: String(s.ad || '').trim(),
    stokTipi: Number(s.stokTipi) || 0,
    kdvGrubu: Number(s.kdvGrubu) || 0,
    birim: String(s.birim || '').trim(),
    birimEx: Number(s.birimEx) || 0,
    carpan: Number(s.carpan) || 1
  }));
}

// --- Cari ekstre (videodaki ikinci ekran) ----------------------------------
//
// Yürüyen bakiye Vega'nın yaptığı gibi kendi kendine JOIN ile değil, satırlar
// sıraya girdikten sonra JavaScript tarafında toplanıyor: aynı sonucu veriyor,
// büyük carilerde kat kat hızlı çalışıyor.
//
// AÇIKLAMA SÜTUNU: TBLCARIHAREKETLERI'nde açıklama alanı YOK (canlı şemada
// doğrulandı — 20 sütun, hiçbiri açıklama değil). "KASA TUTARI" gibi metinler
// belge BAŞLIĞINDA duruyor. Bu yüzden açıklamayı başlık tablolarından çekiyoruz:
// cari hareketin EVRAKNO'su başlığın BELGENO'suyla eşleşiyor.
//
// Eşleşme FIRMANO + BELGENO üzerinden kurulur ve başlıklar önce GROUP BY ile
// teke indirilir: EVRAKNO Vega'da global tekil değil, her fiş serisi kendi
// sayacını tutuyor. Düz JOIN aynı numaradan iki başlık bulursa ekstre satırını
// çiftler ve ekrandaki bakiye yanlış görünürdü.
// Her kaynak, yalnızca kendi belge tipindeki cari hareket satırına bağlanır.
// Sadece FIRMANO + BELGENO ile bağlanmak yetmiyor: EVRAKNO Vega'da global
// tekil değil, her fiş serisi kendi sayacını tutuyor — cari giriş ile cari
// çıkış aynı 'A' serisini kullandığı için aynı müşterinin iki farklı belgesi
// aynı numarayı taşıyabiliyor. IZAHAT ile daraltmazsak yanlış açıklama
// başka bir satıra yapışıyor.
const ACIKLAMA_KAYNAKLARI = [
  { tablo: 'TBLCARCIKBASLIK', alan: 'ACIKLAMA', izahatlar: ['11'] },
  { tablo: 'TBLCARGIRBASLIK', alan: 'ACIKLAMA', izahatlar: ['13'] },
  { tablo: 'TBLSATFATBASLIK', alan: 'ALTNOT', izahatlar: ['21'] }
];

// Bu üç alanın tipi NTEXT (canlı şemada doğrulandı). NTEXT kullanımdan kalkmış
// bir tip: LTRIM/RTRIM, MAX() ve GROUP BY hiçbiri üzerinde çalışmıyor, sorgu
// "Argument data type ntext is invalid" ile düşüyor. Bu yüzden okumadan önce
// NVARCHAR'a çeviriyoruz. 4000 karakter seçildi çünkü NVARCHAR(MAX) de MAX()
// aggregate'ine girmiyor; belge açıklamaları bu sınırın çok altında.
async function aciklamaBaglari(v, firma, donem) {
  const joinlar = [];
  const alanlar = [];
  let sira = 0;

  for (const kaynak of ACIKLAMA_KAYNAKLARI) {
    if (!(await tabloVarMi(firma, donem, kaynak.tablo))) continue;
    const ad = 'B' + sira++;
    const metin = `CAST(${kaynak.alan} AS NVARCHAR(4000))`;
    const izahatFiltresi = kaynak.izahatlar
      .map((k) => `'${k}'`)
      .join(', ');
    joinlar.push(`
      LEFT JOIN (
        SELECT FIRMANO, BELGENO, MAX(${metin}) AS aciklama
        FROM ${tablo(v, firma, donem, kaynak.tablo)}
        WHERE ${kaynak.alan} IS NOT NULL AND LTRIM(RTRIM(${metin})) <> ''
        GROUP BY FIRMANO, BELGENO
      ) ${ad} ON ${ad}.FIRMANO = H.FIRMANO
             AND ${ad}.BELGENO = H.EVRAKNO
             AND LTRIM(RTRIM(ISNULL(H.IZAHAT, ''))) IN (${izahatFiltresi})`);
    alanlar.push(`${ad}.aciklama`);
  }

  const ifade = alanlar.length ? `COALESCE(${alanlar.join(', ')}, '')` : `''`;
  return { joinlar: joinlar.join(''), aciklamaIfadesi: ifade };
}

async function cariEkstre(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const cariInd = Number(secenek.cariInd);
  if (!cariInd) throw new Error('Cari seçilmeli.');

  const limit = Math.min(Number(secenek.limit || 500), 5000);
  const parametreler = { cariInd };
  let tarihFiltresi = '';
  if (secenek.baslangic) {
    tarihFiltresi += ' AND TARIH >= @baslangic';
    parametreler.baslangic = new Date(secenek.baslangic);
  }
  if (secenek.bitis) {
    tarihFiltresi += ' AND TARIH <= @bitis';
    parametreler.bitis = new Date(secenek.bitis);
  }

  // Ekrandaki pencereden ÖNCEKİ bakiye — yürüyen toplam doğru yerden başlasın.
  let devir = 0;
  if (secenek.baslangic) {
    const d = await sorgu(
      `
      SELECT SUM(ISNULL(BORC, 0) - ISNULL(ALACAK, 0)) AS bakiye
      FROM ${tablo(v, firma, donem, 'TBLCARIHAREKETLERI')}
      WHERE FIRMANO = @cariInd AND ISNULL(OZELKOD, '') <> 'KREDIHESABI'
        AND TARIH < @baslangic
    `,
      { cariInd, baslangic: new Date(secenek.baslangic) }
    );
    devir = Number(d[0] && d[0].bakiye) || 0;
  }

  const { joinlar, aciklamaIfadesi } = await aciklamaBaglari(v, firma, donem);

  const satirlar = await sorgu(
    `
    SELECT TOP ${limit}
      H.IND AS ind,
      H.TARIH AS tarih,
      ISNULL(H.IZAHAT, '') AS izahat,
      ISNULL(H.EVRAKNO, '') AS evrakNo,
      ${aciklamaIfadesi} AS aciklama,
      ISNULL(H.BORC, 0) AS borc,
      ISNULL(H.ALACAK, 0) AS alacak
    FROM ${tablo(v, firma, donem, 'TBLCARIHAREKETLERI')} H
    ${joinlar}
    WHERE H.FIRMANO = @cariInd AND ISNULL(H.OZELKOD, '') <> 'KREDIHESABI'
      ${tarihFiltresi.replace(/TARIH/g, 'H.TARIH')}
    ORDER BY H.TARIH, H.IND
  `,
    parametreler
  );

  let yuruyen = devir;
  const sonuc = satirlar.map((s) => {
    const borc = Number(s.borc) || 0;
    const alacak = Number(s.alacak) || 0;
    yuruyen += borc - alacak;
    return {
      ind: Number(s.ind),
      tarih: s.tarih,
      izahat: String(s.izahat || '').trim(),
      izahatAdi: izahatAdi(s.izahat),
      evrakNo: String(s.evrakNo || '').trim(),
      aciklama: String(s.aciklama || '').trim(),
      borc,
      alacak,
      bakiye: yuruyen
    };
  });

  return { devir, satirlar: sonuc, sonBakiye: yuruyen };
}

module.exports = {
  carileriGetir,
  cariBakiye,
  stoklariGetir,
  cariEkstre,
  izahatAdi,
  kolonVarMi
};
