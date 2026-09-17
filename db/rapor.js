'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  RAPORLAR
// ═══════════════════════════════════════════════════════════════════════════
//
// Eski Access programının iki çıktısı buraya taşındı. 27.08.2026'da ikisi
// ayrı ekranlara bölündü (kullanıcı isteği): özet "Haftalık Rapor"
// sekmesinde, fiş bazlı ayrıntı "Ekstre" sekmesinde.
//
//   1. "GENEL MÜŞTERİYE GÖRE KALAN" (haftalikOzet) — çok müşterili borç dökümü
//      Tarih | ADI_SOYADI | ESKİ BORÇ | KASA | YENİ BORÇ | TOP.BAKİYE
//      Ayrıntı yok: "ne kadar almış, ne kadar vermiş, borcu ne" tek satır.
//
//   2. Müşteri dönem dökümü (haftalikDetay) — Ekstre ekranındaki ayrıntılı rapor
//      CİNSİ | K.ADET | K.TÜRÜ | K.TUTAR | SAFİ KG | FİYAT | TUTAR |
//      AÇIKLAMA | FİŞ NO. Kasa her ürün satırında kendi adediyle durur; fişin
//      türe göre kasa toplamı ara toplam satırında (17.09.2026).
//      + DEVİR, KASA ÖZETİ, S.TUTARI, ÖDEME bloğu, BAKİYE
//      05.09.2026 (kullanıcı isteği): satılan ürünün SAFİ KG'ı (dara düşülmüş
//      kilo) FİYAT'ın önüne sütun olarak kondu. Ayrı "Verilen Kasalar" bloğu
//      kaldırıldı — kasa zaten satırlarda ve özet kalemlerinde duruyordu.
//
// SÜTUNLARIN TANIMI — eski programın gerçek çıktısıyla doğrulandı
// (AHMET TAMALLIOĞLU: 348.451,20 + 1.300,00 + 21.243,00 = 370.994,20):
//
//   ESKİ BORÇ  = hafta başından önceki bakiye − hafta içinde alınan ödeme
//   KASA       = hafta içindeki kasa/kap depozito tutarı
//   YENİ BORÇ  = hafta içindeki ürün borcu (kasa hariç)
//   TOP.BAKİYE = üçünün toplamı — Vega'daki gerçek hafta sonu bakiyesine eşit
//
// Bu yüzden TOP.BAKİYE doğrudan TBLCARIHAREKETLERI'nden hesaplanıyor ve ESKİ
// BORÇ ondan geriye doğru çıkarılıyor: satır her zaman tam toplanır ve Vega'nın
// kendi bakiyesiyle birebir tutar.

const { sorgu } = require('./sql');
const { ayarOku } = require('./ayar');
const { dogrula, tablo, kart, tabloVarMi } = require('./firma');
const { izahatAdi, aciklamaBaglari, musteriTipiFiltresi } = require('./vega');

function vt() {
  return ayarOku().vegaVeritabani;
}

function odemeAciklamasi(satir) {
  const parcalar = [
    izahatAdi(satir.izahat),
    satir.belgeAciklama,
    satir.evrakNo
  ].map((deger) => String(deger || '').trim()).filter(Boolean);
  return parcalar.filter((deger, sira) =>
    parcalar.findIndex((diger) => diger.toLocaleUpperCase('tr-TR') === deger.toLocaleUpperCase('tr-TR')) === sira
  ).join(' · ');
}

// --- Hafta hesabı ------------------------------------------------------------
//
// Kullanıcı isteği: hafta PAZAR günü başlar, CUMARTESİ biter ("pazardan
// pazara"). Sınır tek yerde tanımlı olsun diye arayüz de bu hesabı ana
// süreçten okuyor — iki tarafta ayrı ayrı gün sayma yapılmıyor.
const HAFTA_BASI = 0; // 0 = Pazar (JS getDay)

function gunBasi(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
}

function haftaAraligi(tarih) {
  const g = gunBasi(tarih || Date.now());
  const fark = (g.getDay() - HAFTA_BASI + 7) % 7;
  const baslangic = new Date(g);
  baslangic.setDate(g.getDate() - fark);
  const bitis = new Date(baslangic);
  bitis.setDate(baslangic.getDate() + 6);
  // Sorgularda "< ertesi" kullanılıyor: saat taşıyan kayıtlar (GETDATE ile
  // yazılan cari hareketler) son günün dışında kalmasın.
  const ertesi = new Date(baslangic);
  ertesi.setDate(baslangic.getDate() + 7);
  return { baslangic, bitis, ertesi };
}

// Arayüzden "2026-08-23" gibi bir metin gelebilir; o günü içeren haftayı verir.
function araligiCoz(secenek) {
  if (secenek && secenek.baslangic && secenek.bitis) {
    const baslangic = gunBasi(secenek.baslangic);
    const bitis = gunBasi(secenek.bitis);
    const ertesi = new Date(bitis);
    ertesi.setDate(bitis.getDate() + 1);
    return { baslangic, bitis, ertesi };
  }
  return haftaAraligi(secenek && secenek.tarih);
}

const AD_IFADESI = `
  COALESCE(
    NULLIF(LTRIM(RTRIM(C.FIRMAADI)), ''),
    NULLIF(LTRIM(RTRIM(C.UNVAN)), ''),
    NULLIF(LTRIM(RTRIM(C.FIRMAKODU)), ''),
    '#' + CAST(C.IND AS NVARCHAR(20))
  )`;

