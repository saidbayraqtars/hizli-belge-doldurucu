'use strict';

// ================================================================
//  VEGADB'YE YAZMA — VARSAYILAN OLARAK KAPALI
// ================================================================
//
// ayarlar.json içindeki "vegayaYazmaAktif" true yapılmadan bu dosyadaki hiçbir
// fonksiyon VEGADB'ye tek satır yazmaz. Kayıt yine programın kendi
// veritabanında tutulur, sonradan buradan Vega'ya gönderilir.
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
// verirse hiçbir satır kalmaz, yarım belge çıkmaz. Yazılan satırların tablo
// adı ve IND'i kendi veritabanımızda saklanır; geri alma bunları siler.

const { sorgu, calistir, islem } = require('./sql');
const { ayarOku } = require('./ayar');
const { dogrula, tablo, kart, tabloVarMi } = require('./firma');
const kayit = require('./kayit');

function vt() {
  return ayarOku().vegaVeritabani;
}

function kilitKontrol() {
  if (!ayarOku().vegayaYazmaAktif) {
    const hata = new Error(
      "Vega'ya yazma kapalı. Kayıt yalnızca programın kendi veritabanında tutuldu. " +
      'Açmak için Ayarlar ekranındaki "Vega\'ya yazma" kilidini kaldırın.'
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

async function sutunlariGetir(tamTabloAdi) {
  if (sutunOnbellek.has(tamTabloAdi)) return sutunOnbellek.get(tamTabloAdi);
  const bekleyen = (async () => {
    const r = await sorgu(
      `SELECT c.name AS ad
       FROM sys.columns c
       WHERE c.object_id = OBJECT_ID(@tablo)
         AND c.is_identity = 0
         AND c.is_computed = 0`,
      { tablo: tamTabloAdi }
    );
    if (!r.length) {
      throw new Error(`Tablo bulunamadı ya da okunamadı: ${tamTabloAdi}`);
    }
    const kume = new Set(r.map((s) => String(s.ad).toUpperCase()));
    sutunOnbellek.set(tamTabloAdi, kume);
    return kume;
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
    if (!mevcut.has(ad.toUpperCase())) continue;
    const p = 'p' + sira++;
    sutunlar.push(`[${ad}]`);
    degerler.push('@' + p);
    parametreler[p] = alanlar[ad];
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
// Vega kendi serilerinde A / S / Z öneklerini kullanıyor. Bu program ayrı bir
// önek (varsayılan "H") kullanır; böylece ürettiğimiz numara Vega'nın kendi
// sayacıyla asla çakışmaz.
//
// Numara işlemin İÇİNDE ve aralık kilitlenerek alınır: program ağdaki birkaç
// bilgisayara kurulacak, ikisi aynı anda kaydederse ikisi de aynı numarayı
// okuyup aynı numarayı yazardı.
// SAYAÇ TABLO BAŞINA DEĞİL, PROGRAM GENELİNDE TEK. Önce her tablonun kendi
// MAX'ı alınıyordu; fatura ile kasa dekontu ayrı tablolara yazıldığı için ikisi
// de H0000001 oluyordu. Aynı müşterinin iki farklı belgesi aynı numarayı
// taşıdığında cari ekstresi hangi satırın hangi belgeden geldiğini ayırt
// edemiyor — kasa satırının "KASA TUTARI" açıklaması fatura satırına da
// yapışıyordu. Bu yüzden numara, yazdığımız bütün başlık tablolarının en
// büyüğünden türetiliyor.
const BELGE_NO_TABLOLARI = ['TBLSATFATBASLIK', 'TBLCARCIKBASLIK', 'TBLCARGIRBASLIK'];

async function siradakiBelgeNo(t, v, firma, donem, onek) {
  const basla = onek.length + 1;
  let enBuyuk = 0;

  for (const ad of BELGE_NO_TABLOLARI) {
    if (!(await tabloVarMi(firma, donem, ad))) continue;
    const r = await t.sorgu(
      `SELECT MAX(CAST(SUBSTRING(BELGENO, ${basla}, 20) AS INT)) AS sonNo
       FROM ${tablo(v, firma, donem, ad)} WITH (UPDLOCK, HOLDLOCK)
       WHERE BELGENO LIKE @desen
         AND ISNUMERIC(SUBSTRING(BELGENO, ${basla}, 20)) = 1`,
      { desen: onek + '%' }
    );
    const no = r[0] && r[0].sonNo ? Number(r[0].sonNo) : 0;
    if (no > enBuyuk) enBuyuk = no;
  }

  return onek + String(enBuyuk + 1).padStart(7, '0');
}

function belgeOneki() {
  const ham = String(ayarOku().belgeOneki || 'H').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(ham)) {
    throw new Error(
      `Geçersiz belge öneki: "${ham}". 1-3 harf olmalı (örnek: H). ` +
      "Vega'nın kendi serileriyle çakışmaması için A, S ve Z seçilmemeli."
    );
  }
  return ham;
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
// İsimler sezgiye ters, karıştırmak kolay.
async function cariHareketEkle(t, ayrinti) {
  const { v, firma, donem, cariInd, izahat, borc, alacak, belgeNo, tarih, aciklama } = ayrinti;
  const tam = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');

  const ind = await ekle(
    t,
    tam,
    {
      FIRMANO: Number(cariInd),
      IZAHAT: String(izahat),
      TARIH: tarih,
      BORC: Number(borc) || 0,
      ALACAK: Number(alacak) || 0,
      EVRAKNO: belgeNo,
      ACIKLAMA: aciklama || null,
      PARABIRIMI: 'TL',
      KUR: 1,
      SIRALAMATARIHI: tarih
    },
    {
      zorunlu: ['FIRMANO', 'IZAHAT', 'BORC', 'ALACAK'],
      ozel: { SIRALAMATARIHIEX: 'CONVERT(FLOAT, GETDATE())' }
    }
  );

  return { tablo: 'TBLCARIHAREKETLERI', ind, donemli: true };
}

// ================================================================
//  Cari çıkış / cari giriş belgesi (dekont)
// ================================================================
//
// Kasa depozitosu ve "Cari Çıkış" tuşu bu belgeyi kullanır. Stok hareketi
// oluşmaz — yalnızca müşterinin cari defteri etkilenir. Videodaki "KASA
// TUTARI" satırı da bu yolla, ürün satırından AYRI bir satır olarak düşer.
//
// Açıklama metni ("KASA TUTARI", "KASA IADE") başlık ve hareket satırındaki
// ACIKLAMA alanına yazılıyor: cari hareket tablosunda açıklama alanı YOK
// (canlı şemada doğrulandı). Ekstre ekranı metni başlıktan okuyor.
//
// ÖDEME ARACI ALANLARI BİLEREK BOŞ BIRAKILIYOR. Bu tabloda IZAHAT belge tipi
// değil, ödeme aracı kodudur: 1 = nakit (Vega bunu TBLKASA'ya postalar),
// 2 = çek, 3 = senet; PORTNO da buna eşlik eder. Yazdığımız satır bir tahsilat
// değil, cari defter düzeltmesi — nakit işaretlersek kasa raporunda karşılığı
// olmayan bir para görünür ve kasa bakiyesi gerçeği tutmaz. Bu yüzden IZAHAT,
// PORTNO, BANKANO alanlarına dokunulmuyor.
async function cariDekontuYaz(t, ayrinti) {
  const { v, firma, donem, cariInd, tutar, aciklama, tarih, userNo, giris } = ayrinti;

  const baslikAdi = giris ? 'TBLCARGIRBASLIK' : 'TBLCARCIKBASLIK';
  const hareketAdi = giris ? 'TBLCARGIRHAREKET' : 'TBLCARCIKHAREKET';
  const belgeTipi = giris ? TIP_CARI_GIRIS : TIP_CARI_CIKIS;

  const baslikTam = tablo(v, firma, donem, baslikAdi);
  const hareketTam = tablo(v, firma, donem, hareketAdi);
  const belgeNo = await siradakiBelgeNo(t, v, firma, donem, belgeOneki());

  const baslikInd = await ekle(
    t,
    baslikTam,
    {
      BELGENO: belgeNo,
      TARIH: tarih,
      FIRMANO: Number(cariInd),
      BELGETIPI: belgeTipi,
      TUTAR: Number(tutar),
      ACIKLAMA: aciklama || null,
      GIRIS: giris ? 1 : 0,
      IPTAL: 0,
      IADE: 0,
      PARABIRIMI: 'TL',
      KUR: 1,
      USERNO: Number(userNo || 0)
    },
    {
      zorunlu: ['BELGENO', 'FIRMANO', 'BELGETIPI', 'TUTAR'],
      ozel: { CREDATE: 'GETDATE()' }
    }
  );

  const satirInd = await ekle(
    t,
    hareketTam,
    {
      EVRAKNO: baslikInd,
      BELGENO: belgeNo,
      FIRMANO: Number(cariInd),
      TUTAR: Number(tutar),
      ACIKLAMA: aciklama || null,
      PARABIRIMI: 'TL',
      KUR: 1
    },
    { zorunlu: ['EVRAKNO', 'TUTAR'] }
  );

  const cari = await cariHareketEkle(t, {
    v,
    firma,
    donem,
    cariInd,
    izahat: belgeTipi,
    borc: giris ? 0 : Number(tutar),
    alacak: giris ? Number(tutar) : 0,
    belgeNo,
    tarih,
    aciklama
  });

  return {
    belgeNo,
    belgeTipi,
    kayitlar: [
      { tablo: baslikAdi, ind: baslikInd, donemli: true },
      { tablo: hareketAdi, ind: satirInd, donemli: true },
      cari
    ]
  };
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
//
// TBLDEPOENVANTER.ENVANTER fark tutar, bakiye değil: satışta -miktar yazılır,
// güncel stok bu farkların toplamıdır.
async function satisFaturasiYaz(t, ayrinti) {
  const { v, firma, donem, cariInd, cariAd, satirlar, tarih, depo, userNo, aciklama } = ayrinti;

  const baslikTam = tablo(v, firma, donem, 'TBLSATFATBASLIK');
  const hareketTam = tablo(v, firma, donem, 'TBLSATFATHAREKET');
  const stokHareketTam = tablo(v, firma, donem, 'TBLSTOKHAREKETLERI');
  const envanterTam = tablo(v, firma, donem, 'TBLDEPOENVANTER');
  const belgeNo = await siradakiBelgeNo(t, v, firma, donem, belgeOneki());

  const araToplam = satirlar.reduce((s, x) => s + Number(x.tutar || 0), 0);
  const kdvToplam = satirlar.reduce((s, x) => s + Number(x.kdvTutari || 0), 0);
  const genelToplam = araToplam + kdvToplam;

  const baslikInd = await ekle(
    t,
    baslikTam,
    {
      BELGENO: belgeNo,
      TARIH: tarih,
      FIRMANO: Number(cariInd),
      FIRMAADI: cariAd || null,
      BELGETIPI: TIP_SATIS_FATURASI,
      EKBELGETIPI: 0,
      DEPO: Number(depo),
      HAREKETDEPOSU: Number(depo),
      TUTAR: genelToplam,
      ARATOPLAM: araToplam,
      KDV: kdvToplam,
      STOKHAREKETEYAZ: 1,
      CARIHAREKETEYAZ: 1,
      ENVANTERUPDATE: 1,
      SUCCESS: 1,
      IPTAL: 0,
      IADE: 0,
      CONVERTED: 0,
      GIRIS: 0,
      PARABIRIMI: 'TL',
      KUR: 1,
      USERNO: Number(userNo || 0),
      ALTNOT: aciklama || null
    },
    {
      zorunlu: ['BELGENO', 'FIRMANO', 'BELGETIPI'],
      ozel: { CREDATE: 'GETDATE()', LADATE: 'GETDATE()' }
    }
  );

  const kayitlar = [{ tablo: 'TBLSATFATBASLIK', ind: baslikInd, donemli: true }];
  let sira = 0;

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
        SATIRNO: sira++,
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
        KDVTUTARI: Number(s.kdvTutari || 0),
        GERCEKTOPLAM: tutar,
        DEPO: Number(depo),
        ENVANTER: miktar,
        PARABIRIMI: 'TL',
        KUR: 1,
        ACIKLAMA: s.aciklama || null
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
    aciklama
  });
  kayitlar.push(cari);

  return { belgeNo, belgeTipi: TIP_SATIS_FATURASI, toplam: genelToplam, kayitlar };
}

// ================================================================
//  Kendi veritabanımızdaki belgeyi Vega'ya gönder
// ================================================================
//
// Ürün kısmı kullanıcının bastığı tuşa göre satış faturası ya da cari çıkış
// olarak yazılır. Kasa depozitosu HER İKİ durumda da ayrı bir cari çıkış
// dekontu olur — videodaki ekranda da ürün satırının altında ayrı bir "KASA
// TUTARI" satırı olarak görünüyor.
async function belgeyiVegayaYaz(secenek) {
  kilitKontrol();
  const belgeId = Number(secenek.belgeId);
  if (!belgeId) throw new Error('Belge numarası eksik.');

  const { belge, satirlar } = await kayit.belgeGetir(belgeId);
  if (belge.VegayaYazildi) {
    throw new Error(
      `Bu belge Vega'ya zaten yazılmış (belge no: ${belge.VegaBelgeNo || '—'}).`
    );
  }

  const { firma, donem } = await dogrula(belge.Firma, belge.Donem);
  const v = vt();
  const a = ayarOku();
  const depo = Number(secenek.depo != null ? secenek.depo : a.varsayilanDepo) || 0;
  const tarih = new Date(belge.Tarih);
  const userNo = Number(secenek.userNo || 0);
  const cariInd = Number(belge.CariInd);

  const urunSatirlari = satirlar.filter((s) => Number(s.Tutar) !== 0);
  const kasaTutari = Number(belge.KasaTutari) || 0;

  if (belge.BelgeTuru === 'satisFaturasi') {
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
  let maliyetHaritasi = new Map();
  if (belge.BelgeTuru === 'satisFaturasi' && urunSatirlari.length) {
    const noLar = urunSatirlari.map((s) => Number(s.StokNo));
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
  const aciklama = ('Hizli Belge Doldurucu' + (belge.FisNo ? ' - fis ' + belge.FisNo : ''))
    .substring(0, 100);

  const sonuc = await islem(async (t) => {
    const yazilan = [];

    if (belge.BelgeTuru === 'satisFaturasi') {
      const fatSatirlari = urunSatirlari.map((s) => {
        const k = maliyetHaritasi.get(Number(s.StokNo)) || {};
        const tutar = Number(s.Tutar) || 0;
        return {
          stokNo: Number(s.StokNo),
          stokAdi: s.StokAdi || k.ad || '',
          stokKodu: s.StokKodu || k.kod || null,
          stokTipi: Number(k.stokTipi || 0),
          miktar: Number(s.DaraliMiktar) || 0,
          fiyat: Number(s.Fiyat) || 0,
          tutar,
          kdvOrani,
          kdvTutari: kdvOrani ? Math.round(tutar * kdvOrani) / 100 : 0,
          maliyet: Number(k.maliyet || 0),
          birim: s.Birim || k.birim || '',
          birimEx: s.BirimEx != null ? Number(s.BirimEx) : Number(k.birimEx || 0),
          carpan: Number(k.carpan || 1)
        };
      });
      const f = await satisFaturasiYaz(t, {
        v, firma, donem, cariInd, cariAd: belge.CariAd,
        satirlar: fatSatirlari, tarih, depo, userNo, aciklama
      });
      yazilan.push({ ad: 'Ürün satışı', tur: 'satisFaturasi', ...f });
    } else {
      const urunTutari = Number(belge.UrunTutari) || 0;
      if (urunTutari !== 0) {
        const d = await cariDekontuYaz(t, {
          v, firma, donem, cariInd, tutar: urunTutari, tarih, userNo,
          giris: false,
          aciklama
        });
        yazilan.push({ ad: 'Ürün satışı', tur: 'cariCikis', ...d });
      }
    }

    // Kasa depozitosu — ürün belgesinden ayrı, kendi dekontu.
    if (kasaTutari !== 0) {
      const d = await cariDekontuYaz(t, {
        v, firma, donem, cariInd, tutar: kasaTutari, tarih, userNo,
        giris: false,
        aciklama: 'KASA TUTARI'
      });
      yazilan.push({ ad: 'Kasa tutarı', tur: 'kasaDepozito', ...d });
    }

    return yazilan;
  });

  const belgeNolar = sonuc.map((s) => s.belgeNo).join(' / ');
  const db = kayit.p();

  await calistir(
    `UPDATE [${db}].dbo.Belge
     SET VegayaYazildi = 1, VegaBelgeNo = @belgeNo, VegaKayit = @kayit
     WHERE Id = @id`,
    { id: belgeId, belgeNo: belgeNolar, kayit: JSON.stringify({ firma, donem, yazilan: sonuc }) }
  );
  await calistir(
    `UPDATE [${db}].dbo.KasaHareket SET VegayaYazildi = 1, VegaBelgeNo = @belgeNo
     WHERE BelgeId = @id`,
    { id: belgeId, belgeNo: belgeNolar }
  );

  await kayit.kayitGunlugu(
    'Vega yazma',
    `Belge Vega'ya yazıldı (${belge.BelgeTuru})`,
    { belgeId, firma, donem, cariInd, belgeNolar, yazilan: sonuc },
    secenek.kullanici
  );

  return { tamam: true, belgeNo: belgeNolar, yazilan: sonuc };
}

// ================================================================
//  Kasa iadesini Vega'ya gönder
// ================================================================
//
// Depozito geri ödemesi cari giriş dekontu olarak yazılır: ALACAK satırı
// müşterinin bakiyesini düşürür.
async function kasaIadesiniVegayaYaz(secenek) {
  kilitKontrol();
  const id = Number(secenek.kasaHareketId);
  if (!id) throw new Error('Kasa hareketi numarası eksik.');

  const h = await kayit.kasaHareketGetir(id);
  if (h.VegayaYazildi) {
    throw new Error(`Bu iade Vega'ya zaten yazılmış (belge no: ${h.VegaBelgeNo || '—'}).`);
  }
  if (h.Yon !== 'iade') {
    throw new Error('Yalnızca kasa iadesi bu yolla Vega\'ya yazılır.');
  }

  const tutar = Math.abs(Number(h.Tutar) || 0);
  if (tutar === 0) {
    throw new Error(
      'İade tutarı sıfır. Kasa tipinin depozito bedeli Ayarlar ekranından girilmeli.'
    );
  }

  const { firma, donem } = await dogrula(h.Firma, h.Donem);
  const v = vt();

  const sonuc = await islem(async (t) =>
    cariDekontuYaz(t, {
      v,
      firma,
      donem,
      cariInd: Number(h.CariInd),
      tutar,
      tarih: new Date(h.Tarih),
      userNo: Number(secenek.userNo || 0),
      giris: true,
      aciklama: `KASA IADE${h.KasaTipiKod ? ' - ' + h.KasaTipiKod : ''}`
    })
  );

  await calistir(
    `UPDATE [${kayit.p()}].dbo.KasaHareket
     SET VegayaYazildi = 1, VegaBelgeNo = @belgeNo, VegaKayit = @kayit
     WHERE Id = @id`,
    {
      id,
      belgeNo: sonuc.belgeNo,
      kayit: JSON.stringify({ firma, donem, yazilan: [sonuc] })
    }
  );

  await kayit.kayitGunlugu(
    'Vega yazma',
    "Kasa iadesi Vega'ya yazıldı",
    { kasaHareketId: id, firma, donem, cariInd: h.CariInd, tutar, belgeNo: sonuc.belgeNo },
    secenek.kullanici
  );

  return { tamam: true, belgeNo: sonuc.belgeNo, yazilan: [sonuc] };
}

// ================================================================
//  Geri alma
// ================================================================
//
// Yazarken hangi tabloya hangi IND'i koyduğumuzu kaydettiğimiz için geri alma
// tam olarak o satırları siler. Ters sırada silinir: önce bağlı satırlar, sonra
// başlık.
async function vegaKaydiniGeriAl(kayitlar, firma, donem) {
  const v = vt();
  return islem(async (t) => {
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
  });
}

async function belgeVegaGeriAl(secenek) {
  kilitKontrol();
  const belgeId = Number(secenek.belgeId);
  const { belge } = await kayit.belgeGetir(belgeId);
  if (!belge.VegayaYazildi || !belge.VegaKayit) {
    throw new Error("Bu belge Vega'ya yazılmamış; geri alınacak kayıt yok.");
  }

  const saklanan = JSON.parse(belge.VegaKayit);
  const silinen = await vegaKaydiniGeriAl(saklanan.yazilan, saklanan.firma, saklanan.donem);

  const db = kayit.p();
  await calistir(
    `UPDATE [${db}].dbo.Belge SET VegayaYazildi = 0, VegaBelgeNo = NULL, VegaKayit = NULL
     WHERE Id = @id`,
    { id: belgeId }
  );
  await calistir(
    `UPDATE [${db}].dbo.KasaHareket SET VegayaYazildi = 0, VegaBelgeNo = NULL
     WHERE BelgeId = @id`,
    { id: belgeId }
  );

  await kayit.kayitGunlugu(
    'Vega yazma',
    "Vega'ya yazılan belge geri alındı",
    { belgeId, silinenSatir: silinen, belgeNo: belge.VegaBelgeNo },
    secenek.kullanici
  );

  return { tamam: true, silinenSatir: silinen };
}

async function kasaIadeVegaGeriAl(secenek) {
  kilitKontrol();
  const id = Number(secenek.kasaHareketId);
  const h = await kayit.kasaHareketGetir(id);
  if (!h.VegayaYazildi || !h.VegaKayit) {
    throw new Error("Bu iade Vega'ya yazılmamış; geri alınacak kayıt yok.");
  }

  const saklanan = JSON.parse(h.VegaKayit);
  const silinen = await vegaKaydiniGeriAl(saklanan.yazilan, saklanan.firma, saklanan.donem);

  await calistir(
    `UPDATE [${kayit.p()}].dbo.KasaHareket
     SET VegayaYazildi = 0, VegaBelgeNo = NULL, VegaKayit = NULL WHERE Id = @id`,
    { id }
  );

  await kayit.kayitGunlugu(
    'Vega yazma',
    "Vega'ya yazılan kasa iadesi geri alındı",
    { kasaHareketId: id, silinenSatir: silinen },
    secenek.kullanici
  );

  return { tamam: true, silinenSatir: silinen };
}

module.exports = {
  yazmaAcikMi,
  kilitKontrol,
  belgeyiVegayaYaz,
  kasaIadesiniVegayaYaz,
  belgeVegaGeriAl,
  kasaIadeVegaGeriAl,
  belgeOneki,
  TIP_SATIS_FATURASI,
  TIP_CARI_CIKIS,
  TIP_CARI_GIRIS
};
