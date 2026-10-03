'use strict';

// ================================================================
//  VEGADB'YE YAZMA — VARSAYILAN OLARAK KAPALI
// ================================================================
//
// ayarlar.json içindeki "vegayaYazmaAktif" true yapılmadan bu dosyadaki hiçbir
// fonksiyon VEGADB'ye tek satır yazmaz.
//
// PROGRAMIN AYRI BİR VERİTABANI YOK. Belge doğrudan, tek bir işlemde,
// VEGADB'nin gerçek tablolarına yazılır — ara bir "kendi veritabanımızda tut,
// sonra gönder" adımı yok. Hangi satırın nereye yazıldığı yalnızca
// db/yardimci.js'in VEGADB içine eklediği BD_Islem tablosunda durur (geri
// alma ve günlük için).
//
// Açmadan önce yapılacaklar (sırayla):
//   1. kurulum/BELGE-DESENI.md okunmalı.
//   2. Gerçek VegaWin'de aynı işlem elle girilip İzleyici ile SQL'i
//      yakalanmalı, aşağıdaki desenle karşılaştırılmalı.
//   3. Önce DEMO firmasında ya da yapısı kopyalanmış boş bir veritabanında
//      denenmeli (kurulum/test-yazma.js).
//   4. VEGADB'nin yedeği alınmalı.
//
// Yazılan her belge tek işlem (transaction) içinde oluşur: bir adım hata
// verirse hiçbir satır kalmaz, yarım belge çıkmaz.

const { sorgu, calistir, islem } = require('./sql');
const { ayarOku } = require('./ayar');
const { dogrula, tablo, kart, tabloVarMi } = require('./firma');
const yardimci = require('./yardimci');
const { kasaKartlariniCoz } = require('./kasa');

function vt() {
  return ayarOku().vegaVeritabani;
}

function kilitKontrol() {
  if (!ayarOku().vegayaYazmaAktif) {
    const hata = new Error(
      "Vega'ya yazma kapalı. Açmak için Ayarlar ekranındaki kilidi kaldırın."
    );
    hata.kod = 'YAZMA_KAPALI';
    throw hata;
  }
}

function yazmaAcikMi() {
  return !!ayarOku().vegayaYazmaAktif;
}

// --- Belge tipleri (kurulum/BELGE-DESENI.md) --------------------------------
const TIP_SATIS_FATURASI = 21;
const TIP_CARI_CIKIS = 11;
const TIP_CARI_GIRIS = 13;
const TIP_STOK_GIRIS_IADE = 34; // Stok Giriş İade Fişi — bkz. stokGirisIadesiYaz

// --- Ödeme aracı (cari giriş/çıkış HAREKET satırındaki IZAHAT) --------------
//
// DİKKAT: bu alan belge tipi değil, ÖDEME ARACIDIR — başlıktaki BELGETIPI ile
// karıştırılmasın. Canlı Vega kayıtlarından çıkarıldı: nakit ödemeli
// satırlarda IZAHAT = 1 (açıklama "Nakit Ödeme") ve satırın TBLKASA'da bir
// gelir karşılığı var; IZAHAT = 11 olanlar kredi kartı/diğer araçlar ve
// kasaya düşmüyor. PORTNO her iki durumda -1, BANKANO 0.
//
// 05.09.2026 kullanıcı isteği: program yazdığı tahsilat fişinde ödeme aracı
// boş ("-") kalıyordu; varsayılan NAKİT olacak ve para Vega'nın kasasına da
// girecek.
const ODEME_NAKIT = 1;
// 17.09.2026: Ödemeler ekranındaki Havale / EFT. Yerel VEGADB kopyasında
// Vega'nın kendi kestiği 877 cari giriş satırıyla doğrulandı: banka yoluyla
// gelen tahsilat IZAHAT = 11, PORTNO = -1, BANKANO = 0 yazılıyor; ne TBLKASA'ya
// ne de TBLBANKAHAREKETLERI'ne satır düşüyor. Havale ile EFT'yi Vega ayırmıyor,
// ayrım hareket satırının ACIKLAMA'sında ("HAVALE" / "EFT") tutuluyor.
const ODEME_BANKA = 11;
const ODEME_YONTEMLERI = {
  nakit: { arac: 'nakit', etiket: 'NAKİT' },
  havale: { arac: 'banka', etiket: 'HAVALE' },
  eft: { arac: 'banka', etiket: 'EFT' }
};
const KASA_ISLEM_GELIR = -2;
const KASA_ISLEM_GIDER = -3;

// ================================================================
//  Şema uyumu
// ================================================================
//
// Aynı Vega sürümü bile müşteriden müşteriye farklı sütun kümesiyle
// kurulabiliyor. Var olmayan bir sütuna INSERT denemesi belgenin tamamını
// düşürür. Bu yüzden her INSERT, hedef tabloda GERÇEKTEN bulunan sütunlardan
// kuruluyor: istediğimiz alanları veriyoruz, tabloda olmayanlar sessizce
// düşüyor, olmazsa olmaz alanlardan biri eksikse işlem hata veriyor.

const sutunOnbellek = new Map();

// Her sütun için { varMi, maxKarakter } tutuyoruz. maxKarakter yalnızca
// sabit-genişlikli metin sütunlarında (nvarchar/varchar/nchar/char) dolu;
// ntext/nvarchar(MAX) gibi sınırsız tiplerde null.
//
// ÖNEMLİ: sys.columns.max_length BAYT cinsinden — nvarchar/nchar İKİ BAYT/
// karakter kullanır (Unicode). Bunu karakter sanıp doğrudan kullanmak (ör.
// "nvarchar(100)" için 100 karakter var sanmak) YANLIŞ: gerçekte 50 karakter.
// Bu yüzden n-tipler için /2 yapılıyor. Bu hatayla canlıda "String or binary
// data would be truncated" alındı: TBLCARIGENELHAREKET.ACIKLAMA aslında
// nvarchar(100) = 50 karakter, yazılan açıklama 52 karakterdi (22.08.2026).
async function sutunlariGetir(tamTabloAdi) {
  if (sutunOnbellek.has(tamTabloAdi)) return sutunOnbellek.get(tamTabloAdi);
  const bekleyen = (async () => {
    const r = await sorgu(
      `SELECT c.name AS ad, ty.name AS tip, c.max_length AS uzunlukBayt
       FROM sys.columns c
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       WHERE c.object_id = OBJECT_ID(@tablo)
         AND c.is_identity = 0
         AND c.is_computed = 0`,
      { tablo: tamTabloAdi }
    );
    if (!r.length) {
      throw new Error(`Tablo bulunamadı ya da okunamadı: ${tamTabloAdi}`);
    }
    const harita = new Map();
    for (const s of r) {
      const ad = String(s.ad).toUpperCase();
      const tip = String(s.tip).toLowerCase();
      const bayt = Number(s.uzunlukBayt);
      let maxKarakter = null;
      if (bayt > 0) {
        if (tip === 'nvarchar' || tip === 'nchar') maxKarakter = bayt / 2;
        else if (tip === 'varchar' || tip === 'char') maxKarakter = bayt;
      }
      harita.set(ad, { maxKarakter });
    }
    sutunOnbellek.set(tamTabloAdi, harita);
    return harita;
  })();
  sutunOnbellek.set(tamTabloAdi, bekleyen);
  return bekleyen;
}

// alanlar: { SUTUN: deger } — değeri null olanlar da yazılır (alan boşaltılır).
// ozel:    { SUTUN: 'GETDATE()' } gibi SQL ifadeleri (parametre olmaz).
// zorunlu: bu sütunlardan biri tabloda yoksa işlem durur.
async function ekle(t, tamTabloAdi, alanlar, secenek) {
  const ayar = secenek || {};
  const mevcut = await sutunlariGetir(tamTabloAdi);

  for (const z of ayar.zorunlu || []) {
    if (!mevcut.has(z.toUpperCase())) {
      throw new Error(
        `${tamTabloAdi} tablosunda beklenen "${z}" sütunu yok. ` +
        'Vega sürümü farklı olabilir; kurulum/BELGE-DESENI.md ile karşılaştırın.'
      );
    }
  }

  const sutunlar = [];
  const degerler = [];
  const parametreler = {};
  let sira = 0;

  for (const ad of Object.keys(alanlar)) {
    const anahtar = ad.toUpperCase();
    if (!mevcut.has(anahtar)) continue;
    const p = 'p' + sira++;
    sutunlar.push(`[${ad}]`);
    degerler.push('@' + p);
    let deger = alanlar[ad];
    // Sütun genişliği müşteriden müşteriye değişebiliyor; sabit bir yerde
    // kırpmak yerine gerçek sütun sınırına göre kırpıyoruz — INSERT'in
    // "String or binary data would be truncated" ile tüm belgeyi
    // düşürmesindense metnin sonu kesilsin.
    if (typeof deger === 'string') {
      const bilgi = mevcut.get(anahtar);
      if (bilgi && bilgi.maxKarakter && deger.length > bilgi.maxKarakter) {
        deger = deger.slice(0, bilgi.maxKarakter);
      }
    }
    parametreler[p] = deger;
  }

  for (const ad of Object.keys(ayar.ozel || {})) {
    if (!mevcut.has(ad.toUpperCase())) continue;
    sutunlar.push(`[${ad}]`);
    degerler.push(ayar.ozel[ad]);
  }

  if (!sutunlar.length) throw new Error(`${tamTabloAdi} için yazılacak sütun bulunamadı.`);

  // IND alanı IDENTITY; numarayı SQL Server üretiyor, OUTPUT ile geri alıyoruz.
  const cikti = ayar.indAl === false ? '' : 'OUTPUT INSERTED.IND AS ind';
  const satirlar = await t.sorgu(
    `INSERT INTO ${tamTabloAdi} (${sutunlar.join(', ')})
     ${cikti}
     VALUES (${degerler.join(', ')})`,
    parametreler
  );

  return satirlar[0] ? Number(satirlar[0].ind) : null;
}

// ================================================================
//  Belge numarası
// ================================================================
//
// Önce Vega'nın GERÇEK serisi öğrenilmeye çalışılır: o firma/dönemde daha
// önce kesilmiş satış faturası varsa, oradaki tek-harf önek (ör. "A")
// bulunur ve numara oradan devam eder — program kendi ayrı serisini değil,
// işletmenin vergi dairesine bildirdiği gerçek seriyi sürdürür. Hiç fatura
// yoksa (yeni firma/dönem) ayarlardaki öneğe (varsayılan "H") düşülür.
//
// Numara işlemin İÇİNDE ve aralık kilitlenerek alınır: program ağdaki birkaç
// bilgisayara kurulacak, ikisi aynı anda kaydederse ikisi de aynı numarayı
// okuyup aynı numarayı yazardı. SAYAÇ TABLO BAŞINA DEĞİL, PROGRAM GENELİNDE
// TEK — fatura ile kasa dekontu ayrı tablolara yazılır, ikisi de aynı seriden
// aynı anda ilerlemeli (aynı belge iki numara taşımasın).
//
// DİKKAT: gerçek seriyi sürdürmek, Vega'nın kendi ekranından AYNI ANDA girilen
// bir belgeyle numara çakışma ihtimalini tamamen sıfırlamaz (yalnızca bu
// programın kendi kayıtları için UPDLOCK/HOLDLOCK korumalı). Kullanımın
// çakışmayacağı varsayılıyor (haftalık toplu giriş, VegaWin'in kendi ekranı
// aynı anda kullanılmıyor).
// 30.09.2026: alış faturası da programın kendi serisinden (H…) numara alır;
// Vega'nın elle kestiği alışlar "A…" serisinde, kesişmez.
const BELGE_NO_TABLOLARI = [
  'TBLSATFATBASLIK', 'TBLCARCIKBASLIK', 'TBLCARGIRBASLIK', 'TBLSTKGIRBASLIK', 'TBLALFATBASLIK'
];

function belgeOneki() {
  const ham = String(ayarOku().belgeOneki || 'H').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(ham)) {
    throw new Error(
      `Geçersiz belge öneki: "${ham}". 1-3 harf olmalı (örnek: H).`
    );
  }
  return ham;
}

// Bu firma/dönem için kullanılacak öneği bir kez tespit eder (yazma
// çağrısının başında). Aynı belge içindeki tüm dekontlar (fatura + kasa +
// tahsilat) aynı öneği ve aynı sayacı paylaşır.
//
// ESKİDEN Vega'nın gerçek satış faturası serisini (örn. "A") bulup onu
// sürdürüyordu (vega.satisSerisiTespitEt). 24.08.2026'da KALDIRILDI: aynı
// seriyi paylaşmak Vega'nın kendi muhasebeleştirmesiyle çakışıyor — belge
// Vega'da açıldığında/eski hareketlerden girildiğinde Vega ikinci bir
// TBLCARIHAREKETLERI satırı üretip bakiyeyi ikiye katlıyordu (bkz. A0000009
// olayı). Artık HER ZAMAN ayarlardaki kendi önek (varsayılan "H") kullanılır
// — Vega'nın gerçek serisiyle asla kesişmeyen, sadece bu programın yazdığı
// belgelere ait ayrı bir seri.
function onekTespitEt(firma, donem) {
  return belgeOneki();
}