// --- 1. Müşteriye göre kalan (haftalık genel tablo) --------------------------

async function haftalikOzet(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const { baslangic, bitis, ertesi } = araligiCoz(secenek);
  const cariTablosu = kart(v, firma, 'TBLCARI');
  const hareketTablosu = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');

  // Alıcı/satıcı süzgeci — "müşteriye göre kalan" raporunda tedarikçi
  // görünmesin diye. Boş bırakılırsa hepsi gelir.
  let tipFiltresi = '';
  if (secenek && secenek.tip === 'alici') tipFiltresi = 'AND (ISNULL(C.FIRMATIPI, 0) & 1) = 1';
  if (secenek && secenek.tip === 'satici') tipFiltresi = 'AND (ISNULL(C.FIRMATIPI, 0) & 2) = 2';

  // Özel Kod 1 süzgeci — belge ekranındaki ile aynı alan (cari kartında
  // Özel Kod 1 / KOD1). Kurulumda sütun yoksa süzgeç sessizce uygulanmaz.
  const parametreler = { bas: baslangic, ertesi };
  const musteriTipi = await musteriTipiFiltresi(
    cariTablosu, secenek && secenek.musteriTipi, 'C', parametreler
  );

  const satirlar = await sorgu(
    `
    SELECT
      C.IND                     AS cariInd,
      ISNULL(C.FIRMAKODU, '')   AS kod,
      ${AD_IFADESI}             AS ad,
      ISNULL(H.oncekiBakiye, 0) AS oncekiBakiye,
      ISNULL(H.haftaBorc, 0)    AS haftaBorc,
      ISNULL(H.haftaAlacak, 0)  AS haftaAlacak
    FROM ${cariTablosu} C
    LEFT JOIN (
      SELECT FIRMANO,
        SUM(CASE WHEN TARIH <  @bas THEN ISNULL(BORC, 0) - ISNULL(ALACAK, 0) ELSE 0 END) AS oncekiBakiye,
        SUM(CASE WHEN TARIH >= @bas THEN ISNULL(BORC, 0)   ELSE 0 END) AS haftaBorc,
        SUM(CASE WHEN TARIH >= @bas THEN ISNULL(ALACAK, 0) ELSE 0 END) AS haftaAlacak
      FROM ${hareketTablosu}
      WHERE ISNULL(OZELKOD, '') <> 'KREDIHESABI' AND TARIH < @ertesi
      GROUP BY FIRMANO
    ) H ON H.FIRMANO = C.IND
    WHERE ISNULL(C.DELETED, 0) = 0
      AND ISNULL(C.STATUS, 1) <> 2
      AND C.IND >= 100
      ${tipFiltresi} ${musteriTipi}
    ORDER BY ${AD_IFADESI}
  `,
    parametreler
  );

  // KASA sütunu: Vega'nın cari hareketinde ürün ve kasa TEK borç satırı olarak
  // duruyor, ayrışmıyor. İki kaynaktan toplanıyor — ikisi de haftalikDetay'ın
  // kullandığı kaynakların aynısı, iki rapor birbirini tutsun diye:
  //   1. Programın kendi satır günlüğü (BD_BelgeSatir) — asıl kaynak.
  //   2. Doğrudan VegaWin'den kesilmiş satış faturalarındaki KASA kalemleri —
  //      günlükte olmayan belgeler için (o belgeleri bu program yazmadı).
  // Faturasız (cari dekont) belgelerde Vega tarafında kasa kalemi ayrı bir
  // satır olarak durmuyor; onlar yalnızca günlükten gelir.
  //
  // Tutarın yanında ADET ve TÜR de toplanıyor: kullanıcı çıktıda "kaç kasa,
  // hangi türden, kaç TL" bilgisini ayrı ayrı istiyor (27.08.2026) — önceden
  // yalnızca toplam tutar vardı.
  const kasaHaftalik = new Map();
  const kasaEkle = (cariInd, tur, adet, tutar) => {
    const no = Number(cariInd);
    if (!kasaHaftalik.has(no)) kasaHaftalik.set(no, { tutar: 0, adet: 0, turler: new Map() });
    const k = kasaHaftalik.get(no);
    k.tutar += Number(tutar) || 0;
    k.adet += Number(adet) || 0;
    const kod = String(tur || '').trim();
    if (kod && Number(adet)) k.turler.set(kod, (k.turler.get(kod) || 0) + Number(adet));
  };

  const gunlukKasa = await sorgu(
    `SELECT CariInd, ISNULL(KasaTipiKod, '') AS tur,
            SUM(KasaAdedi) AS adet, SUM(KasaTutari) AS kasa
     FROM [${v}].dbo.BD_BelgeSatir
     WHERE Firma = @firma AND GeriAlindi = 0 AND Tarih >= @bas AND Tarih <= @bitis
     GROUP BY CariInd, ISNULL(KasaTipiKod, '')`,
    { firma, bas: baslangic, bitis }
  );
  for (const s of gunlukKasa) kasaEkle(s.CariInd, s.tur, s.adet, s.kasa);

  if (await tabloVarMi(firma, donem, 'TBLSATFATBASLIK') &&
      await tabloVarMi(firma, donem, 'TBLSATFATHAREKET')) {
    const faturaKasa = await sorgu(
      // MALINCINSI bazı kurulumlarda metin (TEXT) tipinde olabiliyor; GROUP BY
      // metin sütunu kabul etmediği için NVARCHAR'a çevriliyor.
      `SELECT B.FIRMANO AS cariInd,
              CAST(ISNULL(H.MALINCINSI, ISNULL(H.STOKKODU, '')) AS NVARCHAR(250)) AS tur,
              SUM(ISNULL(H.MIKTAR, 0)) AS adet,
              SUM(ISNULL(H.GERCEKTOPLAM, 0)) AS kasa
       FROM ${tablo(v, firma, donem, 'TBLSATFATBASLIK')} B
       JOIN ${tablo(v, firma, donem, 'TBLSATFATHAREKET')} H ON H.EVRAKNO = B.IND
       WHERE B.TARIH >= @bas AND B.TARIH < @ertesi AND ISNULL(B.IPTAL, 0) = 0
         AND CAST(H.ACIKLAMA AS NVARCHAR(60)) = 'KASA'
         AND NOT EXISTS (
           SELECT 1 FROM [${v}].dbo.BD_BelgeSatir G
           WHERE G.Firma = @firma AND G.GeriAlindi = 0 AND G.BelgeNo = B.BELGENO
         )
       GROUP BY B.FIRMANO, CAST(ISNULL(H.MALINCINSI, ISNULL(H.STOKKODU, '')) AS NVARCHAR(250))`,
      { firma, bas: baslangic, ertesi }
    );
    for (const s of faturaKasa) kasaEkle(s.cariInd, s.tur, s.adet, s.kasa);
  }

  // SAFİ KG sütunu — hafta içinde satılan ürünün net (dara düşülmüş) kilosu.
  // Kaynaklar KASA sütunuyla aynı: önce programın günlüğü (BD_BelgeSatir.
  // DaraliMiktar = brüt − dara), sonra günlükte olmayan Vega faturalarının
  // ürün kalemleri (KASA açıklamalı satırlar hariç; onlar kilo değil).
  const kiloHaftalik = new Map();
  const kiloEkle = (cariInd, kg) => {
    const no = Number(cariInd);
    kiloHaftalik.set(no, (kiloHaftalik.get(no) || 0) + (Number(kg) || 0));
  };

  const gunlukKilo = await sorgu(
    `SELECT CariInd, SUM(ISNULL(DaraliMiktar, 0)) AS kg
     FROM [${v}].dbo.BD_BelgeSatir
     WHERE Firma = @firma AND GeriAlindi = 0 AND Tarih >= @bas AND Tarih <= @bitis
     GROUP BY CariInd`,
    { firma, bas: baslangic, bitis }
  );
  for (const s of gunlukKilo) kiloEkle(s.CariInd, s.kg);

  if (await tabloVarMi(firma, donem, 'TBLSATFATBASLIK') &&
      await tabloVarMi(firma, donem, 'TBLSATFATHAREKET')) {
    const faturaKilo = await sorgu(
      `SELECT B.FIRMANO AS cariInd, SUM(ISNULL(H.MIKTAR, 0)) AS kg
       FROM ${tablo(v, firma, donem, 'TBLSATFATBASLIK')} B
       JOIN ${tablo(v, firma, donem, 'TBLSATFATHAREKET')} H ON H.EVRAKNO = B.IND
       WHERE B.TARIH >= @bas AND B.TARIH < @ertesi AND ISNULL(B.IPTAL, 0) = 0
         AND CAST(H.ACIKLAMA AS NVARCHAR(60)) <> 'KASA'
         AND NOT EXISTS (
           SELECT 1 FROM [${v}].dbo.BD_BelgeSatir G
           WHERE G.Firma = @firma AND G.GeriAlindi = 0 AND G.BelgeNo = B.BELGENO
         )
       GROUP BY B.FIRMANO`,
      { firma, bas: baslangic, ertesi }
    );
    for (const s of faturaKilo) kiloEkle(s.cariInd, s.kg);
  }

  const sonuc = [];
  let toplam = { eskiBorc: 0, kasaAdedi: 0, kasa: 0, safiKg: 0, yeniBorc: 0, odeme: 0, topBakiye: 0 };

  for (const s of satirlar) {
    const oncekiBakiye = Number(s.oncekiBakiye) || 0;
    const haftaBorc = Number(s.haftaBorc) || 0;
    const haftaAlacak = Number(s.haftaAlacak) || 0;
    const k = kasaHaftalik.get(Number(s.cariInd)) || { tutar: 0, adet: 0, turler: new Map() };
    const kasa = k.tutar;
    const safiKg = kiloHaftalik.get(Number(s.cariInd)) || 0;

    const eskiBorc = oncekiBakiye - haftaAlacak;
    const yeniBorc = haftaBorc - kasa;
    const topBakiye = eskiBorc + kasa + yeniBorc;

    // Hem bakiyesi hem hafta hareketi sıfır olan kart raporu şişirmesin.
    if (!topBakiye && !haftaBorc && !haftaAlacak) continue;

    sonuc.push({
      cariInd: Number(s.cariInd),
      kod: String(s.kod || '').trim(),
      ad: String(s.ad || '').trim(),
      eskiBorc, kasa, yeniBorc, topBakiye, safiKg,
      kasaAdedi: k.adet,
      kasaTurleri: [...k.turler.entries()].map(([tur, adet]) => ({ tur, adet })),
      odeme: haftaAlacak
    });
    toplam.eskiBorc += eskiBorc;
    toplam.kasaAdedi += k.adet;
    toplam.kasa += kasa;
    toplam.safiKg += safiKg;
    toplam.yeniBorc += yeniBorc;
    toplam.odeme += haftaAlacak;
    toplam.topBakiye += topBakiye;
  }

  return { baslangic, bitis, satirlar: sonuc, toplam };
}

