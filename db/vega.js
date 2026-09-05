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
  34: 'Stok Giriş İade Fişi',
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

// --- "Google gibi" arama ------------------------------------------------------
//
// Kullanıcı isteği: aramanın tek parça yazmayı zorlamaması. "hasan cinar",
// "cinar hasan", "HASAN ÇINAR", "çınar" — hepsi aynı kartı bulmalı.
//
// İki parça var:
//   1. Yazılan metin BOŞLUKTAN bölünür, her parça AYRI AYRI aranır ve hepsi
//      birden geçmek zorundadır (Google'ın varsayılan AND davranışı). Sıra
//      önemli değil.
//   2. Karşılaştırma Latin1_General_CI_AI harmanıyla yapılır: büyük/küçük harf
//      ve Türkçe aksan farkı (ç/c, ğ/g, ı/i, ö/o, ş/s, ü/u) yok sayılır. Aksi
//      halde klavyeden "cinar" yazan "ÇINAR"ı bulamıyordu.
//
//      TÜRKÇE HARMAN BURADA İŞE YARAMIYOR — canlı veritabanında sınandı:
//      Turkish_CI_AI'de ç/ş/ğ Türk alfabesinin AYRI HARFLERİ sayılıyor, aksan
//      sayılmıyor, bu yüzden "cinar" LIKE '%ÇINAR%' eşleşmiyor. Latin1_General
//      onları aksanlı c/s/g gibi görüyor ve hepsini katlıyor (ı/i dahil).
//      VEGADB'nin kendi harmanı Turkish_CI_AS; bu yüzden karşılaştırmanın
//      İKİ TARAFINA da COLLATE yazmak şart, yoksa harman çakışması hatası olur.
//
// Sıralama (hangi sonuç üstte) arayüz tarafında yapılıyor — bkz. ui/app.js →
// `aramaPuani`. Burada yalnızca "hangi satırlar eşleşiyor" belirleniyor.
const ARAMA_HARMANI = 'Latin1_General_CI_AI';

function aramaParcalari(ham) {
  return String(ham || '')
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 6); // altıdan fazla kelime yazan yok; sorgu şişmesin
}

