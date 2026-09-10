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
const BELGE_NO_TABLOLARI = ['TBLSATFATBASLIK', 'TBLCARCIKBASLIK', 'TBLCARGIRBASLIK', 'TBLSTKGIRBASLIK'];

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

async function subeKasaAdiOku(baslikTablosu) {
  if (subeKasaOnbellek.has(baslikTablosu)) return subeKasaOnbellek.get(baslikTablosu);
  const bekleyen = (async () => {
    try {
      const r = await sorgu(
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
  const nakit = !!ayrinti.nakit;
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
  const yer = await subeKasaAdiOku(baslikTam);

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
    if (nakit) {
      alanlar.IZAHAT = ODEME_NAKIT;
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
    islemIzahat: nakit ? ODEME_NAKIT : undefined
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
  const { v, firma, donem, cariInd, stokNo, stokKodu, adet, fiyat, depo, tarih, aciklama, onek } = ayrinti;

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
      MALINCINSI: stokKodu || '',
      STOKKODU: stokKodu || null,
      STOKTIPI: 0,
      MIKTAR: Number(adet),
      BIRIMMIKTAR: 1,
      BIRIM: 'ADET',
      BIRIMEX: Number(stokNo),
      KDV: 0,
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
      BIRIMEX: Number(stokNo),
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
  const kasaSatirlari = satirlar.filter((s) => Number(s.kasaAdedi) > 0 && s.kasaStokNo);
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

  // Stok kartlarının güncel maliyet ve birim bilgisi — fatura satırına yazılıyor.
  // Satış faturasında kasa da kendi kartı üzerinden 2. kalem olarak yazılıyor
  // (aşağıda), o yüzden kasaSatirlari'nın stokNo'ları da aynı sorguya dahil.
  let maliyetHaritasi = new Map();
  if (secenek.belgeTuru === 'satisFaturasi' && (urunSatirlari.length || kasaSatirlari.length)) {
    const noLar = [
      ...urunSatirlari.map((s) => Number(s.stokNo)),
      ...kasaSatirlari.map((s) => Number(s.kasaStokNo))
    ];
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
        const k = maliyetHaritasi.get(Number(s.kasaStokNo)) || {};
        const tutar = Number(s.kasaTutari) || 0;
        fatSatirlari.push({
          stokNo: Number(s.kasaStokNo),
          stokAdi: s.kasaTipiAdi || k.ad || 'KASA',
          stokKodu: s.kasaTipiKod || k.kod || null,
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
// İade bedeli kasa kartının güncel fiyatından değil BD_KasaHareket'teki açık
// adet/tutardan hesaplanır. Açık tutar sıfırsa Vega'ya parasal belge yazılmaz,
// ama fiziksel kasa iadesi deftere yine işlenir.
async function kasaIadesiYaz(secenek) {
  kilitKontrol();
  await yardimci.hazirla();

  const adet = Number(secenek.adet);
  if (!(adet > 0)) throw new Error('İade adedi sıfırdan büyük olmalı.');
  if (!Number(secenek.cariInd)) throw new Error('Müşteri seçilmeli.');
  if (!secenek.stokNo) throw new Error('Kasa tipi seçilmeli.');

  const { firma, donem } = await dogrula(secenek.firma, secenek.donem);
  const v = vt();
  const cariInd = Number(secenek.cariInd);
  const tarih = new Date(secenek.tarih || Date.now());

  const onek = await onekTespitEt(firma, donem);
  const a = ayarOku();
  const depo = Number(secenek.depo != null ? secenek.depo : a.varsayilanDepo) || 0;
  const aciklama = `KASA IADE${secenek.stokKodu ? ' - ' + secenek.stokKodu : ''}`;

  const stokGirisVarMi = depo &&
    (await tabloVarMi(firma, donem, 'TBLSTKGIRBASLIK')) &&
    (await tabloVarMi(firma, donem, 'TBLSTKGIRHAREKET'));

  const sonuc = await islem(async (t) => {
    // Güncel kasa kartı fiyatı iade borcunu değiştirmez. Örneğin 9 kasa
    // 500 TL'den verildiyse, kart bugün 300 TL olsa bile 9'u geri geldiğinde
    // açık 4.500 TL'nin tamamı kapanır. Kısmi iadede açık tutarın adet başına
    // ortalaması kullanılır; son iadede kuruş kalmaması için tamamı alınır.
    const acik = await yardimci.acikKasaDurumu(firma, cariInd, secenek.stokNo, t);
    if (adet > acik.acikAdet) {
      throw new Error(
        `Bu müşteride bu tipten ${acik.acikAdet} kasa açık görünüyor; ${adet} kasa iade alınamaz.`
      );
    }
    const tamIade = Math.abs(adet - acik.acikAdet) < 0.0005;
    const tutar = tamIade
      ? acik.acikTutar
      : Math.round((acik.acikTutar / acik.acikAdet) * adet * 100) / 100;
    const depozito = adet ? tutar / adet : 0;

    let dekont = null;
    if (tutar > 0 && stokGirisVarMi) {
      dekont = await stokGirisIadesiYaz(t, {
        v, firma, donem, cariInd,
        stokNo: secenek.stokNo, stokKodu: secenek.stokKodu,
        adet, fiyat: depozito, depo, tarih, aciklama, onek
      });
    } else if (tutar > 0) {
      dekont = await cariDekontuYaz(t, {
        v, firma, donem, cariInd, tutar,
        tarih, userNo: Number(secenek.userNo || 0),
        // Kasa iadesi: parayı biz müşteriye veriyoruz → Cari ÇIKIŞ. Müşterinin
        // kasa depozito borcu bu kadar azalır → ALACAK (borcMu:false).
        giris: false,
        borcMu: false,
        aciklama,
        onek
      });
    }

    const islemId = await yardimci.islemYaz(t, {
      konu: 'KasaIade',
      firma, donem, tarih, cariInd, cariAd: secenek.cariAd,
      belgeNo: dekont ? dekont.belgeNo : null,
      tutar,
      aciklama: 'Kasa iadesi',
      yazilan: dekont ? [{ ad: 'Kasa iadesi', tur: 'kasaIade', ...dekont }] : [],
      kullanici: secenek.kullanici
    });

    await yardimci.kasaHareketiYaz(t, {
      firma, donem, tarih, cariInd, cariAd: secenek.cariAd,
      stokNo: secenek.stokNo,
      stokKodu: secenek.stokKodu,
      stokAdi: secenek.stokAdi,
      adet: -adet,
      depozito,
      tutar: -tutar,
      yon: 'iade',
      islemId,
      kullanici: secenek.kullanici
    });

    return {
      belgeNo: dekont ? dekont.belgeNo : null,
      islemId,
      depozito,
      tutar,
      kalanAdet: acik.acikAdet - adet,
      kalanTutar: Math.round((acik.acikTutar - tutar) * 100) / 100
    };
  });

  return {
    tamam: true,
    belgeNo: sonuc.belgeNo,
    islemId: sonuc.islemId,
    adet,
    depozito: sonuc.depozito,
    tutar: sonuc.tutar,
    kalanAdet: sonuc.kalanAdet,
    kalanTutar: sonuc.kalanTutar
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
  belgeYaz,
  kasaIadesiYaz,
  belgeGeriAl,
  belgeOneki,
  onekTespitEt,
  TIP_SATIS_FATURASI,
  TIP_CARI_CIKIS,
  TIP_CARI_GIRIS,
  TIP_STOK_GIRIS_IADE
};