// --- 2. Müşteri hafta dökümü -------------------------------------------------

async function cariBasligi(v, firma, cariInd) {
  const r = await sorgu(
    `SELECT TOP 1
       C.IND AS cariInd,
       ISNULL(C.FIRMAKODU, '') AS kod,
       ${AD_IFADESI} AS ad,
       COALESCE(NULLIF(LTRIM(RTRIM(C.SEHIR)), ''),
                NULLIF(LTRIM(RTRIM(CAST(C.ADRESPOSTA AS NVARCHAR(200)))), ''),
                '') AS adres,
       COALESCE(NULLIF(LTRIM(RTRIM(C.TELEFON1)), ''),
                NULLIF(LTRIM(RTRIM(C.TELEFON2)), ''),
                '') AS telefon,
       ISNULL(C.UNVAN, '') AS not1
     FROM ${kart(v, firma, 'TBLCARI')} C
     WHERE C.IND = @cariInd`,
    { cariInd: Number(cariInd) }
  );
  const c = r[0] || {};
  return {
    cariInd: Number(cariInd),
    kod: String(c.kod || '').trim(),
    ad: String(c.ad || '').trim(),
    adres: String(c.adres || '').trim(),
    telefon: String(c.telefon || '').trim(),
    not: String(c.not1 || '').trim()
  };
}