// alanIfadesi: aranacak sütunların tek metne birleştirilmiş hali.
function aramaFiltresiKur(alanIfadesi, parcalar, parametreler) {
  if (!parcalar.length) return '';
  const kosullar = parcalar.map((p, i) => {
    const ad = 'ara' + i;
    parametreler[ad] = '%' + p + '%';
    return `${alanIfadesi} COLLATE ${ARAMA_HARMANI} LIKE @${ad} COLLATE ${ARAMA_HARMANI}`;
  });
  return 'AND (' + kosullar.join(' AND ') + ')';
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
  const tipFiltresi = await musteriTipiFiltresi(cariTablosu, secenek && secenek.musteriTipi, 'C');
  const parametreler = {};
  const aramaFiltresi = aramaFiltresiKur(
    `(ISNULL(C.FIRMAADI, '') + ' ' + ISNULL(C.UNVAN, '') + ' ' + ISNULL(C.FIRMAKODU, ''))`,
    aramaParcalari(arama),
    parametreler
  );

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
      ISNULL(C.FIRMATIPI, 0) AS firmaTipi,
      COALESCE(NULLIF(LTRIM(RTRIM(C.SEHIR)), ''),
               NULLIF(LTRIM(RTRIM(CAST(C.ADRESPOSTA AS NVARCHAR(200)))), ''), '') AS adres,
      ISNULL(B.bakiye, 0) AS bakiye
    FROM ${cariTablosu} C
    LEFT JOIN (
      SELECT FIRMANO, SUM(ISNULL(BORC, 0) - ISNULL(ALACAK, 0)) AS bakiye
      FROM ${hareketTablosu}
      WHERE ISNULL(OZELKOD, '') <> 'KREDIHESABI'
      GROUP BY FIRMANO
    ) B ON B.FIRMANO = C.IND
    WHERE ISNULL(C.STATUS, 1) <> 2 AND C.IND >= 100 ${filtre} ${tipFiltresi} ${aramaFiltresi}
    ORDER BY ${adIfadesi}
  `,
    parametreler
  );

  return satirlar.map((s) => ({
    cariInd: Number(s.cariInd),
    kod: String(s.kod || '').trim(),
    ad: String(s.ad || '').trim(),
    unvan: String(s.unvan || '').trim(),
    adres: String(s.adres || '').trim(),
    firmaTipi: Number(s.firmaTipi) || 0,
    bakiye: Number(s.bakiye) || 0
  }));
}

// Toptan / perakende süzgeci.
//
// Vega'nın cari kartı ekranındaki "Özel Kod 1" alanı veritabanında OZELKOD1
// DEĞİL, KOD1 sütunudur — canlı şemada doğrulandı (TBLCARI'de KOD1..KOD7 var,
// OZELKOD1 yalnızca belge başlığı tablolarında). Sütun her kurulumda
// olmayabilir; yoksa süzgeç sessizce uygulanmaz, liste eksilmez.
//
// Harman Latin1_General_CI_AI: Türkçe büyük/küçük "i" ve şapkalı harf farkı
// yüzünden "Toptan"/"TOPTAN"/"toptan" ayrışmasın (bkz. aramaFiltresiKur).
const MUSTERI_TIPLERI = ['TOPTAN', 'PERAKENDE'];

async function musteriTipiFiltresi(cariTablosu, tip, takma) {
  const secilen = String(tip || '').trim().toUpperCase();
  if (!MUSTERI_TIPLERI.includes(secilen)) return '';
  if (!(await kolonVarMi(cariTablosu, 'KOD1'))) return '';
  return ` AND LTRIM(RTRIM(ISNULL(${takma}.KOD1, ''))) COLLATE Latin1_General_CI_AI
             = '${secilen}' COLLATE Latin1_General_CI_AI`;
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
// FİYAT NEREDEN GELİR: Vega'da satış fiyatı stok kartında (TBLSTOKLAR) DEĞİL,
// birim tablosunda (TBLBIRIMLEREX.SATISFIYATI) durur — canlı şemada doğrulandı,
// TBLSTOKLAR'da SATISFIYATI diye bir sütun hiç yok. Kart, varsayılan birimle
// (VARSAYILAN=1) zaten JOIN'li; fiyatı oradan okuyoruz. Sebze-meyme gibi fiyatı
// günlük değişen ürünlerde bu alan genelde boş kalır — kullanıcı elle girer,
// otomatik gelen 0 sadece bir başlangıç noktasıdır.
async function stoklariGetir(secenek) {
  const { firma } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const stokTablosu = kart(v, firma, 'TBLSTOKLAR');
  const birimTablosu = kart(v, firma, 'TBLBIRIMLEREX');
  const arama = String((secenek && secenek.arama) || '').trim();
  const limit = Math.min(Number((secenek && secenek.limit) || 300), 2000);

  const filtre = await silinmemis(stokTablosu, 'S');
  const parametreler = {};
  const aramaFiltresi = aramaFiltresiKur(
    `(ISNULL(S.MALINCINSI, '') + ' ' + ISNULL(S.STOKKODU, ''))`,
    aramaParcalari(arama),
    parametreler
  );
  const fiyatKolonu = await kolonVarMi(birimTablosu, 'SATISFIYATI');
  const fiyatIfadesi = fiyatKolonu ? 'ISNULL(B.SATISFIYATI, 0)' : '0';

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
      ${fiyatIfadesi} AS fiyat,
      ISNULL(B.BIRIMADI, '') AS birim,
      ISNULL(B.IND, 0) AS birimEx,
      ISNULL(B.CARPAN, 1) AS carpan
    FROM ${stokTablosu} S
    LEFT JOIN ${birimTablosu} B
           ON B.STOKNO = S.IND AND B.VARSAYILAN = 1
    WHERE 1 = 1 ${filtre} ${aramaFiltresi}
    ORDER BY ${adIfadesi}
  `,
    parametreler
  );

  return satirlar.map((s) => ({
    stokNo: Number(s.stokNo),
    kod: String(s.kod || '').trim(),
    ad: String(s.ad || '').trim(),
    stokTipi: Number(s.stokTipi) || 0,
    kdvGrubu: Number(s.kdvGrubu) || 0,
    fiyat: Number(s.fiyat) || 0,
    birim: String(s.birim || '').trim(),
    birimEx: Number(s.birimEx) || 0,
    carpan: Number(s.carpan) || 1
  }));
}