// Sayaç basamak sayısı sabit 7 DEĞİL — gerçek seride görülen genişlik
// kullanılıyor. "A0000005" gibi seriler 7 basamaklı ama "MSA2026000000001"
// gibi (önek+yıl'dan sonra) 9 basamaklı seriler de var; sabit 7 kullanılırsa
// üretilen numara gerçek seriyle aynı uzunlukta olmaz. Eşleşen gerçek belge
// yoksa (yeni seri / "H" öneği) 7'ye düşülür — önceki davranışla aynı.
async function siradakiBelgeNo(t, v, firma, donem, onek) {
  const basla = onek.length + 1;
  let enBuyuk = 0;
  let genislik = 0;

  for (const ad of BELGE_NO_TABLOLARI) {
    if (!(await tabloVarMi(firma, donem, ad))) continue;
    const r = await t.sorgu(
      `SELECT MAX(CAST(SUBSTRING(BELGENO, ${basla}, 20) AS INT)) AS sonNo,
              MAX(LEN(SUBSTRING(BELGENO, ${basla}, 20))) AS genislik
       FROM ${tablo(v, firma, donem, ad)} WITH (UPDLOCK, HOLDLOCK)
       WHERE BELGENO LIKE @desen
         AND ISNUMERIC(SUBSTRING(BELGENO, ${basla}, 20)) = 1`,
      { desen: onek + '%' }
    );
    const no = r[0] && r[0].sonNo ? Number(r[0].sonNo) : 0;
    if (no > enBuyuk) enBuyuk = no;
    const g = r[0] && r[0].genislik ? Number(r[0].genislik) : 0;
    if (g > genislik) genislik = g;
  }

  return onek + String(enBuyuk + 1).padStart(genislik || 7, '0');
}

// ================================================================
//  Cari hareket satırı
// ================================================================
//
// Cari defterine düşen satır. Bakiye bu tablodan SUM(BORC - ALACAK) ile
// hesaplanıyor: BORC müşteriyi borçlandırır, ALACAK borcunu düşürür.
//
// Dikkat: bu tabloda EVRAKNO belge numarası METNİDİR ('H0000001'). Stok
// hareketlerinde tam tersi — orada EVRAKNO metin, BELGENO ise başlığın IND'i.
//
// ISLEMTARIHI/SIRALAMATARIHI gerçek zamanı (GETDATE()) taşır — kullanıcının
// seçtiği belge tarihi (TARIH, ODEMETARIHI) gün başına düşebilir, sıralama ise
// gerçek girilme anına göre olmalı (İzleyici kaydında bu ikisi ayrı sütun).
// OZELKOD burada 'MERKEZ' yazılıyor — TBLSATFATBASLIK.OZELKOD1/2 ile aynı
// değer, gerçek kayıtlarda tutarlı biçimde görülüyor. 'KREDIHESABI' değeriyle
// karışmaz (bakiye hesabı sadece o değeri dışlıyor, bkz. db/vega.js).
async function cariHareketEkle(t, ayrinti) {
  const {
    v, firma, donem, cariInd, izahat, borc, alacak, belgeNo, tarih, aciklama, headerInd,
    ozelKod, belgeLink, gecikmeHesapla, islemInd, islemIzahat
  } = ayrinti;
  const tam = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');

  const ind = await ekle(
    t,
    tam,
    {
      FIRMANO: Number(cariInd),
      IZAHAT: String(izahat),
      TARIH: tarih,
      ODEMETARIHI: tarih,
      BORC: Number(borc) || 0,
      ALACAK: Number(alacak) || 0,
      EVRAKNO: belgeNo,
      ACIKLAMA: aciklama || null,
      PARABIRIMI: 'TL',
      KUR: 1,
      // Vega'nın kendi ürettiği kayıtlarda çoğu belge tipinde 'MERKEZ' sabit
      // görülüyor ama Stok Giriş İade Fişi'nde (34) boş string — çağıran
      // farklı bir değer isterse ozelKod ile ezilebilir (bkz.
      // stokGirisIadesiYaz).
      OZELKOD: ozelKod !== undefined ? ozelKod : 'MERKEZ',
      // LN = bu hareketin bağlı olduğu başlığın IND'i (TBLSATFATBASLIK /
      // TBLCARCIKBASLIK / TBLCARGIRBASLIK). Boş bırakılırsa Vega belgeyi
      // açtığında/eski hareketlerden girdiğinde kendi muhasebe satırını
      // bulamıyor ve KENDİSİ ikinci bir TBLCARIHAREKETLERI satırı üretiyor
      // (LN dolu, OZELKOD boş) — bakiye iki katına çıkıyor. Gerçek olayla
      // doğrulandı: A0000009 belgesinde IND=499 (bizim, LN=NULL) yanına
      // Vega 2 dk sonra IND=501'i (LN=101) eklemişti.
      LN: headerInd != null ? Number(headerInd) : null
    },
    {
      zorunlu: ['FIRMANO', 'IZAHAT', 'BORC', 'ALACAK'],
      ozel: {
        ISLEMTARIHI: 'GETDATE()',
        SIRALAMATARIHI: 'GETDATE()',
        SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())'
      }
    }
  );

  const kayitlar = [{ tablo: 'TBLCARIHAREKETLERI', ind, donemli: true }];

  const genel = await cariGenelHareketEkle(t, {
    v, firma, donem, cariInd, izahat, borc, alacak, belgeNo, tarih, aciklama, headerInd,
    belgeLink, gecikmeHesapla, islemInd, islemIzahat
  });
  if (genel) kayitlar.push(genel);

  return kayitlar;
}