// Programın kendi satır günlüğü — asıl kaynak.
async function gunlukSatirlari(v, firma, cariInd, baslangic, bitis) {
  const r = await sorgu(
    `SELECT Id, Tarih, BelgeNo, ISNULL(FisNo, '') AS FisNo, SiraNo,
            ISNULL(StokAdi, ISNULL(StokKodu, ISNULL(KasaTipiKod, ''))) AS Cinsi,
            KasaAdedi, ISNULL(KasaTipiKod, '') AS KasaTipiKod, KasaTutari,
            DaraliMiktar, Fiyat, Tutar, ISNULL(Aciklama, '') AS Aciklama
     FROM [${v}].dbo.BD_BelgeSatir
     WHERE Firma = @firma AND CariInd = @cariInd AND GeriAlindi = 0
       AND Tarih >= @bas AND Tarih <= @bitis
     ORDER BY Tarih, FisNo, SiraNo, Id`,
    { firma, cariInd: Number(cariInd), bas: baslangic, bitis }
  );
  return r.map((s) => ({
    kaynak: 'gunluk',
    tarih: s.Tarih,
    belgeNo: String(s.BelgeNo || '').trim(),
    // Eski/elle yazılmış günlüklerde FisNo boş olabiliyor; raporun fişsiz
    // görünmemesi için o durumda Vega belge numarasına düş.
    fisNo: fisNoCoz(s.FisNo, s.BelgeNo),
    cinsi: String(s.Cinsi || '').trim(),
    kasaAdedi: Number(s.KasaAdedi) || 0,
    kasaTipiKod: String(s.KasaTipiKod || '').trim(),
    kasaTutari: Number(s.KasaTutari) || 0,
    netKg: Number(s.DaraliMiktar) || 0,
    fiyat: Number(s.Fiyat) || 0,
    tutar: Number(s.Tutar) || 0,
    aciklama: String(s.Aciklama || '').trim()
  }));
}

function fisNoCoz(fisNo, belgeNo) {
  return String(fisNo || belgeNo || '').trim();
}