// --- Kasa/kap kartları (KOD1 = 'KASA' işaretli stok kartları) ---------------
//
// Gerçek işletme verisinde doğrulandı: kasa/kap kartları TBLSTOKLAR'da
// KOD1 = 'KASA' ile işaretleniyor (OZELKOD1 DEĞİL — bu sütun bu iş yerinde
// yok/farklı anlam taşıyor). Sütun her kurulumda olmayabilir; yoksa boş
// liste döner, `db/yardimci.js` → `kasaTipleriGetir` yine de kendi elle
// tutulan listesiyle çalışmaya devam eder.
//
// Dara (kap boşken kaç kg) 24.08.2026'ya kadar "Vega'da yok" sanılıyordu —
// YANLIŞ: TBLBIRIMLEREX.AGIRLIK sütununda duruyormuş, gerçek veriyle
// doğrulandı (PK=1.5, SB=1, UP=1 — BD_KasaTipi'ye o ana kadar ELLE girilmiş
// değerlerle birebir aynı). Artık buradan okunuyor, elle girmeye gerek yok.
//
// Fiyat/depozito da aynı şekilde yanlış sütundan okunuyordu: bare
// `SATISFIYATI` bu kurulumda hep 0 — gerçek fiyat `SATISFIYATI1`'de
// duruyor (gerçek veriyle doğrulandı: PK=100, SB=20, UP=100 — yine
// BD_KasaTipi'deki elle girilmiş Depozito değerleriyle birebir aynı).
// Öncelik: SATISFIYATI1 → SATISFIYATI → TBLSTOKLAR.ALISFIYATI (en son çare).
async function kasaKartlariniGetir(secenek) {
  const { firma } = await dogrula(secenek && secenek.firma, secenek && secenek.donem);
  const v = vt();
  const stokTablosu = kart(v, firma, 'TBLSTOKLAR');
  const birimTablosu = kart(v, firma, 'TBLBIRIMLEREX');

  const kod1VarMi = await kolonVarMi(stokTablosu, 'KOD1');
  if (!kod1VarMi) return [];

  const filtre = await silinmemis(stokTablosu, 'S');
  const satisfiyati1VarMi = await kolonVarMi(birimTablosu, 'SATISFIYATI1');
  const satisfiyatiVarMi = await kolonVarMi(birimTablosu, 'SATISFIYATI');
  const agirlikVarMi = await kolonVarMi(birimTablosu, 'AGIRLIK');

  const f1 = satisfiyati1VarMi ? 'ISNULL(B.SATISFIYATI1, 0)' : '0';
  const f0 = satisfiyatiVarMi ? 'ISNULL(B.SATISFIYATI, 0)' : '0';
  const depozitoIfadesi = `
    CASE WHEN ${f1} > 0 THEN ${f1}
         WHEN ${f0} > 0 THEN ${f0}
         ELSE ISNULL(S.ALISFIYATI, 0) END`;
  const daraIfadesi = agirlikVarMi ? 'ISNULL(B.AGIRLIK, 0)' : '0';

  const satirlar = await sorgu(`
    SELECT S.IND AS id, ISNULL(S.STOKKODU, '') AS kod, ISNULL(S.MALINCINSI, '') AS ad,
           ${depozitoIfadesi} AS depozito, ${daraIfadesi} AS dara
    FROM ${stokTablosu} S
    LEFT JOIN ${birimTablosu} B ON B.STOKNO = S.IND AND B.VARSAYILAN = 1
    WHERE LTRIM(RTRIM(ISNULL(S.KOD1, ''))) = 'KASA' ${filtre}
    ORDER BY S.STOKKODU, S.IND
  `);

  return satirlar.map((s) => ({
    id: Number(s.id),
    kod: String(s.kod || '').trim(),
    ad: String(s.ad || '').trim(),
    depozito: Number(s.depozito) || 0,
    dara: Number(s.dara) || 0
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
  { tablo: 'TBLSATFATBASLIK', alan: 'ALTNOT', izahatlar: ['21'] },
  // Kasa iadesi 24.08.2026'dan itibaren Stok Giriş İade Fişi olarak yazılıyor
  // (bkz. db/yazma.js → stokGirisIadesiYaz), açıklaması ALTNOT'ta duruyor.
  { tablo: 'TBLSTKGIRBASLIK', alan: 'ALTNOT', izahatlar: ['34'] }
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

// --- Satış faturası serisi tespiti ------------------------------------------
//
// "H" öneki bu programın icat ettiği bir seri: Vega'nın gerçek harfleriyle asla
// çakışmasın diye seçildi. Ama gerçek işletmede fatura vergi dairesine
// bildirilmiş BİR seri altında kesiliyor olabilir (ör. hep "A"); o zaman
// program kendi ayrı serisini değil, o gerçek seriyi sürdürmeli.
//
// TBLSATFATBASLIK.BELGENO'daki en sık kullanılan öneği buluyoruz — öneğin
// TEK HARF olacağı varsayılamaz. Canlı veride görüldü: bir firma "A0000005"
// (tek harf) kullanırken başka bir firma "MSA2026000000001" (üç harfli sabit
// önek + yıl + sayaç) kullanıyor. Önek, BELGENO'daki İLK RAKAMA kadar olan
// baştaki bölüm — PATINDEX ile bulunuyor (SQL Server'da regex yok). "MSA2026"
// içindeki "2026" sayaç değil önekin parçası: sayaç yalnızca EN SONDAKİ rakam
// dizisi, PATINDEX ilk rakamı bulduğu için önek doğru ayrılıyor. Eskiden
// LEFT(BELGENO,1) kullanılıyordu; bu "MSA2026..." için yalnızca "M" öneğini
// çıkarıp "M0000001" gibi gerçek formatla eşleşmeyen bir numara üretiyordu —
// canlı F0101 verisiyle karşılaştırılıp düzeltildi (22.08.2026).
//
// O dönemde hiç fatura yoksa null döner (çağıran taraf o zaman ayarlardaki
// varsayılan öneğe düşer).
async function satisSerisiTespitEt(firma, donem) {
  const v = vt();
  if (!(await tabloVarMi(firma, donem, 'TBLSATFATBASLIK'))) return null;

  // BELGENO + '0' garantisi: BELGENO'da hiç rakam yoksa PATINDEX 0 döner ve
  // LEFT negatif uzunlukla hata verirdi; eklenen '0' en azından bir rakam
  // bulunmasını garanti eder, o zaman önek BELGENO'nun tamamı olur.
  const satirlar = await sorgu(`
    SELECT onek, COUNT(*) AS adet
    FROM (
      SELECT LEFT(BELGENO, PATINDEX('%[0-9]%', BELGENO + '0') - 1) AS onek
      FROM ${tablo(v, firma, donem, 'TBLSATFATBASLIK')}
      WHERE BELGENO IS NOT NULL AND LEN(LTRIM(RTRIM(BELGENO))) > 1
        AND LEFT(BELGENO, 1) LIKE '[A-ZÇĞİÖŞÜ]'
    ) x
    WHERE LEN(onek) > 0
    GROUP BY onek
    ORDER BY COUNT(*) DESC
  `);
  if (!satirlar.length) return null;
  return String(satirlar[0].onek).trim().toUpperCase();
}

module.exports = {
  carileriGetir,
  cariBakiye,
  stoklariGetir,
  kasaKartlariniGetir,
  cariEkstre,
  izahatAdi,
  kolonVarMi,
  musteriTipiFiltresi,
  satisSerisiTespitEt
};