// ================================================================
//  Cari genel hareket (TBLCARIGENELHAREKET)
// ================================================================
//
// Bu tabloya hiç yazmıyorduk — gerçek Vega izinde her cari harekete (satış
// faturası, cari çıkış, cari giriş/tahsilat) EŞLİK ettiği görüldü, tek başına
// satış faturasına özgü değil. Bu yüzden cariHareketEkle'nin İÇİNDEN, her
// çağrıda bir kez çağrılıyor — ayrı bir üst seviye fonksiyon değil.
//
// Gerçek örnek kayıttan çıkarılan desen:
//   satış (borç)  → BELGELINK=NULL, GECIKMEHESAPLA=NULL/0
//   tahsilat/giriş → BELGELINK=-1,   GECIKMEHESAPLA=1
//   BELGEIND = ISLEMIND = ISLEMNO = (bu hareketin bağlı olduğu başlığın IND'i)
//   BELGEIZAHAT = ISLEMIZAHAT = izahat kodu (21 satış, 11 çıkış, 13 giriş)
// Tablo bazı kurulumlarda olmayabilir; varsa yazılır, yoksa sessizce atlanır.
async function cariGenelHareketEkle(t, ayrinti) {
  const {
    v, firma, donem, cariInd, izahat, borc, alacak, belgeNo, tarih, aciklama, headerInd,
    belgeLink, gecikmeHesapla, islemInd, islemIzahat
  } = ayrinti;
  if (!(await tabloVarMi(firma, donem, 'TBLCARIGENELHAREKET'))) return null;

  const tam = tablo(v, firma, donem, 'TBLCARIGENELHAREKET');
  const girisMi = Number(alacak) > 0;

  const ind = await ekle(
    t,
    tam,
    {
      FIRMANO: Number(cariInd),
      TARIH: tarih,
      VADE: tarih,
      BELGEIND: headerInd != null ? Number(headerInd) : null,
      // Cari giriş/çıkışta hareket satırının IND'i, diğer belgelerde başlık IND'i.
      ISLEMIND: islemInd != null ? Number(islemInd)
                                 : (headerInd != null ? Number(headerInd) : null),
      BELGEIZAHAT: Number(izahat),
      // Cari giriş/çıkışta ödeme aracı kodu (1 = nakit), diğerlerinde belge tipi.
      ISLEMIZAHAT: islemIzahat !== undefined ? Number(islemIzahat) : Number(izahat),
      // Gerçek Vega kayıtlarında bu ikisi ALACAK'ın işaretiyle değil, belge
      // TİPİYLE belirleniyor (tahsilat/giriş dekontu → -1/1; Stok Giriş İade
      // Fişi'nde her ikisi de NULL, ALACAK>0 olsa bile — 24.08.2026'da
      // kullanıcının Vega'da elle oluşturduğu gerçek kayıtla doğrulandı).
      // Çağıran doğru değeri vermezse eski sezgisel davranış korunuyor.
      BELGELINK: belgeLink !== undefined ? belgeLink : (girisMi ? -1 : null),
      BORC: Number(borc) || 0,
      ALACAK: Number(alacak) || 0,
      AYLIKVADE: 0,
      BELGENO: belgeNo,
      ISLEMNO: belgeNo,
      CONVERTED: 0,
      IPTAL: 0,
      TAHSILLINK: null,
      GECIKMEHESAPLA: gecikmeHesapla !== undefined ? gecikmeHesapla : (girisMi ? 1 : 0),
      PARABIRIMI: 'TL',
      KUR: 1,
      BASLIKPARABIRIMI: 'TL',
      BASLIKKURU: 1,
      ACIKLAMA: aciklama || null
    },
    {
      zorunlu: ['FIRMANO', 'BELGEIZAHAT', 'ISLEMIZAHAT'],
      ozel: { SIRALAMATARIHI: 'GETDATE()', SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
    }
  );

  return { tablo: 'TBLCARIGENELHAREKET', ind, donemli: true };
}

// ================================================================
//  Cari çıkış / cari giriş belgesi (dekont)
// ================================================================
//
// Kasa depozitosu, "Cari Çıkış" tuşu ve tahsilat bu belgeyi kullanır. Stok
// hareketi oluşmaz — yalnızca müşterinin cari defteri etkilenir.
//
// ÖDEME ARACI ALANLARI BİLEREK BOŞ BIRAKILIYOR. Bu tabloda IZAHAT belge tipi
// değil, ödeme aracı kodudur: 1 = nakit (Vega bunu TBLKASA'ya postalar),
// 2 = çek, 3 = senet; PORTNO da buna eşlik eder. Yazdığımız satır bir tahsilat
// değil, cari defter düzeltmesi — nakit işaretlersek kasa raporunda karşılığı
// olmayan bir para görünür ve kasa bakiyesi gerçeği tutmaz. Bu yüzden IZAHAT,
// PORTNO, BANKANO alanlarına dokunulmuyor.
//
// `giris` VE `borcMu` KASITLI OLARAK AYRI PARAMETRE — biri para akış YÖNÜNÜ
// (hangi Vega ekranında görünsün: Cari Giriş mi Cari Çıkış mı — "para bize mi
// geldi, biz mi verdik" sorusu), diğeri müşterinin BORÇ/ALACAK durumunu
// belirler. İkisi Vega'da bağımsız: TBLCARGIRBASLIK/TBLCARCIKBASLIK sadece
// hangi tabloya yazıldığını gösterir, cari bakiyeyi TBLCARIHAREKETLERI'ndeki
// BORC/ALACAK belirler. Eskiden `giris` tek başına ikisini birden
// belirliyordu (giris=true → hep ALACAK) — bu, kasa depozitosu gibi "içeri
// giren ama müşteriyi borçlandıran" işlemlerde yanlıştı; kullanıcı örnekle
// düzeltti (24.08.2026): kasa depozitosu alınırken tutar kasaya/bize girmiş
// sayılır (Cari GİRİŞ) ama müşteri hâlâ o kadar BORÇLANIR; kasa iade
// edildiğinde tutar müşteriye geri verilir (Cari ÇIKIŞ) ve müşterinin borcu
// o kadar AZALIR (ALACAK). Bkz. kasaIadesiYaz ve belgeYaz'daki çağrılar.
// `kalemler` verilirse (ör. [{tutar: urunTutari, aciklama:'Ürün satışı'},
// {tutar: kasaTutari, aciklama:'KASA TUTARI'}]) TEK başlık altında BİRDEN
// FAZLA hareket satırı yazılır — ürün ve kasa artık aynı belgede, satış
// faturasındaki çoklu satır deseniyle aynı mantık (bkz. satisFaturasiYaz).
// `tutar` (tekil) hâlâ desteklenir — tahsilat ve kasaIadesiYaz gibi tek
// kalemli çağrılar için kısayol, içeride tek elemanlı kalemler'e çevrilir.
// Vega'nın kasa defteri (dönemli TBLKASA) — nakit satırın para çekmecesi
// karşılığı. Şube/kasa adı uydurulmuyor, o firmada zaten kullanılan addan
// okunuyor (tek kasalı kurulumlarda hep aynı ad çıkıyor: "MERKEZ").
const kasaAdiOnbellek = new Map();

async function kasaAdlariniOku(kasaTablosu) {
  if (kasaAdiOnbellek.has(kasaTablosu)) return kasaAdiOnbellek.get(kasaTablosu);
  const bekleyen = (async () => {
    try {
      const r = await sorgu(
        `SELECT TOP 1 ISNULL(SUBEADI, '') AS sube, ISNULL(KASAADI, '') AS kasa
         FROM ${kasaTablosu}
         WHERE ISNULL(KASAADI, '') <> ''
         GROUP BY ISNULL(SUBEADI, ''), ISNULL(KASAADI, '')
         ORDER BY COUNT(*) DESC`
      );
      const s = r[0] || {};
      return {
        sube: String(s.sube || '').trim() || 'MERKEZ',
        kasa: String(s.kasa || '').trim() || 'MERKEZ'
      };
    } catch (e) {
      return { sube: 'MERKEZ', kasa: 'MERKEZ' };
    }
  })();
  kasaAdiOnbellek.set(kasaTablosu, bekleyen);
  return bekleyen;
}

// Belge başlığındaki Şube (OZELKOD1) / Kasa (OZELKOD2) adı. Kılavuz §22.6:
// sabit 'MERKEZ' yazmak yerine o tabloda en çok geçen değer okunur — çok şubeli
// kurulumda yanlış şube yazmayalım. Hiç belge yoksa 'MERKEZ'e düşülür (Vega'nın
// tek şubeli kurulumlarda kullandığı ad).
const subeKasaOnbellek = new Map();

async function subeKasaAdiOku(baslikTablosu, t) {
  if (subeKasaOnbellek.has(baslikTablosu)) return subeKasaOnbellek.get(baslikTablosu);
  const bekleyen = (async () => {
    try {
      // siradakiBelgeNo bu tabloyu aynı transaction'da kilitlemiş olabilir.
      // Ayrı havuz bağlantısı 120 sn bekleyip MERKEZ'e düşer; aynı işlemden oku.
      const r = await (t ? t.sorgu : sorgu)(
        `SELECT TOP 1 LTRIM(RTRIM(ISNULL(OZELKOD1, ''))) AS sube,
                      LTRIM(RTRIM(ISNULL(OZELKOD2, ''))) AS kasa
         FROM ${baslikTablosu}
         WHERE LTRIM(RTRIM(ISNULL(OZELKOD1, ''))) <> ''
         GROUP BY LTRIM(RTRIM(ISNULL(OZELKOD1, ''))), LTRIM(RTRIM(ISNULL(OZELKOD2, '')))
         ORDER BY COUNT(*) DESC`
      );
      const s = r[0] || {};
      const sube = String(s.sube || '').trim() || 'MERKEZ';
      return { sube, kasa: String(s.kasa || '').trim() || sube };
    } catch (e) {
      return { sube: 'MERKEZ', kasa: 'MERKEZ' };
    }
  })();
  subeKasaOnbellek.set(baslikTablosu, bekleyen);
  return bekleyen;
}

// Sütun kalıbı, Vega'nın kendi kestiği nakit cari giriş fişlerinden birebir
// alındı: ISLEM = -2 gelir / -3 gider, BELGELINK = başlığın IND'i,
// LINELINK = hareket satırının IND'i, BELGEIZAHAT = belge tipi (13/11),
// BELGENEVI = 'NAKİT'. Tablo yoksa (kurulum farkı) sessizce atlanır — belge
// yine de yazılır, yalnız kasa raporuna düşmez.
async function kasaDefterineYaz(t, ayrinti) {
  const { v, firma, donem, tarih, userNo, baslikInd, satirInd, belgeTipi, tutar, giris } = ayrinti;
  if (!(Number(tutar) > 0)) return null;
  if (!(await tabloVarMi(firma, donem, 'TBLKASA'))) return null;

  const kasaTablosu = tablo(v, firma, donem, 'TBLKASA');
  // Kasa satırının şube/kasa adı belgenin başlığındakiyle AYNI olmalı; yoksa
  // Vega kasa raporunda para başka kasada görünür.
  const adlar = (ayrinti.sube && ayrinti.kasa)
    ? { sube: ayrinti.sube, kasa: ayrinti.kasa }
    : await kasaAdlariniOku(kasaTablosu);

  return ekle(
    t,
    kasaTablosu,
    {
      TARIH: tarih,
      ISLEM: giris ? KASA_ISLEM_GELIR : KASA_ISLEM_GIDER,
      GELIR: giris ? Number(tutar) : 0,
      GIDER: giris ? 0 : Number(tutar),
      PARABIRIMI: 'TL',
      KUR: 1,
      ACIKLAMA: ayrinti.aciklama || 'Nakit Ödeme',
      BELGELINK: Number(baslikInd),
      BELGEIZAHAT: Number(belgeTipi),
      LINELINK: Number(satirInd),
      USERNO: Number(userNo || 0),
      ISLEMTIPI: 1,
      SUBEADI: adlar.sube,
      KASAADI: adlar.kasa,
      BELGENEVI: 'NAKİT'
    },
    {
      zorunlu: ['ISLEM', 'GELIR', 'GIDER', 'BELGELINK', 'LINELINK'],
      ozel: { ISLEMTARIHI: 'GETDATE()' }
    }
  );
}

async function cariDekontuYaz(t, ayrinti) {
  const { v, firma, donem, cariInd, tutar, aciklama, tarih, userNo, giris, borcMu, onek } = ayrinti;
  // odemeAraci: 'nakit' (kasaya girer) | 'banka' (havale/EFT, kasaya girmez).
  // Eski çağrılardaki nakit:true aynen çalışır.
  const odemeAraci = ayrinti.odemeAraci || (ayrinti.nakit ? 'nakit' : null);
  const nakit = odemeAraci === 'nakit';
  const banka = odemeAraci === 'banka';
  // Tahsilat açıklaması belge başlığına aittir. `satirAciklamasi` açıkça
  // verilirse hareket satırına başlık açıklamasını kopyalamayız.
  const satirAciklamasiBelirlendi = Object.prototype.hasOwnProperty.call(ayrinti, 'satirAciklamasi');
  const kalemler = (ayrinti.kalemler && ayrinti.kalemler.length)
    ? ayrinti.kalemler.filter((k) => Number(k.tutar) !== 0)
    : [{
        tutar: Number(tutar) || 0,
        aciklama: satirAciklamasiBelirlendi ? ayrinti.satirAciklamasi : aciklama
      }];
  const toplamTutar = kalemler.reduce((s, k) => s + (Number(k.tutar) || 0), 0);

  // borcMu verilmezse eski davranış korunur (giris=false→borç, true→alacak).
  const alacakYaz = borcMu != null ? !borcMu : !!giris;

  const baslikAdi = giris ? 'TBLCARGIRBASLIK' : 'TBLCARCIKBASLIK';
  const hareketAdi = giris ? 'TBLCARGIRHAREKET' : 'TBLCARCIKHAREKET';
  const belgeTipi = giris ? TIP_CARI_GIRIS : TIP_CARI_CIKIS;

  const baslikTam = tablo(v, firma, donem, baslikAdi);
  const hareketTam = tablo(v, firma, donem, hareketAdi);
  const belgeNo = await siradakiBelgeNo(t, v, firma, donem, onek || belgeOneki());

  // ŞUBE / KASA — Vega'nın ekranında bu iki alan BOŞ OLAMAZ. Cari giriş/çıkış
  // başlığında karşılıkları OZELKOD1 (Şube) ve OZELKOD2 (Kasa); kılavuz §22.6
  // ile aynı desen, canlı veriyle de doğrulandı (bu kurulumdaki 159 cari giriş
  // ve 59 cari çıkış başlığının HEPSİ 'MERKEZ'/'MERKEZ'). Boş bırakılınca
  // kullanıcı belgeyi Vega'da açıp elle doldurmak zorunda kalıyor ve kaydedince
  // Vega belgeyi yeniden postalayıp cariye İKİNCİ bir hareket yazıyor
  // (05.09.2026 kullanıcı raporu: "şube ve kasa boş olamaz" + "cariye mükerrer
  // geliyor"). Ad sabit yazılmıyor, o firmanın kendi belgelerinden okunuyor.
  const yer = await subeKasaAdiOku(baslikTam, t);

  const baslikInd = await ekle(
    t,
    baslikTam,
    {
      BELGENO: belgeNo,
      TARIH: tarih,
      FIRMANO: Number(cariInd),
      BELGETIPI: belgeTipi,
      TUTAR: toplamTutar,
      ACIKLAMA: aciklama || null,
      GIRIS: giris ? 1 : 0,
      IPTAL: 0,
      IADE: 0,
      PARABIRIMI: 'TL',
      KUR: 1,
      AYLIKVADE: 0,
      MUHASEBELESMEYECEK: 0,
      OZELKOD1: yer.sube,  // Şube
      OZELKOD2: yer.kasa,  // Kasa
      OZELKOD3: '',
      OZELKOD4: '',
      USERNO: Number(userNo || 0)
    },
    {
      zorunlu: ['BELGENO', 'FIRMANO', 'BELGETIPI', 'TUTAR'],
      // UID: Vega kendi kestiği her belgeye '{GUID}' biçiminde bir kimlik
      // yazıyor; boş bırakılan belgeler bazı ekranlarda eşleşmiyor.
      ozel: { CREDATE: 'GETDATE()', UID: "'{' + CAST(NEWID() AS NVARCHAR(36)) + '}'" }
    }
  );

  const kayitlar = [{ tablo: baslikAdi, ind: baslikInd, donemli: true }];
  let ilkSatirInd = null;

  for (const k of kalemler) {
    // Alanlar Vega'nın kendi kestiği cari giriş/çıkış satırlarından birebir:
    // BELGENO satırda BOŞ (numara başlıkta durur), BELGELINK = -1, STATUS = 0,
    // VADE = belge tarihi. Satıra belge numarası yazmak Vega'nın belgeyi
    // tanımasını bozuyor.
    const alanlar = {
      EVRAKNO: baslikInd,
      BELGENO: '',
      FIRMANO: Number(cariInd),
      TUTAR: Number(k.tutar) || 0,
      ACIKLAMA: satirAciklamasiBelirlendi
        ? (k.aciklama || null)
        : (k.aciklama || aciklama || null),
      PARABIRIMI: 'TL',
      KUR: 1,
      VADE: tarih,
      AYLIKVADE: 0,
      BELGELINK: -1,
      STATUS: 0
    };
    // Ödeme aracı yalnızca gerçekten para alınan/verilen fişte doldurulur
    // (tahsilat). Mal satışını cari giriş olarak yazan dekontta para el
    // değiştirmediği için burası boş kalır — yoksa alınmamış para kasaya
    // girmiş görünürdü.
    if (nakit || banka) {
      alanlar.IZAHAT = nakit ? ODEME_NAKIT : ODEME_BANKA;
      alanlar.PORTNO = -1;
      alanlar.BANKANO = 0;
    }

    const satirInd = await ekle(t, hareketTam, alanlar, { zorunlu: ['EVRAKNO', 'TUTAR'] });
    kayitlar.push({ tablo: hareketAdi, ind: satirInd, donemli: true });
    if (ilkSatirInd == null) ilkSatirInd = satirInd;

    if (nakit) {
      const kasaInd = await kasaDefterineYaz(t, {
        v, firma, donem, tarih, userNo, giris,
        baslikInd,
        satirInd,
        belgeTipi,
        sube: yer.sube,
        kasa: yer.kasa,
        tutar: Number(k.tutar) || 0,
        aciklama: 'Nakit Ödeme'
      });
      if (kasaInd) kayitlar.push({ tablo: 'TBLKASA', ind: kasaInd, donemli: true });
    }
  }

  const cari = await cariHareketEkle(t, {
    v,
    firma,
    donem,
    cariInd,
    izahat: belgeTipi,
    borc: alacakYaz ? 0 : toplamTutar,
    alacak: alacakYaz ? toplamTutar : 0,
    belgeNo,
    tarih,
    aciklama,
    headerInd: baslikInd,
    // TBLCARIGENELHAREKET'te cari giriş/çıkış belgeleri fatura/stok
    // belgelerinden AYRI davranıyor (canlı veriyle doğrulandı):
    //   fatura/stok (20,21,22,32,33…): BELGEIND = ISLEMIND = başlık IND,
    //                                  BELGEIZAHAT = ISLEMIZAHAT = belge tipi
    //   cari giriş/çıkış (13, 11)   : ISLEMIND = HAREKET satırının IND'i,
    //                                  ISLEMIZAHAT = ÖDEME ARACI (1 = nakit)
    // İkincisini başlık IND'i ve belge tipiyle doldurmak, Vega'nın belgeyi
    // kendi satırlarıyla eşleştirmesini bozuyordu.
    islemInd: ilkSatirInd,
    islemIzahat: nakit ? ODEME_NAKIT : (banka ? ODEME_BANKA : undefined)
  });
  kayitlar.push(...cari);

  return { belgeNo, belgeTipi, toplam: toplamTutar, kayitlar };
}

// ================================================================
//  Satış faturası
// ================================================================
//
// Beş tabloya yazar. Bağlar (kurulum/BELGE-DESENI.md):
//
//   TBLSATFATBASLIK.IND ──┬─→ TBLSATFATHAREKET.EVRAKNO
//                         ├─→ TBLSTOKHAREKETLERI.BELGENO   (sayı!)
//                         └─→ TBLDEPOENVANTER.BELGEIND
//   TBLSATFATHAREKET.IND ─┬─→ TBLSTOKHAREKETLERI.LN
//                         └─→ TBLDEPOENVANTER.HAREKETIND
async function satisFaturasiYaz(t, ayrinti) {
  const { v, firma, donem, cariInd, cariAd, satirlar, tarih, depo, userNo, aciklama, onek } = ayrinti;

  // Tek sorguyla bütün ürün/kasa kartlarını denetle. Eksik kartta transaction
  // geri alınır; Vega'ya bağlı olmayan satır veya envanter yazılmaz.
  const noLar = [...new Set(satirlar.map((s) => Number(s.stokNo)))];
  if (noLar.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    throw new Error('Faturada geçersiz stok kartı numarası var.');
  }
  const stokTablosu = kart(v, firma, 'TBLSTOKLAR');
  const aktifKart = (await sutunlariGetir(stokTablosu)).has('DELETED')
    ? 'AND ISNULL(DELETED, 0) = 0' : '';
  const varOlanlar = await t.sorgu(
    `SELECT IND FROM ${stokTablosu} WHERE IND IN (${noLar.join(',')}) ${aktifKart}`
  );
  const bulunanlar = new Set(varOlanlar.map((s) => Number(s.IND)));
  const eksikler = noLar.filter((n) => !bulunanlar.has(n));
  if (eksikler.length) throw new Error(`Vega'da bulunmayan stok kartı: ${eksikler.join(', ')}.`);

  const baslikTam = tablo(v, firma, donem, 'TBLSATFATBASLIK');
  const hareketTam = tablo(v, firma, donem, 'TBLSATFATHAREKET');
  const stokHareketTam = tablo(v, firma, donem, 'TBLSTOKHAREKETLERI');
  const envanterTam = tablo(v, firma, donem, 'TBLDEPOENVANTER');
  const belgeNo = await siradakiBelgeNo(t, v, firma, donem, onek || belgeOneki());

  const araToplam = satirlar.reduce((s, x) => s + Number(x.tutar || 0), 0);
  const kdvToplam = satirlar.reduce((s, x) => s + Number(x.kdvTutari || 0), 0);
  const genelToplam = araToplam + kdvToplam;

  const baslikInd = await ekle(
    t,
    baslikTam,
    {
      BELGENO: belgeNo,
      TARIH: tarih,
      ODEMETARIHI: tarih,
      FIRMANO: Number(cariInd),
      FIRMAADI: null,
      BELGETIPI: TIP_SATIS_FATURASI,
      EKBELGETIPI: 0,
      // DEPO (başlık) BİLEREK yazılmıyor — 5/5 gerçek faturada NULL. Depo
      // numarası yalnızca HAREKETDEPOSU'nda tutuluyor.
      HAREKETDEPOSU: Number(depo),
      TUTAR: genelToplam,
      ARATOPLAM: araToplam,
      KDV: kdvToplam > 0 ? 1 : 0, // BIT sütun — tutar değil "KDV var mı" bayrağı
      AK: 0,
      STOKHAREKETEYAZ: 1,
      CARIHAREKETEYAZ: 1,
      // ENVANTERUPDATE BİLEREK yazılmıyor — 5/5 gerçek faturada NULL (0 değil).
      IPTAL: 0,
      IADE: 0,
      CONVERTED: 0,
      GIRIS: 0,
      PARABIRIMI: 'TL',
      KUR: 1,
      USERNO: 100,
      ALTNOT: aciklama || null,
      OZELKOD1: 'MERKEZ',
      OZELKOD2: 'MERKEZ',
      YUVARLAMA: 0,
      ALLOWYUVARLAMA: 0,
      ODENEN: 0,
      ENTEGRE: 0,
      SATISSEKLI: 0,
      YURTDISI: 0,
      MUHASEBELESMEYECEK: 0,
      KAYNAK: 0,
      EFATURA: 0
    },
    {
      zorunlu: ['BELGENO', 'FIRMANO', 'BELGETIPI'],
      ozel: { CREDATE: 'GETDATE()', LADATE: 'GETDATE()' }
    }
  );

  const kayitlar = [{ tablo: 'TBLSATFATBASLIK', ind: baslikInd, donemli: true }];

  for (const s of satirlar) {
    const miktar = Number(s.miktar) || 0;
    const tutar = Number(s.tutar) || 0;
    const fiyat = Number(s.fiyat) || 0;
    const maliyet = Number(s.maliyet) || 0;

    const satirInd = await ekle(
      t,
      hareketTam,
      {
        EVRAKNO: baslikInd,
        DETAY: 0,
        TARIH: tarih,
        FIRMANO: Number(cariInd),
        STOKNO: Number(s.stokNo),
        MALINCINSI: s.stokAdi || '',
        STOKKODU: s.stokKodu || null,
        STOKTIPI: Number(s.stokTipi || 0),
        MIKTAR: miktar,
        BIRIMMIKTAR: Number(s.carpan || 1),
        BIRIM: s.birim || '',
        BIRIMEX: Number(s.birimEx || 0),
        FIYATI: fiyat,
        AFIYATI: maliyet,
        KDV: Number(s.kdvOrani || 0),
        KDVTUTARI: null,
        GERCEKTOPLAM: tutar,
        DEPO: Number(depo),
        ENVANTER: miktar,
        PARABIRIMI: 'TL',
        KUR: 1,
        ACIKLAMA: s.aciklama || null,
        ISK1: 0, ISK2: 0, ISK3: 0, ISK4: 0, ISK5: 0, ISK6: 0,
        PERSONEL: 0,
        PIRIM: 0,
        OPSIYON: 0,
        PROMOSYON: 0,
        SATISKOSULU: 1,
        SERIMIKTAR: 1,
        MASRAF: 0,
        OIV: 0,
        INDIRIM: 0,
        OTV: 0,
        GRUPMIKTAR: 1
      },
      { zorunlu: ['EVRAKNO', 'STOKNO', 'MIKTAR'] }
    );
    kayitlar.push({ tablo: 'TBLSATFATHAREKET', ind: satirInd, donemli: true });

    const stokInd = await ekle(
      t,
      stokHareketTam,
      {
        EVRAKNO: belgeNo,
        BELGENO: baslikInd,
        LN: satirInd,
        IZAHAT: TIP_SATIS_FATURASI,
        TARIH: tarih,
        STOKNO: Number(s.stokNo),
        FIRMANO: Number(cariInd),
        GIREN: 0,
        CIKAN: miktar,
        KALAN: 0,
        TUTAR: tutar,
        DEPO: Number(depo),
        KDV: Number(s.kdvOrani || 0),
        IADE: 0,
        BIRIMFIYAT: fiyat,
        BIRIMMALIYET: maliyet,
        BIRIMEX: Number(s.birimEx || 0),
        PARABIRIMI: 'TL',
        KUR: 1,
        SIRALAMATARIHI: tarih,
        ACIKLAMA: s.aciklama || null
      },
      {
        zorunlu: ['STOKNO', 'IZAHAT', 'CIKAN'],
        ozel: { SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
      }
    );
    kayitlar.push({ tablo: 'TBLSTOKHAREKETLERI', ind: stokInd, donemli: true });

    const envanterInd = await ekle(
      t,
      envanterTam,
      {
        TARIH: tarih,
        STOKNO: Number(s.stokNo),
        DEPO: Number(depo),
        ENVANTER: -miktar,
        BELGETIPI: TIP_SATIS_FATURASI,
        BELGEIND: baslikInd,
        HAREKETIND: satirInd,
        SIRALAMATARIHI: tarih,
        ACIKLAMA: s.aciklama || null
      },
      {
        zorunlu: ['STOKNO', 'ENVANTER', 'BELGETIPI'],
        ozel: { SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
      }
    );
    kayitlar.push({ tablo: 'TBLDEPOENVANTER', ind: envanterInd, donemli: true });
  }

  const cari = await cariHareketEkle(t, {
    v,
    firma,
    donem,
    cariInd,
    izahat: TIP_SATIS_FATURASI,
    borc: genelToplam,
    alacak: 0,
    belgeNo,
    tarih,
    aciklama,
    headerInd: baslikInd
  });
  kayitlar.push(...cari);

  return { belgeNo, belgeTipi: TIP_SATIS_FATURASI, toplam: genelToplam, kayitlar };
}

// ================================================================
//  Alış faturası (tip 20)
// ================================================================
//
// 30.09.2026 müşteri isteği: gelen alış faturaları programdan basitçe
// girilebilsin. Desen VEGADBgalya F0102/D0002'deki elle kesilmiş gerçek alış
// faturasından (A0000327) sütun sütun okundu; kılavuz §23.2 ile aynı:
//
//   TBLALFATBASLIK.IND ──┬─→ TBLALFATHAREKET.EVRAKNO
//                        ├─→ TBLSTOKHAREKETLERI.BELGENO   (sayı!)
//                        └─→ TBLDEPOENVANTER.BELGEIND
//   TBLALFATHAREKET.IND ─┬─→ TBLSTOKHAREKETLERI.LN
//                        └─→ TBLDEPOENVANTER.HAREKETIND
//
// Satıştan farkları: GIRIS=1, satırda fiyat AFIYATI'nda (FIYATI=0), stok
// hareketinde GIREN, envanter +miktar, cari hareket ALACAK (tedarikçiye
// borçlanırız) ve OZELKOD BOŞ ('MERKEZ' değil), genel harekette BELGELINK ve
// GECIKMEHESAPLA NULL. Başlıkta IRSALIYELIFATURA=1, UID dolu.
//
// Vega alışta stok kartının alış fiyatını da günceller (kılavuz §23.2);
// geri alınca eski değerlere dönülmeli (§45.3). Önceki değerler yazılan
// kaydın `kartGeri` listesinde saklanır, vegaKaydiniGeriAl geri yazar.
// Daha eski tarihli fatura kartın son alış bilgisini ezmez.
const TIP_ALIS_FATURASI = 20;

const KART_ALIS_ALANLARI = ['ALISFIYATI', 'ESKIALISFIYATI', 'ALISFIYATIDEGISMETARIHI', 'SONALISTARIHI'];

async function kartAlisFiyatiniGuncelle(t, v, firma, stokNo, fiyat, tarih) {
  const tam = kart(v, firma, 'TBLSTOKLAR');
  const mevcut = await sutunlariGetir(tam);
  if (!mevcut.has('ALISFIYATI')) return null;
  const alanlar = KART_ALIS_ALANLARI.filter((a) => mevcut.has(a));
  const once = (await t.sorgu(
    `SELECT ${alanlar.join(', ')} FROM ${tam} WITH (UPDLOCK) WHERE IND = @stokNo`,
    { stokNo }
  ))[0];
  if (!once) return null;
  if (once.SONALISTARIHI && new Date(once.SONALISTARIHI) > tarih) return null;

  const setler = ['ALISFIYATI = @fiyat'];
  if (mevcut.has('ESKIALISFIYATI')) setler.push('ESKIALISFIYATI = ALISFIYATI');
  if (mevcut.has('ALISFIYATIDEGISMETARIHI')) setler.push('ALISFIYATIDEGISMETARIHI = GETDATE()');
  if (mevcut.has('SONALISTARIHI')) setler.push('SONALISTARIHI = @tarih');
  if (mevcut.has('GUNCELLEMETARIHI')) setler.push('GUNCELLEMETARIHI = GETDATE()');
  await t.calistir(`UPDATE ${tam} SET ${setler.join(', ')} WHERE IND = @stokNo`,
    { stokNo, fiyat, tarih });
  return { stokNo, once, yazilanFiyat: fiyat, yazilanTarih: tarih };
}

// Kart, faturadan sonra başka bir alışla değişmediyse eski değerlerine döner.
async function kartAlisFiyatiniGeriAl(t, v, firma, g) {
  const tam = kart(v, firma, 'TBLSTOKLAR');
  const mevcut = await sutunlariGetir(tam);
  const alanlar = KART_ALIS_ALANLARI.filter((a) => mevcut.has(a) && g.once && a in g.once);
  if (!alanlar.length) return;
  const p = { stokNo: Number(g.stokNo), yazilanFiyat: Number(g.yazilanFiyat) };
  const setler = alanlar.map((a, i) => {
    const deger = g.once[a];
    p['o' + i] = /TARIHI$/.test(a) && deger != null ? new Date(deger) : deger;
    return `${a} = @o${i}`;
  });
  let kosul = 'IND = @stokNo AND ALISFIYATI = @yazilanFiyat';
  if (mevcut.has('SONALISTARIHI') && g.yazilanTarih) {
    kosul += ' AND SONALISTARIHI = @yazilanTarih';
    p.yazilanTarih = new Date(g.yazilanTarih);
  }
  await t.calistir(`UPDATE ${tam} SET ${setler.join(', ')} WHERE ${kosul}`, p);
}

async function alisFaturasiYaz(t, ayrinti) {
  const { v, firma, donem, cariInd, satirlar, tarih, depo, aciklama, onek } = ayrinti;

  const noLar = [...new Set(satirlar.map((s) => Number(s.stokNo)))];
  if (noLar.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    throw new Error('Faturada geçersiz stok kartı numarası var.');
  }
  const stokTablosu = kart(v, firma, 'TBLSTOKLAR');
  const aktifKart = (await sutunlariGetir(stokTablosu)).has('DELETED')
    ? 'AND ISNULL(DELETED, 0) = 0' : '';
  const kartlar = await t.sorgu(
    `SELECT IND, ISNULL(STOKTIPI, 0) AS STOKTIPI FROM ${stokTablosu}
     WHERE IND IN (${noLar.join(',')}) ${aktifKart}`
  );
  const kartHaritasi = new Map(kartlar.map((k) => [Number(k.IND), k]));
  const eksikler = noLar.filter((n) => !kartHaritasi.has(n));
  if (eksikler.length) throw new Error(`Vega'da bulunmayan stok kartı: ${eksikler.join(', ')}.`);

  const baslikTam = tablo(v, firma, donem, 'TBLALFATBASLIK');
  const hareketTam = tablo(v, firma, donem, 'TBLALFATHAREKET');
  const stokHareketTam = tablo(v, firma, donem, 'TBLSTOKHAREKETLERI');
  const envanterTam = tablo(v, firma, donem, 'TBLDEPOENVANTER');
  const belgeNo = await siradakiBelgeNo(t, v, firma, donem, onek || belgeOneki());
  const yer = await subeKasaAdiOku(baslikTam, t);

  const araToplam = Math.round(satirlar.reduce((s, x) => s + Number(x.tutar || 0), 0) * 100) / 100;
  const kdvToplam = Math.round(satirlar.reduce((s, x) => s + Number(x.kdvTutari || 0), 0) * 100) / 100;
  const genelToplam = Math.round((araToplam + kdvToplam) * 100) / 100;

  const baslikInd = await ekle(
    t,
    baslikTam,
    {
      BELGENO: belgeNo,
      TARIH: tarih,
      ODEMETARIHI: tarih,
      FIRMANO: Number(cariInd),
      FIRMAADI: null,
      BELGETIPI: TIP_ALIS_FATURASI,
      EKBELGETIPI: 0,
      HAREKETDEPOSU: Number(depo),
      TUTAR: genelToplam,
      ARATOPLAM: araToplam,
      KDV: kdvToplam > 0 ? 1 : 0,
      AK: 0,
      ODMODIFIED: 0,
      ALT1: 0, ALT2: 0, ALT3: 0, ALT4: 0,
      MASRAF1: 0, MASRAF2: 0, MASRAF3: 0, MASRAF4: 0,
      MASRAFKDV1: 0, MASRAFKDV2: 0, MASRAFKDV3: 0, MASRAFKDV4: 0,
      STOKHAREKETEYAZ: 1,
      CARIHAREKETEYAZ: 1,
      IRSALIYELIFATURA: 1,
      YAZARKASAFISI: 0,
      IPTAL: 0,
      IADE: 0,
      CONVERTED: 0,
      GIRIS: 1,
      PARABIRIMI: 'TL',
      KUR: 1,
      USERNO: 100,
      ALTNOT: aciklama || null,
      OZELKOD1: yer.sube,
      OZELKOD2: yer.kasa,
      YUVARLAMA: 0,
      ALLOWYUVARLAMA: 0,
      ODENEN: 0,
      ENTEGRE: 0,
      SATISSEKLI: 0,
      YURTDISI: 0,
      MUHASEBELESMEYECEK: 0,
      KAYNAK: 0,
      EFATURA: 0
    },
    {
      zorunlu: ['BELGENO', 'FIRMANO', 'BELGETIPI'],
      ozel: {
        CREDATE: 'GETDATE()',
        LADATE: 'GETDATE()',
        UID: "'{' + CAST(NEWID() AS NVARCHAR(36)) + '}'"
      }
    }
  );

  const kayitlar = [{ tablo: 'TBLALFATBASLIK', ind: baslikInd, donemli: true }];
  const kartOnceleri = new Map();   // stokNo → ilk (fatura öncesi) değerler
  const kartSonlari = new Map();    // stokNo → faturanın yazdığı son fiyat/tarih

  for (const s of satirlar) {
    const stokNo = Number(s.stokNo);
    const k = kartHaritasi.get(stokNo);
    const miktar = Number(s.miktar) || 0;
    const tutar = Number(s.tutar) || 0;
    const fiyat = Number(s.fiyat) || 0;
    const kdvOrani = Number(s.kdvOrani || 0);

    const satirInd = await ekle(
      t,
      hareketTam,
      {
        EVRAKNO: baslikInd,
        DETAY: 0,
        TARIH: tarih,
        FIRMANO: Number(cariInd),
        STOKNO: stokNo,
        MALINCINSI: s.stokAdi || '',
        STOKKODU: s.stokKodu || '',
        STOKTIPI: Number(k.STOKTIPI || 0),
        MIKTAR: miktar,
        BIRIMMIKTAR: Number(s.carpan || 1),
        BIRIM: s.birim || '',
        BIRIMEX: Number(s.birimEx || 0),
        KDV: kdvOrani,
        ISK1: 0, ISK2: 0, ISK3: 0, ISK4: 0, ISK5: 0, ISK6: 0,
        // Gerçek kayıtta alış fiyatı AFIYATI'nda, FIYATI 0.
        AFIYATI: fiyat,
        FIYATI: 0,
        GERCEKTOPLAM: tutar,
        DEPO: Number(depo),
        PERSONEL: 0,
        PIRIM: 0,
        OPSIYON: 0,
        PROMOSYON: 0,
        SATISKOSULU: 1,
        SERIMIKTAR: 1,
        ENVANTER: miktar,
        KARSISTOKKODU: '',
        PARABIRIMI: 'TL',
        KUR: 1,
        BARKOD: '',
        MASRAF: 0,
        OIV: 0,
        INDIRIM: 0,
        OTV: 0,
        GRUPMIKTAR: 1,
        // GK: Vega her satıra rastgele bir int32 yazıyor.
        GK: Math.floor(Math.random() * 4294967296) - 2147483648
      },
      { zorunlu: ['EVRAKNO', 'STOKNO', 'MIKTAR'] }
    );
    kayitlar.push({ tablo: 'TBLALFATHAREKET', ind: satirInd, donemli: true });

    const stokInd = await ekle(
      t,
      stokHareketTam,
      {
        EVRAKNO: belgeNo,
        BELGENO: baslikInd,
        LN: satirInd,
        IZAHAT: TIP_ALIS_FATURASI,
        TARIH: tarih,
        STOKNO: stokNo,
        FIRMANO: Number(cariInd),
        GIREN: miktar,
        CIKAN: 0,
        TUTAR: tutar,
        DEPO: Number(depo),
        KDV: kdvOrani,
        PERSONEL: 0,
        IADE: 0,
        OPSIYON: 0,
        BIRIMFIYAT: fiyat,
        BIRIMMALIYET: fiyat,
        BIRIMEX: Number(s.birimEx || 0),
        STOKTIPI: Number(k.STOKTIPI || 0),
        PARABIRIMI: 'TL',
        KUR: 1,
        SIRALAMATARIHI: tarih,
        ACIKLAMA: ''
      },
      {
        zorunlu: ['STOKNO', 'IZAHAT', 'GIREN'],
        ozel: { SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
      }
    );
    kayitlar.push({ tablo: 'TBLSTOKHAREKETLERI', ind: stokInd, donemli: true });

    const envanterInd = await ekle(
      t,
      envanterTam,
      {
        TARIH: tarih,
        STOKNO: stokNo,
        DEPO: Number(depo),
        ENVANTER: miktar,
        BELGETIPI: TIP_ALIS_FATURASI,
        BELGEIND: baslikInd,
        HAREKETIND: satirInd,
        SIRALAMATARIHI: tarih
      },
      {
        zorunlu: ['STOKNO', 'ENVANTER', 'BELGETIPI'],
        ozel: { SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
      }
    );
    kayitlar.push({ tablo: 'TBLDEPOENVANTER', ind: envanterInd, donemli: true });

    if (fiyat > 0) {
      const g = await kartAlisFiyatiniGuncelle(t, v, firma, stokNo, fiyat, tarih);
      if (g) {
        if (!kartOnceleri.has(stokNo)) kartOnceleri.set(stokNo, g.once);
        kartSonlari.set(stokNo, g);
      }
    }
  }

  const cari = await cariHareketEkle(t, {
    v, firma, donem, cariInd,
    izahat: TIP_ALIS_FATURASI,
    borc: 0,
    alacak: genelToplam,
    belgeNo,
    tarih,
    aciklama: null,
    headerInd: baslikInd,
    ozelKod: '',
    belgeLink: null,
    gecikmeHesapla: null
  });
  kayitlar.push(...cari);

  const kartGeri = [...kartSonlari.values()].map((g) => ({
    stokNo: g.stokNo,
    once: kartOnceleri.get(g.stokNo),
    yazilanFiyat: g.yazilanFiyat,
    yazilanTarih: g.yazilanTarih
  }));

  return {
    belgeNo, belgeTipi: TIP_ALIS_FATURASI, toplam: genelToplam, araToplam, kdvToplam,
    kayitlar, kartGeri
  };
}

// Alış faturası girişi — Alış Faturası ekranı. Düzenleme (duzenlenenIslemId)
// eski faturayı ve kart fiyatını geri alıp yenisini aynı transaction'da yazar.
async function alisFaturasiKaydet(secenek) {
  kilitKontrol();
  await yardimci.hazirla();

  const cariInd = Number(secenek.cariInd);
  if (!cariInd) throw new Error('Tedarikçi seçilmeli.');
  const { firma, donem } = await dogrula(secenek.firma, secenek.donem);
  for (const ad of ['TBLALFATBASLIK', 'TBLALFATHAREKET']) {
    if (!(await tabloVarMi(firma, donem, ad))) {
      throw new Error(`${firma}${donem}${ad} tablosu yok. Bu firma/dönemde alış faturası girilemiyor.`);
    }
  }
  const a = ayarOku();
  const depo = Number(secenek.depo != null ? secenek.depo : a.varsayilanDepo) || 0;
  if (!depo) throw new Error('Alış faturası için depo seçilmelidir. Ayarlar ekranından depo seçin.');

  const kdvOrani = Math.max(0, Number(secenek.kdvOrani) || 0);
  const satirlar = (Array.isArray(secenek.satirlar) ? secenek.satirlar : [])
    .filter((s) => Number(s.stokNo) && Number(s.miktar) > 0)
    .map((s) => {
      const miktar = Math.round(Number(s.miktar) * 1000) / 1000;
      const fiyat = Math.round((Number(s.fiyat) || 0) * 10000) / 10000;
      const tutar = Math.round(miktar * fiyat * 100) / 100;
      return {
        stokNo: Number(s.stokNo),
        stokKodu: s.stokKodu || '',
        stokAdi: s.stokAdi || '',
        birim: s.birim || '',
        birimEx: Number(s.birimEx) || 0,
        carpan: Number(s.carpan) || 1,
        miktar, fiyat, tutar, kdvOrani,
        kdvTutari: kdvOrani ? Math.round(tutar * kdvOrani) / 100 : 0
      };
    });
  if (!satirlar.length) throw new Error('Faturaya en az bir ürün satırı (miktarlı) girilmeli.');
  if (satirlar.some((s) => !(s.fiyat > 0))) throw new Error('Her satırda birim fiyat girilmeli.');

  const duzenlenenIslemId = Number(secenek.duzenlenenIslemId) || null;
  const eski = duzenlenenIslemId
    ? await duzenlenecekKaydiOku(duzenlenenIslemId, ['alisFaturasi'], firma, donem)
    : null;

  const v = vt();
  const tarih = new Date(secenek.tarih || Date.now());
  const faturaNo = String(secenek.faturaNo || '').trim().substring(0, 50);
  const not = String(secenek.aciklama || '').trim();
  const aciklama = ([faturaNo ? 'Fatura ' + faturaNo : '', not].filter(Boolean).join(' - ') ||
    'Hizli Belge Doldurucu').substring(0, 250);
  const onek = await onekTespitEt(firma, donem);

  return islem(async (t) => {
    if (eski) {
      await vegaKaydiniGeriAl(t, eski.yazilan, firma, donem);
      await yardimci.islemKayitlariniTamSil(t, duzenlenenIslemId);
    }

    const f = await alisFaturasiYaz(t, {
      v, firma, donem, cariInd, satirlar, tarih, depo, aciklama, onek
    });

    const islemId = await yardimci.islemYaz(t, {
      konu: 'alisFaturasi',
      firma, donem, tarih, cariInd, cariAd: secenek.cariAd || null,
      belgeNo: f.belgeNo,
      tutar: f.toplam,
      aciklama,
      fisNo: faturaNo || null,
      yazilan: [{
        ad: 'Alış faturası', tur: 'alisFaturasi', faturaNo, not, kdvOrani,
        satirlar: satirlar.map((s) => ({
          stokNo: s.stokNo, stokKodu: s.stokKodu, stokAdi: s.stokAdi,
          miktar: s.miktar, fiyat: s.fiyat, tutar: s.tutar
        })),
        ...f
      }],
      kullanici: secenek.kullanici
    });

    return {
      tamam: true, belgeNo: f.belgeNo, islemId, faturaNo,
      araToplam: f.araToplam, kdvToplam: f.kdvToplam, toplam: f.toplam,
      duzenlendi: !!eski
    };
  });
}

// ================================================================
//  Stok giriş iade fişi (kasa fiziksel iadesi)
// ================================================================
//
// Kasa müşteriden geri geldiğinde yalnızca cari defter değil, depo stoğu da
// artmalı — fiziksel kasa envantere geri girdi. 24.08.2026'ya kadar bu belge
// bir Cari Çıkış dekontuydu (TBLCARCIKBASLIK); o tabloda Şube/Kasa/Depo
// sütunu HİÇ YOK (canlı şemada doğrulandı — bkz. §5.1 BELGE-DESENI.md), bu
// yüzden Vega'nın kendi ekranında bu alanlar boş kalıyor ve kullanıcı belgeyi
// Vega'da açtığında/kapatmaya çalıştığında belge "kapanmıyor".
//
// Kullanıcının Vega'nın kendi "Stok Giriş İade Fişi" ekranından ELLE
// oluşturduğu gerçek kayıt örnek alınarak yazılıyor (BELGENO A0000001,
// 24.08.2026, F0102/D0001) — tahminle değil, doğrulanmış alan değerleriyle:
// TBLSTKGIRBASLIK (BELGETIPI=34, IADE=1, GIRIS=1, OZELKOD1/2='MERKEZ' →
// Şube/Kasa alanları buraya yazılıyor), TBLSTKGIRHAREKET (satır),
// TBLSTOKHAREKETLERI (GIREN=adet, IZAHAT='34'), TBLDEPOENVANTER
// (ENVANTER=+adet — kasa geri stoğa girdi, satıştaki -miktar'ın tersi),
// TBLCARIHAREKETLERI (ALACAK, IZAHAT='34', OZELKOD='' — bu belge tipinde
// 'MERKEZ' DEĞİL, gerçek kayıtta boş görüldü), TBLCARIGENELHAREKET
// (BELGELINK=NULL, GECIKMEHESAPLA=NULL — elle geçiliyor, bkz.
// cariGenelHareketEkle).
//
// Bağlar (satisFaturasiYaz ile aynı desen, farklı tablolar):
//   TBLSTKGIRBASLIK.IND ──┬─→ TBLSTKGIRHAREKET.EVRAKNO
//                         ├─→ TBLSTOKHAREKETLERI.BELGENO   (sayı!)
//                         └─→ TBLDEPOENVANTER.BELGEIND
//   TBLSTKGIRHAREKET.IND ─┬─→ TBLSTOKHAREKETLERI.LN
//                         └─→ TBLDEPOENVANTER.HAREKETIND
async function stokGirisIadesiYaz(t, ayrinti) {
  const { v, firma, donem, cariInd, stokNo, stokKodu, stokAdi, stokTipi, birimEx, birim, carpan, adet, fiyat, depo, tarih, aciklama, onek } = ayrinti;

  const baslikTam = tablo(v, firma, donem, 'TBLSTKGIRBASLIK');
  const hareketTam = tablo(v, firma, donem, 'TBLSTKGIRHAREKET');
  const stokHareketTam = tablo(v, firma, donem, 'TBLSTOKHAREKETLERI');
  const envanterTam = tablo(v, firma, donem, 'TBLDEPOENVANTER');
  const belgeNo = await siradakiBelgeNo(t, v, firma, donem, onek || belgeOneki());

  const tutar = Number(adet) * Number(fiyat);

  const baslikInd = await ekle(
    t,
    baslikTam,
    {
      BELGENO: belgeNo,
      TARIH: tarih,
      ODEMETARIHI: tarih,
      FIRMANO: Number(cariInd),
      FIRMAADI: null,
      BELGETIPI: TIP_STOK_GIRIS_IADE,
      EKBELGETIPI: 0,
      HAREKETDEPOSU: Number(depo),
      TUTAR: tutar,
      ARATOPLAM: tutar,
      KDV: 0, // BIT sütun — bu belge tipinde her zaman 0 (kasa depozitosu KDV'siz)
      AK: 0,
      STOKHAREKETEYAZ: 1,
      CARIHAREKETEYAZ: 1,
      IPTAL: 0,
      IADE: 1,
      CONVERTED: 0,
      GIRIS: 1,
      PARABIRIMI: 'TL',
      KUR: 1,
      USERNO: 100,
      ALTNOT: aciklama || null,
      OZELKOD1: 'MERKEZ', // Şube
      OZELKOD2: 'MERKEZ', // Kasa
      YUVARLAMA: 0,
      ALLOWYUVARLAMA: 0,
      ODENEN: 0,
      ENTEGRE: 0,
      SATISSEKLI: 0,
      YURTDISI: 0,
      MUHASEBELESMEYECEK: 0,
      KAYNAK: 0
    },
    {
      zorunlu: ['BELGENO', 'FIRMANO', 'BELGETIPI'],
      ozel: { CREDATE: 'GETDATE()', LADATE: 'GETDATE()' }
    }
  );

  const kayitlar = [{ tablo: 'TBLSTKGIRBASLIK', ind: baslikInd, donemli: true }];

  const satirInd = await ekle(
    t,
    hareketTam,
    {
      EVRAKNO: baslikInd,
      DETAY: 0,
      TARIH: tarih,
      FIRMANO: Number(cariInd),
      STOKNO: Number(stokNo),
      MALINCINSI: stokAdi || stokKodu || '',
      STOKKODU: stokKodu || null,
      STOKTIPI: Number(stokTipi) || 0,
      MIKTAR: Number(adet),
      BIRIMMIKTAR: Number(carpan) || 1,
      BIRIM: birim || '',
      BIRIMEX: Number(birimEx),
      KDV: 0,
      // Maliyet alanlarının VegaWin deseni henüz doğrulanmadı; önceki
      // davranışı koru. Kart eşleşmesi düzeltmesi bu alanları değiştirmesin.
      AFIYATI: 1,
      FIYATI: Number(fiyat),
      GERCEKTOPLAM: tutar,
      DEPO: Number(depo),
      SATISKOSULU: 1,
      SERIMIKTAR: 1,
      ENVANTER: Number(adet),
      PARABIRIMI: 'TL',
      KUR: 1,
      GRUPMIKTAR: 1,
      ACIKLAMA: null
    },
    { zorunlu: ['EVRAKNO', 'STOKNO', 'MIKTAR'] }
  );
  kayitlar.push({ tablo: 'TBLSTKGIRHAREKET', ind: satirInd, donemli: true });

  const stokInd = await ekle(
    t,
    stokHareketTam,
    {
      EVRAKNO: belgeNo,
      BELGENO: baslikInd,
      LN: satirInd,
      IZAHAT: TIP_STOK_GIRIS_IADE,
      TARIH: tarih,
      STOKNO: Number(stokNo),
      FIRMANO: Number(cariInd),
      GIREN: Number(adet),
      CIKAN: 0,
      TUTAR: tutar,
      DEPO: Number(depo),
      KDV: 0,
      IADE: 1,
      BIRIMFIYAT: Number(fiyat),
      BIRIMMALIYET: Number(fiyat),
      BIRIMEX: Number(birimEx),
      PARABIRIMI: 'TL',
      KUR: 1,
      ACIKLAMA: null
    },
    {
      zorunlu: ['STOKNO', 'IZAHAT', 'GIREN'],
      ozel: { SIRALAMATARIHI: 'GETDATE()', SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
    }
  );
  kayitlar.push({ tablo: 'TBLSTOKHAREKETLERI', ind: stokInd, donemli: true });

  const envanterInd = await ekle(
    t,
    envanterTam,
    {
      TARIH: tarih,
      STOKNO: Number(stokNo),
      DEPO: Number(depo),
      ENVANTER: Number(adet), // pozitif — satıştaki -miktar'ın tersi, kasa stoğa geri girdi
      BELGETIPI: TIP_STOK_GIRIS_IADE,
      BELGEIND: baslikInd,
      HAREKETIND: satirInd,
      ACIKLAMA: null
    },
    {
      zorunlu: ['STOKNO', 'ENVANTER', 'BELGETIPI'],
      ozel: { SIRALAMATARIHI: 'GETDATE()', SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
    }
  );
  kayitlar.push({ tablo: 'TBLDEPOENVANTER', ind: envanterInd, donemli: true });

  const cari = await cariHareketEkle(t, {
    v, firma, donem, cariInd,
    izahat: TIP_STOK_GIRIS_IADE,
    borc: 0,
    alacak: tutar,
    belgeNo, tarih, aciklama,
    headerInd: baslikInd,
    ozelKod: '',
    belgeLink: null,
    gecikmeHesapla: null
  });
  kayitlar.push(...cari);

  return { belgeNo, belgeTipi: TIP_STOK_GIRIS_IADE, toplam: tutar, kayitlar };
}

// ================================================================
//  Belgeyi doğrudan Vega'ya yaz
// ================================================================
//
// Arayüzden gelen belge, hiçbir ara adım olmadan tek işlemde VEGADB'ye
// yazılır. Ürün kısmı kullanıcının bastığı tuşa göre satış faturası ya da
// (faturasız) Cari Giriş dekontu olarak yazılır — kasa depozitosu HİÇBİR
// durumda ayrı belge açmaz: satış faturasında faturanın 2. kalemi, faturasız
// akışta ürünle AYNI dekontun 2. kalemi olur (bkz. cariDekontuYaz →
// `kalemler`). 24.08.2026'dan önce ikisi hep ayrı belgeydi, kullanıcı tek
// belge istedi. Yön (Cari Giriş — "bize para girer, mal/kasa çıkar") ile
// borç/alacak ayrı parametre, bkz. cariDekontuYaz'daki giris/borcMu ayrımı.
// Müşteride kaç kasa durduğunun sayılabilmesi için ayrıca BD_KasaHareket
// defterine de düşer. Ürün satıp aynı anda ödeme alındıysa (tahsilat), ayrı
// bir cari giriş dekontu daha yazılır (bunu ürün belgesiyle birleştirmiyoruz
// — tahsilat farklı bir olay, ödeme geldiği an).
async function belgeYaz(secenek) {
  kilitKontrol();
  await yardimci.hazirla();

  const satirlar = Array.isArray(secenek.satirlar) ? secenek.satirlar : [];
  // Satırsız belgeye izin var: yalnız tahsilat girilen belge de yazılabilir
  // (05.09.2026 kullanıcı isteği). Aşağıda tahsilat okunduktan sonra denetlenir.
  if (!Number(secenek.cariInd)) throw new Error('Müşteri seçilmeli.');
  if (secenek.belgeTuru !== 'satisFaturasi' && secenek.belgeTuru !== 'cariCikis') {
    throw new Error('Belge türü "satisFaturasi" veya "cariCikis" olmalı.');
  }

  const { firma, donem } = await dogrula(secenek.firma, secenek.donem);
  const v = vt();
  const a = ayarOku();
  const depo = Number(secenek.depo != null ? secenek.depo : a.varsayilanDepo) || 0;
  const tarih = new Date(secenek.tarih || Date.now());
  const userNo = Number(secenek.userNo || 0);
  const cariInd = Number(secenek.cariInd);
  const cariAd = secenek.cariAd || null;
  const tahsilat = Number(secenek.tahsilat) || 0;
  const tahsilatAciklama = String(secenek.tahsilatAciklama || '').trim() || 'Tahsilat';
  const duzenlenenIslemId = Number(secenek.duzenlenenIslemId) || null;
  let duzenlenenKayit = null;
  if (duzenlenenIslemId) {
    duzenlenenKayit = await yardimci.islemGetir(duzenlenenIslemId);
    if (duzenlenenKayit.GeriAlindi) throw new Error('Geri alınmış belge düzenlenemez.');
    if (duzenlenenKayit.Konu !== 'satisFaturasi' && duzenlenenKayit.Konu !== 'cariCikis') {
      throw new Error('Bu belge türü düzenlenemez.');
    }
    if (duzenlenenKayit.Firma !== firma || duzenlenenKayit.Donem !== donem ||
        Number(duzenlenenKayit.CariInd) !== cariInd || duzenlenenKayit.Konu !== secenek.belgeTuru) {
      throw new Error('Düzenlemede firma, dönem, müşteri veya belge türü değiştirilemez.');
    }
  }

  // Ürün satırı olmayan (yalnız kasa ya da yalnız tahsilat) belge de geçerli;
  // stok kartı olmayan satır fatura/stok tarafına hiç gitmez.
  const urunSatirlari = satirlar.filter((s) => Number(s.stokNo) && Number(s.tutar) !== 0);
  const kasaSatirlari = satirlar.filter((s) => Number(s.kasaAdedi) > 0);
  if (kasaSatirlari.some((s) => !Number.isSafeInteger(Number(s.kasaStokNo)) ||
      Number(s.kasaStokNo) <= 0)) {
    throw new Error('Kasa adedi girilen her satırda geçerli bir kasa tipi seçilmeli.');
  }
  const urunTutari = urunSatirlari.reduce((t2, s) => t2 + (Number(s.tutar) || 0), 0);
  const kasaTutari = satirlar.reduce((t2, s) => t2 + (Number(s.kasaTutari) || 0), 0);

  if (!urunSatirlari.length && !kasaSatirlari.length && !tahsilat) {
    throw new Error('Belgeye en az bir satır ya da tahsilat girilmeli.');
  }

  if (secenek.belgeTuru === 'satisFaturasi' && (urunSatirlari.length || kasaSatirlari.length)) {
    if (!depo) {
      throw new Error('Satış faturası için depo seçilmelidir. Ayarlar ekranından depo seçin.');
    }
    for (const ad of ['TBLSATFATBASLIK', 'TBLSATFATHAREKET']) {
      if (!(await tabloVarMi(firma, donem, ad))) {
        throw new Error(
          `${firma}${donem}${ad} tablosu yok. Bu firma/dönemde satış faturası kesilemiyor; ` +
          '"Cari Çıkış" tuşunu kullanın.'
        );
      }
    }
  }

  // Ürün kartlarının güncel maliyet ve birim bilgisi. Kasa tipi Id'si stok
  // numarası değildir; kasa kartları transaction içinde kodla ayrıca çözülür.
  let maliyetHaritasi = new Map();
  if (secenek.belgeTuru === 'satisFaturasi' && (urunSatirlari.length || kasaSatirlari.length)) {
    const noLar = [...new Set(urunSatirlari.map((s) => Number(s.stokNo)))];
    if (noLar.length) {
      const kartlar = await sorgu(
      `SELECT S.IND AS stokNo, ISNULL(S.MALIYET, 0) AS maliyet,
              ISNULL(S.STOKTIPI, 0) AS stokTipi, ISNULL(S.STOKKODU, '') AS kod,
              ISNULL(B.BIRIMADI, '') AS birim, ISNULL(B.IND, 0) AS birimEx,
              ISNULL(B.CARPAN, 1) AS carpan
       FROM ${kart(v, firma, 'TBLSTOKLAR')} S
       LEFT JOIN ${kart(v, firma, 'TBLBIRIMLEREX')} B
              ON B.STOKNO = S.IND AND B.VARSAYILAN = 1
       WHERE S.IND IN (${noLar.map((n) => Number(n)).join(',')})`
      );
      maliyetHaritasi = new Map(kartlar.map((k) => [Number(k.stokNo), k]));
    }
  }

  const kdvOrani = Number(a.varsayilanKdv) || 0;
  const aciklama = ('Hizli Belge Doldurucu' + (secenek.fisNo ? ' - fis ' + secenek.fisNo : ''))
    .substring(0, 100);

  // Satır açıklaması PROGRAM ÜRETMİYOR; kullanıcı notu yalnızca uygulamanın
  // BD_BelgeSatir günlüğünde ve ayrıntılı raporunda saklanır. 03.09.2026
  // isteğiyle gerçek Vega belge satırına aktarımı kaldırıldı.
  const satirAciklamasi = (s) => {
    const m = String(s.aciklama == null ? '' : s.aciklama).trim();
    return m ? m.substring(0, 250) : null;
  };

  const onek = await onekTespitEt(firma, donem);

  const sonuc = await islem(async (t) => {
    const kasaHaritasi = secenek.belgeTuru === 'satisFaturasi'
      ? await kasaKartlariniCoz(firma, kasaSatirlari.map((s) => s.kasaStokNo), t)
      : new Map();
    // Düzenleme, eski belgeyi silip yenisini yazmayı TEK transaction içinde
    // yapar. Aşağıdaki herhangi bir INSERT hata verirse eski belge geri gelir.
    if (duzenlenenKayit) {
      let eskiYazilan;
      try { eskiYazilan = JSON.parse(duzenlenenKayit.Yazilan || '[]'); }
      catch (e) { throw new Error('Düzenlenecek belgenin bağlantı kaydı bozuk.'); }
      await vegaKaydiniGeriAl(t, eskiYazilan, firma, donem);
      await yardimci.islemKayitlariniTamSil(t, duzenlenenIslemId);
    }

    const yazilan = [];

    // Ürün de kasa da yoksa (yalnız tahsilat girilmiş) belge yazılmaz,
    // aşağıdaki tahsilat dekontu tek başına kalır.
    const belgeSatiriVar = !!(urunSatirlari.length || kasaSatirlari.length);

    if (secenek.belgeTuru === 'satisFaturasi' && belgeSatiriVar) {
      const fatSatirlari = urunSatirlari.map((s) => {
        const k = maliyetHaritasi.get(Number(s.stokNo)) || {};
        const tutar = Number(s.tutar) || 0;
        return {
          stokNo: Number(s.stokNo),
          stokAdi: s.stokAdi || k.ad || '',
          stokKodu: s.stokKodu || k.kod || null,
          stokTipi: Number(k.stokTipi || 0),
          miktar: Number(s.daraliMiktar) || 0,
          fiyat: Number(s.fiyat) || 0,
          tutar,
          kdvOrani,
          kdvTutari: kdvOrani ? Math.round(tutar * kdvOrani) / 100 : 0,
          maliyet: Number(k.maliyet || 0),
          birim: s.birim || k.birim || '',
          birimEx: s.birimEx != null ? Number(s.birimEx) : Number(k.birimEx || 0),
          carpan: Number(k.carpan || 1),
          // Kullanıcının rapor notu gerçek Vega fatura satırına yazılmaz.
          aciklama: null
        };
      });

      // Kasa depozitosu artık ayrı bir belge DEĞİL — faturanın 2. (3., ...)
      // kalemi. Depozito KDV'siz sayılıyor (satış değil, iade edilebilir
      // teminat); kdvOrani/kdvTutari bilerek 0.
      for (const s of kasaSatirlari) {
        const k = kasaHaritasi.get(Number(s.kasaStokNo));
        const tutar = Number(s.kasaTutari) || 0;
        fatSatirlari.push({
          stokNo: k.stokNo,
          stokAdi: k.ad,
          stokKodu: k.kod,
          stokTipi: Number(k.stokTipi || 0),
          miktar: Number(s.kasaAdedi) || 0,
          fiyat: Number(s.kasaDepozito) || 0,
          tutar,
          kdvOrani: 0,
          kdvTutari: 0,
          maliyet: Number(k.maliyet || 0),
          birim: k.birim || 'ADET',
          birimEx: Number(k.birimEx || 0),
          carpan: Number(k.carpan || 1),
          aciklama: 'KASA'
        });
      }

      const f = await satisFaturasiYaz(t, {
        v, firma, donem, cariInd, cariAd,
        satirlar: fatSatirlari, tarih, depo, userNo, aciklama, onek
      });
      yazilan.push({ ad: 'Ürün satışı', tur: 'satisFaturasi', ...f });
    } else if (belgeSatiriVar && (urunTutari !== 0 || kasaTutari !== 0)) {
      // "Cari Giriş Olarak Kaydet" (fatura yok): ürün VE kasa tek belgede,
      // tek başlık altında iki kalem — kullanıcı isteğiyle 24.08.2026'da
      // birleştirildi (önceden ikisi ayrı belgeydi). Yön Cari GİRİŞ: "bize
      // para girer, mal/kasa çıkar" — kullanıcının kendi tarifi. Borç/alacak
      // ayrı: müşteri hâlâ BORÇLANIR (satış/depozito gibi), bu yüzden
      // borcMu:true (kasa iadesindeki ters yönle karıştırılmasın, bkz.
      // kasaIadesiYaz).
      const kalemler = [];
      if (urunTutari !== 0) kalemler.push({ tutar: urunTutari, aciklama: aciklama });
      if (kasaTutari !== 0) kalemler.push({ tutar: kasaTutari, aciklama: 'KASA TUTARI' });
      const d = await cariDekontuYaz(t, {
        v, firma, donem, cariInd, kalemler, tarih, userNo,
        giris: true, borcMu: true, aciklama, onek
      });
      yazilan.push({ ad: 'Ürün satışı + kasa', tur: 'cariCikis', ...d });
    }
    const kasaBelgeNo = null; // artik hep ayni belgenin icinde, ayri no yok

    // Tahsilat — ürün satılıp aynı anda ödeme alındıysa ayrı bir cari giriş.
    let tahsilatBelgeNo = null;
    if (tahsilat > 0) {
      const d = await cariDekontuYaz(t, {
        v, firma, donem, cariInd, tutar: tahsilat, tarih, userNo,
        giris: true, aciklama: tahsilatAciklama, satirAciklamasi: null, onek,
        // Alınan ödeme varsayılan olarak NAKİT: fişte ödeme aracı boş
        // kalmasın ve para Vega'nın kasasına da girsin (05.09.2026).
        nakit: true
      });
      yazilan.push({ ad: 'Tahsilat', tur: 'tahsilat', aciklama: tahsilatAciklama, ...d });
      tahsilatBelgeNo = d.belgeNo;
    }

    const belgeNo = yazilan[0] ? yazilan[0].belgeNo : null;

    const islemId = await yardimci.islemYaz(t, {
      konu: secenek.belgeTuru,
      firma, donem, tarih, cariInd, cariAd,
      belgeNo: yazilan.map((y) => y.belgeNo).join(' / '),
      tutar: urunTutari + kasaTutari,
      aciklama: secenek.fisNo ? 'Fiş ' + secenek.fisNo : null,
      fisNo: secenek.fisNo || null,
      yazilan,
      kullanici: secenek.kullanici
    });

    // Belge satır günlüğü — haftalık müşteri raporunun ürün dökümü buradan
    // okunuyor. Faturasız (Cari Giriş) belgede Vega'da satır kırılımı hiç
    // olmadığı için tek kaynak bu; faturalı belgede de aynı satırlar yazılıyor
    // ki rapor iki akışta da aynı görünsün.
    let siraNo = 0;
    for (const s of satirlar) {
      const tutar = Number(s.tutar) || 0;
      const kasaTutari = Number(s.kasaTutari) || 0;
      if (!tutar && !kasaTutari && !Number(s.daraliMiktar)) continue;
      await yardimci.belgeSatirYaz(t, {
        islemId, firma, donem, tarih, cariInd, cariAd,
        belgeTuru: secenek.belgeTuru,
        belgeNo,
        fisNo: secenek.fisNo || null,
        siraNo: ++siraNo,
        stokNo: s.stokNo,
        stokKodu: s.stokKodu,
        stokAdi: s.stokAdi,
        kasaAdedi: s.kasaAdedi,
        kasaTipiKod: s.kasaTipiKod,
        kasaDepozito: s.kasaDepozito,
        kasaTutari,
        brutMiktar: s.brutMiktar,
        dara: s.kasaDarasi,
        daraliMiktar: s.daraliMiktar,
        fiyat: s.fiyat,
        tutar,
        aciklama: satirAciklamasi(s)
      });
    }

    // Kasa depozito defteri — kaç kasa dışarıda, adet bazında.
    for (const s of kasaSatirlari) {
      await yardimci.kasaHareketiYaz(t, {
        firma, donem, tarih, cariInd, cariAd,
        stokNo: s.kasaStokNo,
        stokKodu: s.kasaTipiKod,
        stokAdi: s.kasaTipiAdi || s.kasaTipiKod,
        adet: Number(s.kasaAdedi),
        depozito: Number(s.kasaDepozito) || 0,
        tutar: Number(s.kasaTutari) || 0,
        yon: 'verilen',
        islemId,
        kullanici: secenek.kullanici
      });
    }

    return { belgeNo, kasaBelgeNo, tahsilatBelgeNo, islemId, yazilan };
  });

  return {
    tamam: true,
    belgeNo: sonuc.belgeNo,
    kasaBelgeNo: sonuc.kasaBelgeNo,
    tahsilatBelgeNo: sonuc.tahsilatBelgeNo,
    islemId: sonuc.islemId,
    urunTutari, kasaTutari, tahsilat,
    toplam: urunTutari + kasaTutari,
    yazilan: sonuc.yazilan,
    duzenlendi: !!duzenlenenIslemId
  };
}

// ================================================================
//  Ödeme (tahsilat) — Ödemeler ekranı
// ================================================================
//
// 17.09.2026 kullanıcı isteği: belgeden bağımsız ödeme girişi, yöntemi
// seçilerek (Nakit / Havale / EFT) ve açıklamalı. Belge Gir'deki tahsilatla
// aynı Cari Giriş dekontu; fark yalnız ödeme aracı:
//   nakit  → IZAHAT 1 + TBLKASA gelir satırı (kasaya girer)
//   havale → IZAHAT 11, hareket açıklaması "HAVALE" (kasaya girmez)
//   eft    → IZAHAT 11, hareket açıklaması "EFT"    (kasaya girmez)
// Başlık açıklaması "HAVALE - kullanıcı notu" biçiminde; Ekstre ve ayrıntılı
// raporun ÖDEME bloğu bunu gösterir. Geri alma Son Belgeler'den yapılır.
//
// 30.09.2026 müşteri isteği: ekrandan yöntem seçimi kalktı, yerine Fiş No
// geldi. Yeni ödeme hep NAKİT yazılır (Belge Gir'deki tahsilatla aynı). Eski
// bir Havale/EFT kaydı düzenlenirse yöntemi korunur — düzeltme parayı
// kasaya sokmasın. Fiş no BD_Islem.FisNo'da ve başlık açıklamasında durur
// ("Fiş 123 - not"), böylece Ekstre ve Vega ekranında da görünür.
//
// duzenlenenIslemId verilirse eski ödeme aynı transaction içinde silinip
// yenisi yazılır; herhangi bir adım düşerse eski ödeme aynen kalır.
async function duzenlenecekKaydiOku(islemId, konular, firma, donem) {
  const kayit = await yardimci.islemGetir(islemId);
  if (kayit.GeriAlindi) throw new Error('Geri alınmış kayıt düzenlenemez.');
  if (!konular.includes(kayit.Konu)) throw new Error('Bu kayıt türü burada düzenlenemez.');
  if (kayit.Firma !== firma || kayit.Donem !== donem) {
    throw new Error('Kayıt başka firma/döneme ait. Önce Ayarlar ekranından o dönemi seçin.');
  }
  let yazilan;
  try { yazilan = JSON.parse(kayit.Yazilan || '[]'); }
  catch (e) { throw new Error('Düzenlenecek kaydın bağlantı bilgisi bozuk.'); }
  return { kayit, yazilan };
}

async function odemeYaz(secenek) {
  kilitKontrol();
  await yardimci.hazirla();

  const tutar = Math.round((Number(secenek.tutar) || 0) * 100) / 100;
  if (!(tutar > 0)) throw new Error('Ödeme tutarı sıfırdan büyük olmalı.');
  const cariInd = Number(secenek.cariInd);
  if (!cariInd) throw new Error('Müşteri seçilmeli.');

  const { firma, donem } = await dogrula(secenek.firma, secenek.donem);
  const duzenlenenIslemId = Number(secenek.duzenlenenIslemId) || null;
  const eski = duzenlenenIslemId
    ? await duzenlenecekKaydiOku(duzenlenenIslemId, ['tahsilat'], firma, donem)
    : null;

  const eskiYontem = eski && eski.yazilan[0] ? String(eski.yazilan[0].yontem || '') : '';
  const yontemKodu = String(secenek.yontem || eskiYontem || 'nakit').toLowerCase();
  const yontem = ODEME_YONTEMLERI[yontemKodu];
  if (!yontem) throw new Error('Ödeme yöntemi Nakit, Havale ya da EFT olmalı.');

  const v = vt();
  const tarih = new Date(secenek.tarih || Date.now());
  const not = String(secenek.aciklama || '').trim();
  const fisNo = String(secenek.fisNo || '').trim().substring(0, 50);
  const parcalar = [];
  if (yontem.arac !== 'nakit') parcalar.push(yontem.etiket);
  if (fisNo) parcalar.push('Fiş ' + fisNo);
  if (not) parcalar.push(not);
  const baslikAciklamasi = (parcalar.join(' - ') || 'Tahsilat').substring(0, 250);
  const onek = await onekTespitEt(firma, donem);

  return islem(async (t) => {
    if (eski) {
      await vegaKaydiniGeriAl(t, eski.yazilan, firma, donem);
      await yardimci.islemKayitlariniTamSil(t, duzenlenenIslemId);
    }

    const d = await cariDekontuYaz(t, {
      v, firma, donem, cariInd, tutar, tarih,
      userNo: Number(secenek.userNo || 0),
      giris: true,
      aciklama: baslikAciklamasi,
      // Nakitte satır açıklaması Belge Gir tahsilatıyla aynı (boş); bankada
      // havale/EFT ayrımı yalnız burada durduğu için yazılır.
      satirAciklamasi: yontem.arac === 'banka' ? yontem.etiket : null,
      odemeAraci: yontem.arac,
      onek
    });

    const islemId = await yardimci.islemYaz(t, {
      konu: 'tahsilat',
      firma, donem, tarih, cariInd, cariAd: secenek.cariAd || null,
      belgeNo: d.belgeNo,
      tutar,
      aciklama: baslikAciklamasi,
      fisNo: fisNo || null,
      yazilan: [{
        ad: 'Tahsilat', tur: 'tahsilat', yontem: yontemKodu,
        aciklama: baslikAciklamasi, not, fisNo, ...d
      }],
      kullanici: secenek.kullanici
    });

    return {
      tamam: true, belgeNo: d.belgeNo, islemId, tutar, yontem: yontemKodu, fisNo,
      duzenlendi: !!eski
    };
  });
}

// ================================================================
//  Kasa iadesi — doğrudan Vega'ya yaz
// ================================================================
//
// Kasa fiziksel olarak geri geldiği için "Stok Giriş İade Fişi" olarak
// yazılır (bkz. stokGirisIadesiYaz) — hem depo stoğu artar hem müşterinin
// cari defterindeki depozito borcu ALACAK ile azalır. 24.08.2026'ya kadar
// yalnızca cari defter tarafı bir Cari Çıkış dekontuyla (TBLCARCIKBASLIK)
// yazılıyordu; o tabloda Şube/Kasa/Depo sütunu HİÇ YOK, bu yüzden Vega'nın
// kendi ekranında belge "kapanmıyordu" (kullanıcı raporu + canlı şema
// doğrulaması). TBLSTKGIRBASLIK/HAREKET bu kurulumda yoksa ya da depo
// seçili değilse eski yola (yalnız cari dekont) düşülür — geriye dönük
// uyumluluk için.
//
// Kapanan depozito kasa kartının güncel fiyatından değil BD_KasaHareket'teki
// açık adet/tutardan hesaplanır. Açık tutar sıfırsa Vega'ya parasal belge
// yazılmaz, ama fiziksel kasa iadesi deftere yine işlenir.
//
// 03.10.2026 müşteri isteği — iki ekleme:
//   1. Aynı fişte birden çok kasa tipi ("2. kasa için satır ekle"):
//      `satirlar` dizisi. Her satır kendi BD_Islem kaydı ve kendi Vega
//      belgesiyle yazılır (Son Belgeler'de ayrı satır, ayrı ✎); hepsi TEK
//      transaction — biri düşerse hiçbiri yazılmaz. Aynı tip iki kez
//      girilirse ikinci satır birincinin düştüğü adetten sonra denetlenir.
//   2. Birim fiyat: kasa 20'ye verilip 15'e geri alınabiliyor. Kullanıcıyla
//      sayıyla teyit edildi (10 kasa × 20 = 200 depozito, 15'ten iade):
//      müşterinin depozito borcu YİNE TAMAMEN kapanır (200), kasalar stoğa
//      girilen fiyattan girer (Stok Giriş İade Fişi 150), aradaki 50 ayrı bir
//      Cari Çıkış dekontuyla (ALACAK) kapatılır. Birim fiyat boş gelirse ya da
//      açık depozitonun birim fiyatına eşitse eski davranış: tek fiş, fark yok.
//      Açık depozitonun birim fiyatından YÜKSEK fiyat reddedilir — müşteriye
//      vermediğimiz depozitoyu geri ödemiş oluruz.
//
// BD_Islem.BelgeNo: "fiş" ya da "fiş / fark dekontu". Ekstredeki iade adedi
// ilk numaraya bağlanır (bkz. db/vega.js kasaIadeAdetBagi).
async function kasaIadesiYaz(secenek) {
  kilitKontrol();
  await yardimci.hazirla();

  if (!Number(secenek.cariInd)) throw new Error('Müşteri seçilmeli.');
  const satirlar = (Array.isArray(secenek.satirlar) && secenek.satirlar.length)
    ? secenek.satirlar
    : [{
        stokNo: secenek.stokNo, stokKodu: secenek.stokKodu, stokAdi: secenek.stokAdi,
        adet: secenek.adet, birimFiyat: secenek.birimFiyat
      }];
  satirlar.forEach((s, i) => {
    const sira = satirlar.length > 1 ? `${i + 1}. satır: ` : '';
    if (!s.stokNo) throw new Error(sira + 'Kasa tipi seçilmeli.');
    if (!(Number(s.adet) > 0)) throw new Error(sira + 'İade adedi sıfırdan büyük olmalı.');
    if (s.birimFiyat != null && s.birimFiyat !== '' && !(Number(s.birimFiyat) >= 0)) {
      throw new Error(sira + 'Birim fiyat geçersiz.');
    }
  });

  const { firma, donem } = await dogrula(secenek.firma, secenek.donem);
  const v = vt();
  const cariInd = Number(secenek.cariInd);
  const tarih = new Date(secenek.tarih || Date.now());
  // 30.09.2026: kasa iadesine fiş no + düzeltme (bkz. odemeYaz).
  const fisNo = String(secenek.fisNo || '').trim().substring(0, 50);
  const duzenlenenIslemId = Number(secenek.duzenlenenIslemId) || null;
  if (duzenlenenIslemId && satirlar.length > 1) {
    throw new Error('Düzenlenen iade tek satırlıdır; ek kasa tipini ayrı iade olarak girin.');
  }
  const eski = duzenlenenIslemId
    ? await duzenlenecekKaydiOku(duzenlenenIslemId, ['KasaIade'], firma, donem)
    : null;

  const onek = await onekTespitEt(firma, donem);
  const a = ayarOku();
  const depo = Number(secenek.depo != null ? secenek.depo : a.varsayilanDepo) || 0;

  const stokGirisVarMi = depo &&
    (await tabloVarMi(firma, donem, 'TBLSTKGIRBASLIK')) &&
    (await tabloVarMi(firma, donem, 'TBLSTKGIRHAREKET'));

  const sonuclar = await islem(async (t) => {
    // Eski iade önce silinir: açık kasa sayısı düzeltilen iadeden önceki
    // haline döner, yeni adet ona göre denetlenir.
    if (eski) {
      await vegaKaydiniGeriAl(t, eski.yazilan, firma, donem);
      await yardimci.islemKayitlariniTamSil(t, duzenlenenIslemId);
    }

    const yazilanlar = [];
    for (const s of satirlar) {
      yazilanlar.push(await kasaIadeSatiriYaz(t, {
        v, firma, donem, cariInd, cariAd: secenek.cariAd, tarih, fisNo, depo, onek,
        stokGirisVarMi, userNo: secenek.userNo, kullanici: secenek.kullanici
      }, s));
    }
    return yazilanlar;
  });

  const ilk = sonuclar[0];
  return {
    tamam: true,
    satirlar: sonuclar,
    // Tek satırlı eski çağrılar için ilk satırın özeti.
    belgeNo: ilk.belgeNo,
    islemId: ilk.islemId,
    adet: ilk.adet,
    depozito: ilk.depozito,
    tutar: ilk.tutar,
    kalanAdet: ilk.kalanAdet,
    kalanTutar: ilk.kalanTutar,
    duzenlendi: !!eski
  };
}

async function kasaIadeSatiriYaz(t, o, s) {
  const { v, firma, donem, cariInd, tarih, fisNo, depo, onek, stokGirisVarMi } = o;
  const adet = Number(s.adet);
  const stokKodu = s.stokKodu || null;
  const aciklama = `KASA IADE${stokKodu ? ' - ' + stokKodu : ''}` +
    (fisNo ? ' - Fiş ' + fisNo : '');

  // Güncel kasa kartı fiyatı iade borcunu değiştirmez. Örneğin 9 kasa
  // 500 TL'den verildiyse, kart bugün 300 TL olsa bile 9'u geri geldiğinde
  // açık 4.500 TL'nin tamamı kapanır. Kısmi iadede açık tutarın adet başına
  // ortalaması kullanılır; son iadede kuruş kalmaması için tamamı alınır.
  const acik = await yardimci.acikKasaDurumu(firma, cariInd, s.stokNo, t);
  if (adet > acik.acikAdet + 0.0005) {
    throw new Error(
      `Bu müşteride ${stokKodu || 'bu'} tipinden ${acik.acikAdet} kasa açık görünüyor; ${adet} kasa iade alınamaz.`
    );
  }
  const tamIade = Math.abs(adet - acik.acikAdet) < 0.0005;
  const tutar = tamIade
    ? acik.acikTutar
    : Math.round((acik.acikTutar / acik.acikAdet) * adet * 100) / 100;
  const depozito = adet ? tutar / adet : 0;

  // Birim fiyat (kasanın geri alındığı fiyat). Boşsa depozitonun kendisi.
  // Ortalama depozito kuruşlu çıkabildiği için (100 TL / 3 kasa) ekranda
  // yuvarlanmış hali gelirse fark kuruş düzeyinde kalır — o zaman fark
  // dekontu açılmaz, fiş depozitonun tam değeriyle yazılır.
  const fiyatGirildi = s.birimFiyat != null && s.birimFiyat !== '';
  let fisFiyati = depozito;
  let fisTutari = tutar;
  let fark = 0;
  if (fiyatGirildi) {
    const fiyat = Number(s.birimFiyat);
    // Sıfır fiyatla stok fişi tutarsız kalır (stoğa bedelsiz giriş + tüm
    // depozito fark dekontundan); kullanıcı boş bırakmalı ya da fiyat girmeli.
    if (tutar > 0 && !(fiyat > 0)) {
      throw new Error(`${stokKodu || 'Kasa'}: birim fiyat sıfır olamaz; açık depozitodan iade için boş bırakın.`);
    }
    const girilenTutar = Math.round(fiyat * adet * 100) / 100;
    const kalan = Math.round((tutar - girilenTutar) * 100) / 100;
    const kurusPayi = Math.max(0.01, adet * 0.005);
    if (kalan < -kurusPayi) {
      throw new Error(
        `${stokKodu || 'Kasa'}: birim fiyat (${fiyat.toLocaleString('tr-TR')} TL), müşterideki açık depozitonun ` +
        `birim fiyatından (${(Math.round(depozito * 100) / 100).toLocaleString('tr-TR')} TL) büyük olamaz.`
      );
    }
    if (kalan > kurusPayi) {
      fisFiyati = fiyat;
      fisTutari = girilenTutar;
      fark = kalan;
    }
  }

  const yazilan = [];
  let fisBelgeNo = null;
  let farkBelgeNo = null;

  if (fisTutari > 0 && stokGirisVarMi) {
    const kasaKarti = (await kasaKartlariniCoz(firma, [s.stokNo], t))
      .get(Number(s.stokNo));
    const fis = await stokGirisIadesiYaz(t, {
      v, firma, donem, cariInd,
      stokNo: kasaKarti.stokNo, stokKodu: kasaKarti.kod,
      stokAdi: kasaKarti.ad, stokTipi: kasaKarti.stokTipi,
      birimEx: kasaKarti.birimEx, birim: kasaKarti.birim,
      carpan: kasaKarti.carpan,
      adet, fiyat: fisFiyati, depo, tarih, aciklama, onek
    });
    fisBelgeNo = fis.belgeNo;
    yazilan.push({
      ad: 'Kasa iadesi', tur: 'kasaIade', ...fis,
      birimFiyat: fiyatGirildi ? Number(s.birimFiyat) : null
    });
  } else if (fisTutari > 0) {
    // Stok giriş fişi yazılamayan kurulum: depozitonun tamamı tek cari
    // dekontla kapanır, fark ayrıca açılmaz (stok değeri zaten yazılmıyor).
    const dekont = await cariDekontuYaz(t, {
      v, firma, donem, cariInd, tutar,
      tarih, userNo: Number(o.userNo || 0),
      // Kasa iadesi: parayı biz müşteriye veriyoruz → Cari ÇIKIŞ. Müşterinin
      // kasa depozito borcu bu kadar azalır → ALACAK (borcMu:false).
      giris: false,
      borcMu: false,
      aciklama,
      onek
    });
    fisBelgeNo = dekont.belgeNo;
    fark = 0;
    yazilan.push({ ad: 'Kasa iadesi', tur: 'kasaIade', ...dekont, birimFiyat: null });
  }

  if (fark > 0 && fisBelgeNo) {
    const farkAciklamasi = `KASA IADE FARKI${stokKodu ? ' - ' + stokKodu : ''}` +
      (fisNo ? ' - Fiş ' + fisNo : '');
    const dekont = await cariDekontuYaz(t, {
      v, firma, donem, cariInd, tutar: fark,
      tarih, userNo: Number(o.userNo || 0),
      giris: false,
      borcMu: false,
      aciklama: farkAciklamasi,
      onek
    });
    farkBelgeNo = dekont.belgeNo;
    yazilan.push({ ad: 'Kasa iade farkı', tur: 'kasaIadeFarki', ...dekont });
  }

  const belgeNo = [fisBelgeNo, farkBelgeNo].filter(Boolean).join(' / ') || null;
  const islemId = await yardimci.islemYaz(t, {
    konu: 'KasaIade',
    firma, donem, tarih, cariInd, cariAd: o.cariAd,
    belgeNo,
    tutar,
    aciklama: 'Kasa iadesi',
    fisNo: fisNo || null,
    yazilan,
    kullanici: o.kullanici
  });

  await yardimci.kasaHareketiYaz(t, {
    firma, donem, tarih, cariInd, cariAd: o.cariAd,
    stokNo: s.stokNo,
    stokKodu,
    stokAdi: s.stokAdi || null,
    adet: -adet,
    depozito,
    tutar: -tutar,
    yon: 'iade',
    islemId,
    kullanici: o.kullanici
  });

  return {
    belgeNo: fisBelgeNo,
    farkBelgeNo,
    islemId,
    stokKodu,
    adet,
    depozito,
    tutar,
    birimFiyat: fiyatGirildi && fark > 0 ? fisFiyati : null,
    fisTutari: fisBelgeNo ? (fark > 0 ? fisTutari : tutar) : 0,
    fark,
    kalanAdet: acik.acikAdet - adet,
    kalanTutar: Math.round((acik.acikTutar - tutar) * 100) / 100
  };
}

// ================================================================
//  Geri alma
// ================================================================
//
// BD_Islem'de hangi tabloya hangi IND'in yazıldığı durduğu için geri alma
// tam olarak o satırları siler. Ters sırada silinir: önce bağlı satırlar,
// sonra başlık. Bağlı BD_KasaHareket satırları da silinir.
async function vegaKaydiniGeriAl(t, kayitlar, firma, donem) {
  const v = vt();
  let silinen = 0;
  const tersSira = [];
  for (const grup of kayitlar) {
    for (const s of grup.kayitlar || []) tersSira.push(s);
    // Alış faturasının değiştirdiği stok kartı alış fiyatları (§45.3).
    for (const g of grup.kartGeri || []) await kartAlisFiyatiniGeriAl(t, v, firma, g);
  }
  tersSira.reverse();

  for (const s of tersSira) {
    const tam = s.donemli
      ? tablo(v, firma, donem, s.tablo)
      : kart(v, firma, s.tablo);
    const r = await t.calistir(`DELETE FROM ${tam} WHERE IND = @ind`, { ind: Number(s.ind) });
    silinen += r[0] || 0;
  }
  return silinen;
}

async function belgeGeriAl(secenek) {
  kilitKontrol();
  const islemId = Number(secenek.islemId);
  const kayit = await yardimci.islemGetir(islemId);
  if (kayit.GeriAlindi) throw new Error('Bu işlem zaten geri alınmış.');
  if (!kayit.Yazilan) throw new Error("Bu işlemde Vega'ya yazılmış bir kayıt yok.");

  const yazilan = JSON.parse(kayit.Yazilan);

  const silinen = await islem(async (t) => {
    const s = await vegaKaydiniGeriAl(t, yazilan, kayit.Firma, kayit.Donem);
    await yardimci.islemKayitlariniTamSil(t, islemId);
    return s;
  });

  return { tamam: true, silinenSatir: silinen };
}

module.exports = {
  yazmaAcikMi,
  kilitKontrol,
  // Vega tablosuna şema uyumlu INSERT — cari kartı açma da kullanıyor (db/cari.js).
  ekle,
  belgeYaz,
  odemeYaz,
  alisFaturasiKaydet,
  kasaIadesiYaz,
  belgeGeriAl,
  belgeOneki,
  onekTespitEt,
  TIP_SATIS_FATURASI,
  TIP_CARI_CIKIS,
  TIP_CARI_GIRIS,
  TIP_STOK_GIRIS_IADE,
  TIP_ALIS_FATURASI
};