// Doğrudan VegaWin ekranından kesilmiş satış faturaları — bu programın
// günlüğünde olmayan belgeler. Günlükte zaten olan BELGENO'lar atlanıyor ki
// aynı satır iki kez görünmesin.
async function faturaSatirlari(v, firma, donem, cariInd, baslangic, ertesi, bilinenBelgeNolar) {
  if (!(await tabloVarMi(firma, donem, 'TBLSATFATBASLIK'))) return [];
  if (!(await tabloVarMi(firma, donem, 'TBLSATFATHAREKET'))) return [];

  // Satır başlığa BELGENO ile değil, başlığın IND'i ile bağlı
  // (TBLSATFATHAREKET.EVRAKNO = TBLSATFATBASLIK.IND) — canlı veriyle
  // doğrulandı. Ürün adı MALINCINSI, tutar GERCEKTOPLAM.
  const r = await sorgu(
    `SELECT B.BELGENO AS belgeNo, B.TARIH AS tarih, H.IND AS ind,
            ISNULL(H.MALINCINSI, ISNULL(H.STOKKODU, '')) AS cinsi,
            ISNULL(H.MIKTAR, 0) AS miktar,
            ISNULL(H.FIYATI, 0) AS fiyat,
            ISNULL(H.GERCEKTOPLAM, 0) AS tutar,
            ISNULL(CAST(H.ACIKLAMA AS NVARCHAR(250)), '') AS aciklama,
            ISNULL(CAST(B.ALTNOT AS NVARCHAR(250)), '') AS altnot
     FROM ${tablo(v, firma, donem, 'TBLSATFATBASLIK')} B
     JOIN ${tablo(v, firma, donem, 'TBLSATFATHAREKET')} H ON H.EVRAKNO = B.IND
     WHERE B.FIRMANO = @cariInd AND B.TARIH >= @bas AND B.TARIH < @ertesi
       AND ISNULL(B.IPTAL, 0) = 0
     ORDER BY B.TARIH, B.IND, H.IND`,
    { cariInd: Number(cariInd), bas: baslangic, ertesi }
  );

  return r
    .filter((s) => !bilinenBelgeNolar.has(String(s.belgeNo || '').trim()))
    .map((s) => {
      // "Hizli Belge Doldurucu - fis 02065" ya da elle yazılmış bir not.
      const eslesme = /fis\s+(\S+)/i.exec(String(s.altnot || ''));
      const aciklama = String(s.aciklama || '').trim();
      const kasaSatiri = aciklama.toUpperCase() === 'KASA';
      const miktar = Number(s.miktar) || 0;
      const tutar = Number(s.tutar) || 0;
      return {
        kaynak: 'vega',
        tarih: s.tarih,
        belgeNo: String(s.belgeNo || '').trim(),
        fisNo: eslesme ? eslesme[1] : String(s.belgeNo || '').trim(),
        cinsi: String(s.cinsi || '').trim(),
        kasaAdedi: kasaSatiri ? miktar : 0,
        kasaTipiKod: kasaSatiri ? String(s.cinsi || '').trim() : '',
        kasaTutari: kasaSatiri ? tutar : 0,
        netKg: kasaSatiri ? 0 : miktar,
        fiyat: Number(s.fiyat) || 0,
        tutar: kasaSatiri ? 0 : tutar,
        aciklama
      };
    });
}

// Fiş no'ya göre grupla: her fişin sonunda ara toplam, en altta genel toplam.
// (Kullanıcı isteği: "fiş sırası bitince sonunda boşluk bıraksın, o seriyi
// toplasın, sonra öyle öyle devam etsin.")
function fislereBol(satirlar) {
  const gruplar = [];
  let simdiki = null;

  for (const s of satirlar) {
    const anahtar = s.fisNo || '—';
    if (!simdiki || simdiki.fisNo !== anahtar) {
      simdiki = {
        fisNo: anahtar,
        satirlar: [],
        araToplam: { kasaAdedi: 0, kasaTutari: 0, netKg: 0, tutar: 0 }
      };
      gruplar.push(simdiki);
    }
    simdiki.satirlar.push(s);
    simdiki.araToplam.kasaAdedi += s.kasaAdedi;
    simdiki.araToplam.kasaTutari += s.kasaTutari;
    simdiki.araToplam.netKg += s.netKg;
    simdiki.araToplam.tutar += s.tutar;
  }

  for (const grup of gruplar) {
    grup.kasaTurleri = kasaTurleriniTopla(grup.satirlar);
  }
  return gruplar;
}

function kasaTuruAnahtari(tur) {
  return String(tur || '—').trim().toLocaleUpperCase('tr-TR') || '—';
}

// Bir fişte aynı kasa türü birden çok ürün satırında tekrar edebilir. Çıktıda
// her türü tek kez göstermek için adet ve tutarı fiş içinde birleştir.
function kasaTurleriniTopla(satirlar) {
  const toplamlar = new Map();
  for (const s of satirlar || []) {
    const adet = Number(s.kasaAdedi) || 0;
    const tutar = Number(s.kasaTutari) || 0;
    if (!adet && !tutar) continue;
    const tur = String(s.kasaTipiKod || '').trim() || '—';
    const anahtar = kasaTuruAnahtari(tur);
    if (!toplamlar.has(anahtar)) toplamlar.set(anahtar, { anahtar, tur, adet: 0, tutar: 0 });
    const toplam = toplamlar.get(anahtar);
    toplam.adet += adet;
    toplam.tutar += tutar;
  }
  return [...toplamlar.values()];
}

async function haftalikDetay(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const cariInd = Number(secenek.cariInd);
  if (!cariInd) throw new Error('Müşteri seçilmeli.');

  const v = vt();
  const { baslangic, bitis, ertesi } = araligiCoz(secenek);
  const hareketTablosu = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');

  const bilgi = await cariBasligi(v, firma, cariInd);

  // DEVİR — hafta başından önceki bakiye. Aynı sorgu hafta içi borç/alacağı da
  // veriyor: rapordaki BAKİYE, satır toplamlarından değil Vega'nın kendi
  // hareketlerinden çıkıyor (KDV'li fatura, VegaWin'den elle girilmiş belge
  // gibi durumlarda ikisi ayrışabilir — doğru olan Vega'nınki).
  const d = await sorgu(
    `SELECT
       ISNULL(SUM(CASE WHEN TARIH <  @bas THEN ISNULL(BORC, 0) - ISNULL(ALACAK, 0) ELSE 0 END), 0) AS devir,
       ISNULL(SUM(CASE WHEN TARIH >= @bas THEN ISNULL(BORC, 0)   ELSE 0 END), 0) AS haftaBorc,
       ISNULL(SUM(CASE WHEN TARIH >= @bas THEN ISNULL(ALACAK, 0) ELSE 0 END), 0) AS haftaAlacak
     FROM ${hareketTablosu}
     WHERE FIRMANO = @cariInd AND ISNULL(OZELKOD, '') <> 'KREDIHESABI' AND TARIH < @ertesi`,
    { cariInd, bas: baslangic, ertesi }
  );
  const devir = Number(d[0] && d[0].devir) || 0;
  const haftaBorc = Number(d[0] && d[0].haftaBorc) || 0;
  const haftaAlacak = Number(d[0] && d[0].haftaAlacak) || 0;

  const gunluk = await gunlukSatirlari(v, firma, cariInd, baslangic, bitis);
  const bilinen = new Set(gunluk.map((s) => s.belgeNo).filter(Boolean));
  const vegadan = await faturaSatirlari(v, firma, donem, cariInd, baslangic, ertesi, bilinen);

  const tumSatirlar = gunluk.concat(vegadan);
  tumSatirlar.sort((a, b) => {
    const t = new Date(a.tarih) - new Date(b.tarih);
    if (t) return t;
    return String(a.fisNo).localeCompare(String(b.fisNo), 'tr');
  });

  const gruplar = fislereBol(tumSatirlar);

  const kasaTutari = tumSatirlar.reduce((t, s) => t + s.kasaTutari, 0);
  const urunTutari = tumSatirlar.reduce((t, s) => t + s.tutar, 0);
  // SAFİ KG — dara düşülmüş satış kilosu (05.09.2026 kullanıcı isteğiyle
  // çıktıya geri kondu, kasa sütunlarının yerine).
  const safiKg = tumSatirlar.reduce((t, s) => t + s.netKg, 0);

  // Verilen kasaların türe göre özeti — kullanıcı çıktıda "kasa sayısı, kasa
  // türü, kasa toplam tutarı"nı ayrıca istiyor (27.08.2026). Satırların
  // kendisinden toplanıyor; böylece hem program günlüğünden hem doğrudan
  // Vega'dan gelen belgeler aynı blokta görünüyor.
  const kasaTurMap = new Map();
  for (const s of tumSatirlar) {
    if (!s.kasaAdedi && !s.kasaTutari) continue;
    const tur = s.kasaTipiKod || '—';
    if (!kasaTurMap.has(tur)) kasaTurMap.set(tur, { tur, adet: 0, tutar: 0 });
    const k = kasaTurMap.get(tur);
    k.adet += s.kasaAdedi;
    k.tutar += s.kasaTutari;
  }
  const kasaVerilenleri = [...kasaTurMap.values()];
  const kasaAdedi = kasaVerilenleri.reduce((t, k) => t + k.adet, 0);

  // ÖDEME bloğu — hafta içindeki bütün ALACAK hareketleri (tahsilat, kasa
  // iadesi, satış iadesi). Raporun "ALINAN" sütunu bu.
  // Belge Gir ekranındaki Tahsilat Belge Açıklaması cari hareket satırında
  // değil, TBLCARGIRBASLIK.ACIKLAMA alanında durur. Normal Ekstre ile aynı
  // başlık bağlarını kullanarak ayrıntılı raporun açıklama sütununa da taşırız.
  const { joinlar: aciklamaJoinlari, aciklamaIfadesi } =
    await aciklamaBaglari(v, firma, donem);
  const o = await sorgu(
    `SELECT H.TARIH AS tarih, ISNULL(H.IZAHAT, '') AS izahat,
            ISNULL(H.EVRAKNO, '') AS evrakNo,
            ${aciklamaIfadesi} AS belgeAciklama,
            ISNULL(H.ALACAK, 0) AS alacak
     FROM ${hareketTablosu} H
     ${aciklamaJoinlari}
     WHERE H.FIRMANO = @cariInd AND ISNULL(H.OZELKOD, '') <> 'KREDIHESABI'
       AND H.TARIH >= @bas AND H.TARIH < @ertesi AND ISNULL(H.ALACAK, 0) <> 0
     ORDER BY H.TARIH, H.IND`,
    { cariInd, bas: baslangic, ertesi }
  );
  const odemeler = o.map((s) => ({
    tarih: s.tarih,
    alinan: Number(s.alacak) || 0,
    aciklama: odemeAciklamasi(s)
  }));
  const odemeToplam = odemeler.reduce((t, s) => t + s.alinan, 0);

  // Geri gelen kasalar — raporun "K SAYISI / K TÜRÜ / K TUTARI" bloğu.
  const k = await sorgu(
    `SELECT ISNULL(StokKodu, ISNULL(StokAdi, '')) AS tur,
            SUM(-Adet) AS adet, SUM(-Tutar) AS tutar
     FROM [${v}].dbo.BD_KasaHareket
     WHERE Firma = @firma AND CariInd = @cariInd AND Yon = 'iade'
       AND Tarih >= @bas AND Tarih <= @bitis
     GROUP BY ISNULL(StokKodu, ISNULL(StokAdi, ''))
     HAVING SUM(-Adet) <> 0`,
    { firma, cariInd, bas: baslangic, bitis }
  );
  const kasaIadeleri = k.map((s) => ({
    tur: String(s.tur || '').trim(),
    adet: Number(s.adet) || 0,
    tutar: Number(s.tutar) || 0
  }));

  return {
    baslangic, bitis,
    cari: bilgi,
    devir,
    gruplar,
    satirSayisi: tumSatirlar.length,
    kasaTutari,
    kasaAdedi,
    safiKg,
    kasaVerilenleri,
    urunTutari,
    toplam: urunTutari + kasaTutari,
    odemeler,
    odemeToplam,
    kasaIadeleri,
    haftaBorc,
    haftaAlacak,
    bakiye: devir + haftaBorc - haftaAlacak
  };
}

// --- 3. Ödeme geçmişi ----------------------------------------------------------
//
// 17.09.2026 kullanıcı isteği: müşterinin ödeme geçmişi ayrı sayfada, yöntemi
// (nakit / havale / EFT) ve açıklamasıyla, yazdırılabilir.
//
// Kaynak Vega'nın kendi defteri — programdan girilmemiş ödemeler de gelir:
//   IZAHAT 13 (Cari Giriş) ALACAK satırları: yöntem, başlığa (LN) bağlı
//     TBLCARGIRHAREKET satırlarının ödeme aracından (1 nakit, 11 banka,
//     2 çek, 3 senet, 4 kredi kartı). Banka satırında Havale/EFT ayrımı satır
//     açıklamasından okunur ("HAVALE" / "EFT" — bkz. yazma.js → odemeYaz).
//   IZAHAT 83: bankadan girilmiş havale.
// Mal satışını cari giriş olarak yazan dekont BORÇ taşıdığı için dışarıda kalır.
const ODEME_YONTEM_ADI = {
  nakit: 'Nakit (Kasa)',
  havale: 'Havale',
  eft: 'EFT',
  banka: 'Banka',
  kart: 'Kredi Kartı',
  cek: 'Çek',
  senet: 'Senet',
  diger: 'Belirtilmemiş'
};

function odemeYontemiCoz(izahat, odemeAraci, satirAciklamasi) {
  if (String(izahat == null ? '' : izahat).trim() === '83') return 'havale';
  const metin = String(satirAciklamasi || '').trim().toLocaleUpperCase('tr-TR');
  switch (Number(odemeAraci)) {
    case 1: return 'nakit';
    case 2: return 'cek';
    case 3: return 'senet';
    case 4: return 'kart';
    case 11:
      if (/^EFT\b/.test(metin)) return 'eft';
      if (/HAVALE/.test(metin)) return 'havale';
      if (/KRED[İI]/.test(metin)) return 'kart';
      return 'banka';
    default: return 'diger';
  }
}

// "HAVALE - 7 Eylül" gibi program açıklamasının başındaki yöntem adı, yöntem
// sütununda zaten yazdığı için tekrarlanmaz.
function odemeNotu(baslik, satir) {
  const temiz = (m) => String(m || '').trim()
    .replace(/^(NAK[İI]T|HAVALE|EFT)\s*(-\s*|tahsilat\s*$|$)/i, '')
    .trim();
  const parcalar = [temiz(baslik), temiz(satir)].filter(Boolean);
  const tekil = parcalar.filter((p, i) =>
    parcalar.findIndex((d) => d.toLocaleUpperCase('tr-TR') === p.toLocaleUpperCase('tr-TR')) === i);
  return tekil.join(' · ');
}

async function odemeGecmisi(secenek) {
  const { firma, donem } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const hareketTablosu = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');
  const cariInd = Number(secenek && secenek.cariInd) || null;

  const parametreler = {};
  const kosullar = [];
  if (cariInd) {
    kosullar.push('H.FIRMANO = @cariInd');
    parametreler.cariInd = cariInd;
  }
  let baslangic = null;
  let bitis = null;
  if (secenek && secenek.baslangic) {
    baslangic = gunBasi(secenek.baslangic);
    kosullar.push('H.TARIH >= @bas');
    parametreler.bas = baslangic;
  }
  if (secenek && secenek.bitis) {
    bitis = gunBasi(secenek.bitis);
    const ertesi = new Date(bitis);
    ertesi.setDate(bitis.getDate() + 1);
    kosullar.push('H.TARIH < @ertesi');
    parametreler.ertesi = ertesi;
  }

  const girisVar = (await tabloVarMi(firma, donem, 'TBLCARGIRBASLIK')) &&
    (await tabloVarMi(firma, donem, 'TBLCARGIRHAREKET'));
  const baslikTablosu = girisVar ? tablo(v, firma, donem, 'TBLCARGIRBASLIK') : null;
  const satirTablosu = girisVar ? tablo(v, firma, donem, 'TBLCARGIRHAREKET') : null;

  // Başlık LN ile bağlı; LN'si boş eski kayıtta cari + belge no ile bulunur.
  // Bir tahsilat fişinde birden çok ödeme satırı (ör. nakit + kart) olabilir,
  // bu yüzden satırlar ayrı ayrı geliyor ve JavaScript'te birleştiriliyor.
  const satirlar = await sorgu(`
    SELECT TOP 5000
      H.IND AS ind, H.TARIH AS tarih, H.FIRMANO AS cariInd,
      ${AD_IFADESI} AS cariAd,
      LTRIM(RTRIM(ISNULL(H.IZAHAT, ''))) AS izahat,
      ISNULL(H.EVRAKNO, '') AS belgeNo,
      ISNULL(H.ALACAK, 0) AS alacak,
      ${girisVar ? 'B.baslikAciklama' : "''"} AS baslikAciklama,
      ${girisVar ? 'R.arac' : 'NULL'} AS arac,
      ${girisVar ? 'R.satirTutar' : 'NULL'} AS satirTutar,
      ${girisVar ? 'R.satirAciklama' : "''"} AS satirAciklama
    FROM ${hareketTablosu} H
    LEFT JOIN ${kart(v, firma, 'TBLCARI')} C ON C.IND = H.FIRMANO
    ${girisVar ? `
    OUTER APPLY (
      SELECT TOP 1 GB.IND, CAST(GB.ACIKLAMA AS NVARCHAR(500)) AS baslikAciklama
      FROM ${baslikTablosu} GB
      WHERE LTRIM(RTRIM(ISNULL(H.IZAHAT, ''))) = '13'
        AND ((ISNULL(H.LN, 0) > 0 AND GB.IND = H.LN)
          OR (ISNULL(H.LN, 0) <= 0 AND GB.FIRMANO = H.FIRMANO AND GB.BELGENO = H.EVRAKNO))
      ORDER BY GB.IND DESC
    ) B
    OUTER APPLY (
      SELECT GH.IND AS satirInd, GH.IZAHAT AS arac, ISNULL(GH.TUTAR, 0) AS satirTutar,
             CAST(GH.ACIKLAMA AS NVARCHAR(500)) AS satirAciklama
      FROM ${satirTablosu} GH
      WHERE GH.EVRAKNO = B.IND
    ) R` : ''}
    WHERE LTRIM(RTRIM(ISNULL(H.IZAHAT, ''))) IN ('13', '83')
      AND ISNULL(H.ALACAK, 0) > 0
      AND ISNULL(H.OZELKOD, '') <> 'KREDIHESABI'
      ${kosullar.length ? 'AND ' + kosullar.join(' AND ') : ''}
    ORDER BY H.TARIH, H.IND${girisVar ? ', R.satirInd' : ''}
  `, parametreler);

  // Aynı cari hareketine ait ödeme satırlarını topla.
  const hareketler = new Map();
  for (const s of satirlar) {
    const anahtar = Number(s.ind);
    if (!hareketler.has(anahtar)) hareketler.set(anahtar, { ana: s, parcalar: [] });
    if (s.arac != null || s.satirTutar != null) hareketler.get(anahtar).parcalar.push(s);
  }

  const sonuc = [];
  for (const { ana, parcalar } of hareketler.values()) {
    const ortak = {
      ind: Number(ana.ind),
      tarih: ana.tarih,
      cariInd: Number(ana.cariInd),
      cariAd: String(ana.cariAd || '').trim(),
      belgeNo: String(ana.belgeNo || '').trim()
    };
    const alacak = Number(ana.alacak) || 0;
    const yontemler = new Set(parcalar.map((p) => odemeYontemiCoz(ana.izahat, p.arac, p.satirAciklama)));

    if (parcalar.length <= 1 || yontemler.size === 1) {
      const p = parcalar[0] || {};
      const yontem = odemeYontemiCoz(ana.izahat, p.arac, p.satirAciklama);
      sonuc.push(Object.assign({}, ortak, {
        yontem,
        yontemAdi: ODEME_YONTEM_ADI[yontem],
        tutar: alacak,
        aciklama: odemeNotu(ana.baslikAciklama, p.satirAciklama)
      }));
      continue;
    }
    // Karma yöntemli fiş: her ödeme satırı kendi yöntemi ve tutarıyla.
    for (const p of parcalar) {
      const yontem = odemeYontemiCoz(ana.izahat, p.arac, p.satirAciklama);
      sonuc.push(Object.assign({}, ortak, {
        yontem,
        yontemAdi: ODEME_YONTEM_ADI[yontem],
        tutar: Number(p.satirTutar) || 0,
        aciklama: odemeNotu(ana.baslikAciklama, p.satirAciklama)
      }));
    }
  }

  const yontemToplamlari = new Map();
  for (const s of sonuc) {
    if (!yontemToplamlari.has(s.yontem)) {
      yontemToplamlari.set(s.yontem, { yontem: s.yontem, yontemAdi: s.yontemAdi, adet: 0, tutar: 0 });
    }
    const t = yontemToplamlari.get(s.yontem);
    t.adet += 1;
    t.tutar += s.tutar;
  }

  return {
    baslangic,
    bitis,
    cari: cariInd ? await cariBasligi(v, firma, cariInd) : null,
    satirlar: sonuc,
    toplam: sonuc.reduce((t, s) => t + s.tutar, 0),
    yontemToplamlari: [...yontemToplamlari.values()],
    sinirda: satirlar.length >= 5000
  };
}

module.exports = {
  haftaAraligi,
  haftalikOzet,
  haftalikDetay,
  odemeGecmisi,
  _test: { fisNoCoz, kasaTurleriniTopla, fislereBol, odemeAciklamasi, odemeYontemiCoz, odemeNotu }
};
