'use strict';

// PROGRAMIN AYRI BİR VERİTABANI YOK. Vega'nın kendi tabloları yeterli olmayan
// üç şey için — dara ağırlığı, kasa depozito defteri, yazma günlüğü — VEGADB'nin
// İÇİNE üç küçük tablo eklenir (BD_ öneki ile, Vega'nın kendi tablolarıyla asla
// karışmasın diye). Ayrı bir CREATE DATABASE yok; hepsi VEGADB.dbo altında.
//
// Neden bu üçü Vega'da yok:
//   - Dara (kasa/kap boşken kaç kg): stok kartında böyle bir alan yok.
//   - Kasa depozito defteri (müşteride kaç kasa açık): TBLCARIHAREKETLERI
//     yalnızca PARA tutar, ADET tutmaz — kaç kasa dışarıda diye ayrı bir
//     sayaç şart.
//   - Yazma günlüğü: hangi Vega satırına ne yazdığımızı bilmezsek geri alma
//     yapılamaz.

const { sorgu, calistir, islem } = require('./sql');
const { ayarOku } = require('./ayar');
const { dogrula, tablo, kart, tabloVarMi } = require('./firma');
const vega = require('./vega');
const kasa = require('./kasa');
const os = require('os');

function vt() {
  return ayarOku().vegaVeritabani;
}

let hazirlandiVt = null;
// Aynı anda gelen hazirla çağrıları tek kurulumu bekler (aşağıya bkz.).
let hazirlaniyor = null;
// BD_Islem.FisNo / KayitTarihi var mı — göç yapılamadıysa sorgular bunlarsız çalışır.
let islemEkKolonlari = false;

// Şemayı VEGADB içinde kurar. Var olanı bozmaz; yalnızca eksik olanı ekler.
// 24.08.2026: dördüncü tablo eklendi — BD_BelgeSatir. Sebebi: haftalık müşteri
// raporu (eski Access programındaki "fiş no'ya göre ürün dökümü") satır
// kırılımı istiyor, ama faturasız akışta (Cari Giriş) Vega'nın kendi
// tablolarında böyle bir kırılım HİÇ YOK — TBLCARGIRHAREKET'te yalnızca
// "ürün toplamı" ve "KASA TUTARI" diye iki kalem duruyor. Fatura kesilen
// belgede kırılım Vega'da (TBLSATFATHAREKET) da var; rapor ikisini birleştirir,
// bu tablo öncelikli kaynak.
//
// Bunun çalışması için SQL kullanıcısının VEGADB üzerinde CREATE TABLE
// yetkisi (db_owner ya da db_ddladmin+db_datawriter) olması gerekir —
// kurulum/sql-kullanici-olustur.sql bunu artık baştan veriyor.
//
// 01.10.2026 saha raporu: v1.9.0'a güncellenen makinede Kasa İadesi'nin kasa
// listesi boş geldi. Güncellemeden sonraki ilk açılışta otomatik bakım
// (kurulum/kasa-kartlarini-onar, gecmis-belgeleri-duzelt) ile arayüz hazirla'yı
// AYNI ANDA çağırıyordu; yeni BD_Islem sütunlarını iki bağlantı birden eklemeye
// çalışınca biri "sütun birden fazla" hatası alıyor, o çağrının sahibi (kasa
// tipi listesi) boş kalıyordu. Artık eşzamanlı çağrılar aynı kurulumu bekler;
// BD_Islem göçü de ayrı ve hata verse bile çekirdeği durdurmaz (aşağıda).
async function hazirla(zorla) {
  const db = vt();
  if (hazirlandiVt === db && !zorla) return { tamam: true, zatenHazir: true };
  if (hazirlaniyor && hazirlaniyor.db === db) return hazirlaniyor.soz;
  const soz = hazirlaAsil(db).finally(() => {
    if (hazirlaniyor && hazirlaniyor.soz === soz) hazirlaniyor = null;
  });
  hazirlaniyor = { db, soz };
  return soz;
}

async function hazirlaAsil(db) {

  // BD_KasaTipi eski şekli Vega stok kartına bağlıydı (StokNo = Vega IND).
  // Gerçekte kasa tipleri (PK, SBÜYÜK, SMUZ, UP...) Vega'da hiç yok — eski
  // Access programının kendi kısa kodlarıydı. Bu yüzden tablo artık tamamen
  // bağımsız: kod/ad/dara/depozito hepsi burada, elle girilir. Eski şekilde
  // kurulmuş bir tablo bulunursa (canlıya hiç çıkmadığı için veri kaybı
  // riski yok) silinip yeni şekliyle yeniden kurulur.
  await calistir(`
    IF OBJECT_ID('[${db}].dbo.BD_KasaTipi', 'U') IS NOT NULL
       AND COL_LENGTH('[${db}].dbo.BD_KasaTipi', 'Kod') IS NULL
      DROP TABLE [${db}].dbo.BD_KasaTipi;

    IF OBJECT_ID('[${db}].dbo.BD_KasaTipi', 'U') IS NULL
    CREATE TABLE [${db}].dbo.BD_KasaTipi (
      Id        INT IDENTITY(1,1) PRIMARY KEY,
      Kod       NVARCHAR(50)  NOT NULL,
      Ad        NVARCHAR(250) NULL,
      Dara      DECIMAL(18,3) NOT NULL DEFAULT 0,
      Depozito  DECIMAL(18,2) NOT NULL DEFAULT 0,
      Aktif     BIT           NOT NULL DEFAULT 1,
      OlusturmaTarihi DATETIME NOT NULL DEFAULT GETDATE()
    );

    IF OBJECT_ID('[${db}].dbo.BD_Islem', 'U') IS NULL
    CREATE TABLE [${db}].dbo.BD_Islem (
      Id            INT IDENTITY(1,1) PRIMARY KEY,
      Tarih         DATETIME      NOT NULL DEFAULT GETDATE(),
      Konu          NVARCHAR(50)  NULL,     -- 'SatisFaturasi' | 'CariCikis' | 'KasaIade' ...
      Firma         NVARCHAR(5)   NULL,
      Donem         NVARCHAR(5)   NULL,
      CariInd       INT           NULL,
      CariAd        NVARCHAR(250) NULL,
      BelgeNo       NVARCHAR(200) NULL,
      Tutar         DECIMAL(18,2) NULL,
      Aciklama      NVARCHAR(250) NULL,
      GeriAlindi    BIT           NOT NULL DEFAULT 0,
      Yazilan       NVARCHAR(MAX) NULL,     -- JSON: [{tablo, ind, donemli}, ...]
      Kullanici     NVARCHAR(100) NULL,
      Bilgisayar    NVARCHAR(100) NULL
    );

    IF OBJECT_ID('[${db}].dbo.BD_BelgeSatir', 'U') IS NULL
    CREATE TABLE [${db}].dbo.BD_BelgeSatir (
      Id           INT IDENTITY(1,1) PRIMARY KEY,
      IslemId      INT           NULL,
      Firma        NVARCHAR(5)   NULL,
      Donem        NVARCHAR(5)   NULL,
      Tarih        DATE          NOT NULL,
      CariInd      INT           NOT NULL,
      CariAd       NVARCHAR(250) NULL,
      BelgeTuru    NVARCHAR(30)  NULL,   -- 'satisFaturasi' | 'cariCikis'
      BelgeNo      NVARCHAR(50)  NULL,
      FisNo        NVARCHAR(50)  NULL,   -- kullanicinin elle yazdigi fis no
      SiraNo       INT           NULL,
      StokNo       INT           NULL,
      StokKodu     NVARCHAR(50)  NULL,
      StokAdi      NVARCHAR(250) NULL,   -- rapordaki "CINSI"
      KasaAdedi    DECIMAL(18,3) NOT NULL DEFAULT 0,
      KasaTipiKod  NVARCHAR(50)  NULL,
      KasaDepozito DECIMAL(18,2) NOT NULL DEFAULT 0,
      KasaTutari   DECIMAL(18,2) NOT NULL DEFAULT 0,
      BrutMiktar   DECIMAL(18,3) NOT NULL DEFAULT 0,
      Dara         DECIMAL(18,3) NOT NULL DEFAULT 0,
      DaraliMiktar DECIMAL(18,3) NOT NULL DEFAULT 0,  -- brut - dara (raporda gosterilmiyor)
      Fiyat        DECIMAL(18,4) NOT NULL DEFAULT 0,
      Tutar        DECIMAL(18,2) NOT NULL DEFAULT 0,
      Aciklama     NVARCHAR(250) NULL,
      GeriAlindi   BIT           NOT NULL DEFAULT 0,
      OlusturmaTarihi DATETIME NOT NULL DEFAULT GETDATE()
    );

    IF OBJECT_ID('[${db}].dbo.BD_KasaHareket', 'U') IS NULL
    CREATE TABLE [${db}].dbo.BD_KasaHareket (
      Id         INT IDENTITY(1,1) PRIMARY KEY,
      Firma      NVARCHAR(5)   NOT NULL,
      Donem      NVARCHAR(5)   NOT NULL,
      Tarih      DATE          NOT NULL,
      CariInd    INT           NOT NULL,
      CariAd     NVARCHAR(250) NULL,
      StokNo     INT           NOT NULL,     -- BD_KasaTipi.Id (Vega'da karsiligi yok)
      StokKodu   NVARCHAR(50)  NULL,
      StokAdi    NVARCHAR(250) NULL,
      Adet       DECIMAL(18,3) NOT NULL,     -- + verildi, - iade
      Depozito   DECIMAL(18,2) NOT NULL DEFAULT 0,
      Tutar      DECIMAL(18,2) NOT NULL DEFAULT 0,
      Yon        NVARCHAR(10)  NOT NULL,     -- 'verilen' | 'iade'
      IslemId    INT           NULL,
      Kullanici  NVARCHAR(100) NULL,
      Bilgisayar NVARCHAR(100) NULL,
      OlusturmaTarihi DATETIME NOT NULL DEFAULT GETDATE()
    );
  `);

  await calistir(`
    IF NOT EXISTS (SELECT 1 FROM [${db}].sys.indexes
                   WHERE name = 'IX_BD_KasaHareket_Cari'
                     AND object_id = OBJECT_ID('[${db}].dbo.BD_KasaHareket'))
      CREATE INDEX IX_BD_KasaHareket_Cari ON [${db}].dbo.BD_KasaHareket (Firma, CariInd);

    IF NOT EXISTS (SELECT 1 FROM [${db}].sys.indexes
                   WHERE name = 'UX_BD_KasaTipi_Kod'
                     AND object_id = OBJECT_ID('[${db}].dbo.BD_KasaTipi'))
      CREATE UNIQUE INDEX UX_BD_KasaTipi_Kod ON [${db}].dbo.BD_KasaTipi (Kod);

    IF NOT EXISTS (SELECT 1 FROM [${db}].sys.indexes
                   WHERE name = 'IX_BD_BelgeSatir_Hafta'
                     AND object_id = OBJECT_ID('[${db}].dbo.BD_BelgeSatir'))
      CREATE INDEX IX_BD_BelgeSatir_Hafta ON [${db}].dbo.BD_BelgeSatir (Firma, Donem, Tarih, CariInd);
  `);

  try {
    await islemGocu(db);
  } catch (e) {
    // Başka bir bilgisayar aynı anda eklediyse sütun zaten vardır; yetki ya da
    // kilit yüzünden eklenemediyse fiş no / işlem zamanı bu oturumda
    // yazılmaz ama belge girişi çalışmaya devam eder.
    console.error('[hazirla] BD_Islem göçü tamamlanamadı:', e.message);
  }
  const k = (await sorgu(
    `SELECT COL_LENGTH('[${db}].dbo.BD_Islem', 'FisNo') AS fis,
            COL_LENGTH('[${db}].dbo.BD_Islem', 'KayitTarihi') AS kayit`
  ))[0] || {};
  islemEkKolonlari = k.fis != null && k.kayit != null;

  hazirlandiVt = db;
  return { tamam: true, islemEkKolonlari };
}

// 30.09.2026 müşteri isteği: ödeme ve kasa iadesine de fiş no girilebilsin;
// geçmiş tarihli girişte belge tarihi ile işlemin yapıldığı an (tarih + saat)
// ayrı ayrı görünsün. BD_Islem.Tarih belge tarihidir; kayıt anı yeni
// KayitTarihi sütununda. Mevcut satırlara GETDATE yazılmasın diye sütun
// NULL eklenir (WITH VALUES yok); bilinen kayıt anı yalnız sütunun eklendiği
// açılışta bir kez geri doldurulur (her açılışta taramasın).
async function islemGocu(db) {
  const once = (await sorgu(
    `SELECT COL_LENGTH('[${db}].dbo.BD_Islem', 'FisNo') AS fis,
            COL_LENGTH('[${db}].dbo.BD_Islem', 'KayitTarihi') AS kayit`
  ))[0] || {};

  if (once.fis == null || once.kayit == null) {
    await calistir(`
      IF COL_LENGTH('[${db}].dbo.BD_Islem', 'FisNo') IS NULL
        ALTER TABLE [${db}].dbo.BD_Islem ADD FisNo NVARCHAR(50) NULL;

      IF COL_LENGTH('[${db}].dbo.BD_Islem', 'KayitTarihi') IS NULL
        ALTER TABLE [${db}].dbo.BD_Islem ADD KayitTarihi DATETIME NULL
          CONSTRAINT DF_BD_Islem_KayitTarihi DEFAULT GETDATE();
    `);
  }

  // Ödeme geçmişi ve ekstre her satır için programın kaydını cariden arar.
  await calistir(`
    IF NOT EXISTS (SELECT 1 FROM [${db}].sys.indexes
                   WHERE name = 'IX_BD_Islem_Cari'
                     AND object_id = OBJECT_ID('[${db}].dbo.BD_Islem'))
      CREATE INDEX IX_BD_Islem_Cari ON [${db}].dbo.BD_Islem (Firma, CariInd);
  `);

  if (once.kayit == null) {
    // Ayrı batch: yeni sütun aynı batch içinde derlenemez.
    await calistir(`
      UPDATE I SET KayitTarihi = X.an
      FROM [${db}].dbo.BD_Islem I
      CROSS APPLY (
        SELECT COALESCE(
          (SELECT MIN(S.OlusturmaTarihi) FROM [${db}].dbo.BD_BelgeSatir S WHERE S.IslemId = I.Id),
          (SELECT MIN(K.OlusturmaTarihi) FROM [${db}].dbo.BD_KasaHareket K WHERE K.IslemId = I.Id)
        ) AS an
      ) X
      WHERE I.KayitTarihi IS NULL AND X.an IS NOT NULL;
    `);
  }
}

function islemEkKolonlariVarMi() {
  return islemEkKolonlari;
}

function kimlik(kullanici) {
  return {
    kullanici: kullanici || os.userInfo().username || '',
    bilgisayar: os.hostname() || ''
  };
}

// --- Kasa tipleri ------------------------------------------------------------
//
// BD_KasaTipi programın listesidir; Id kasa defterinde (BD_KasaHareket.StokNo)
// referans olduğu için satır hiç silinmez (Aktif=0 yumuşak silme).
//
// 15.09.2026: Liste artık seçili firmadaki Vega kartına bağlı. Yalnız STOKKODU
// aynı, KOD1 = 'KASA', silinmemiş ve tek varsayılan birimli kartı olan tipler
// seçim ve ayar ekranına gelir (bkz. db/kasa.js). Önceden firma ayrımı olmadan
// bütün aktif satırlar listeleniyordu; Vega'da kartı olmayan eski tip
// seçilince fatura yazılamıyordu. Programdan eklenen tip artık aynı
// transaction'da Vega kartıyla birlikte açılıyor; daha önce kartsız eklenmiş
// tipler güncellemeden sonra kurulum/kasa-kartlarini-onar.js → otomatikCalistir
// ile Vega'ya işleniyor.
//
// Vega'da KOD1 = 'KASA' işaretli ama BD_KasaTipi'de olmayan kart her okumada
// listeye eklenir. Ad/Dara/Depozito ekranda hep Vega kartından okunur
// (TBLBIRIMLEREX.AGIRLIK / SATISFIYATI1); BD satırı yalnız aynası.

async function vegaKasaKartlariniSenkronizeEt(firma, donem) {
  let vegaKartlari = [];
  try {
    vegaKartlari = await vega.kasaKartlariniGetir({ firma, donem });
  } catch (e) {
    return; // KOD1 sütunu yok ya da firma geçersiz — eşleşme sorgusu ayrıca söyler.
  }
  if (!vegaKartlari.length) return;

  const db = vt();
  const mevcut = await sorgu(`SELECT Kod FROM [${db}].dbo.BD_KasaTipi`);
  const mevcutKodlar = new Set(mevcut.map((s) => kasa.kodAnahtari(s.Kod)));

  for (const k of vegaKartlari) {
    const kod = k.kod || ('KASA-' + k.id);
    if (mevcutKodlar.has(kasa.kodAnahtari(kod))) continue;
    try {
      await calistir(
        `IF NOT EXISTS (SELECT 1 FROM [${db}].dbo.BD_KasaTipi WHERE Kod = @kod)
           INSERT INTO [${db}].dbo.BD_KasaTipi (Kod, Ad, Dara, Depozito)
           VALUES (@kod, @ad, @dara, @depozito)`,
        { kod, ad: k.ad || kod, dara: k.dara || 0, depozito: k.depozito || 0 }
      );
      mevcutKodlar.add(kasa.kodAnahtari(kod));
    } catch (e) {
      // Yarış durumunda UNIQUE hatası olabilir — sorun değil, satır zaten var.
    }
  }
}

async function kasaTipleriGetir(secenek) {
  await hazirla();
  const ayrinti = typeof secenek === 'object' && secenek ? secenek : { sadeceAktif: secenek };
  if (!ayrinti.firma) return [];
  const { firma, donem } = await dogrula(ayrinti.firma, ayrinti.donem);
  await vegaKasaKartlariniSenkronizeEt(firma, donem);

  const eslesmeler = await kasa.kasaTipiEslesmeleri(firma);
  return eslesmeler
    .filter((e) => e.durum === 'hazir' && (!ayrinti.sadeceAktif || e.aktif))
    .map((e) => ({
      id: e.id,
      kod: e.kod,
      ad: e.kart.ad || e.ad,
      dara: e.kart.dara,
      depozito: e.kart.depozito,
      aktif: e.aktif
    }));
}

// Aktif olduğu halde Vega kartı kullanılamadığı için listeden düşen tipler ve
// nedeni — ayar ekranı kullanıcıya bunları ayrıca söyler.
async function kasaTipiSorunlari(secenek) {
  await hazirla();
  if (!secenek || !secenek.firma) return [];
  const { firma } = await dogrula(secenek.firma, secenek.donem);
  const eslesmeler = await kasa.kasaTipiEslesmeleri(firma);
  return eslesmeler
    .filter((e) => e.aktif && e.durum !== 'hazir')
    .map((e) => ({ id: e.id, kod: e.kod, durum: e.durum, neden: e.neden }));
}

// Kasa tipini kaydeder ve seçili firmadaki Vega kartını aynı transaction'da
// hazırlar: kart yoksa açar, varsa ad/dara/depozitoyu karta yazar. Vega'ya
// yazılamayan tip BD_KasaTipi'de de kalmaz.
async function kasaTipiKaydet(ayrinti) {
  await hazirla();
  if (!ayarOku().vegayaYazmaAktif) {
    const hata = new Error(
      "Vega'ya yazma kapalı. Kasa tipi Vega'da stok kartı olarak açıldığı için önce Ayarlar ekranındaki kilidi kaldırın."
    );
    hata.kod = 'YAZMA_KAPALI';
    throw hata;
  }
  const a = ayrinti || {};
  const { firma } = await dogrula(a.firma, a.donem);
  const girdi = kasa.kasaTipiGirdisi(a);
  const db = vt();
  const istenenId = a.id ? Number(a.id) : null;
  if (a.id && (!Number.isSafeInteger(istenenId) || istenenId <= 0)) {
    throw new Error('Kasa tipi kimliği geçersiz.');
  }

  try {
    return await islem(async (t) => {
      let tip;
      if (istenenId) {
        tip = (await t.sorgu(
          `SELECT Id, Kod FROM [${db}].dbo.BD_KasaTipi WITH (UPDLOCK, HOLDLOCK) WHERE Id = @id`,
          { id: istenenId }
        ))[0];
        if (!tip) throw new Error('Kasa tipi bulunamadı.');
        if (kasa.kodAnahtari(tip.Kod) !== kasa.kodAnahtari(girdi.kod)) {
          throw new Error('Kasa tipi kodu değiştirilemez; geçmiş belgeler ve Vega kartı bu koda bağlı.');
        }
      } else {
        // Aynı kod pasif ya da kartsız bekliyorsa yeni satır açmak yerine o
        // satır canlandırılır; kasa defterindeki geçmiş aynı Id'de kalır.
        tip = (await t.sorgu(
          `SELECT Id, Kod FROM [${db}].dbo.BD_KasaTipi WITH (UPDLOCK, HOLDLOCK)
           WHERE UPPER(LTRIM(RTRIM(Kod))) = UPPER(@kod)`,
          { kod: girdi.kod }
        ))[0];
      }

      let id;
      if (tip) {
        id = Number(tip.Id);
        await t.calistir(
          `UPDATE [${db}].dbo.BD_KasaTipi
           SET Ad = @ad, Dara = @dara, Depozito = @depozito, Aktif = 1
           WHERE Id = @id`,
          { id, ad: girdi.ad, dara: girdi.dara, depozito: girdi.depozito }
        );
      } else {
        const r = await t.sorgu(
          `INSERT INTO [${db}].dbo.BD_KasaTipi (Kod, Ad, Dara, Depozito)
           OUTPUT INSERTED.Id AS id
           VALUES (@kod, @ad, @dara, @depozito)`,
          girdi
        );
        id = Number(r[0].id);
      }
      const kod = tip ? String(tip.Kod).trim() : girdi.kod;

      const [e] = await kasa.kasaTipiEslesmeleri(firma, { idler: [id], t, kilitle: true });
      let kartAcildi = false;
      if (e.durum === 'hazir') {
        await kasa.vegaKasaKartiGuncelle(t, { firma, kart: e.kart, ...girdi, kod });
      } else if (e.durum === 'kartYok' && !e.cakisan) {
        await kasa.vegaKasaKartiAc(t, { firma, ...girdi, kod });
        kartAcildi = true;
      } else {
        throw new Error(e.neden);
      }

      const [son] = await kasa.kasaTipiEslesmeleri(firma, { idler: [id], t });
      if (son.durum !== 'hazir') throw new Error(son.neden);
      return { tamam: true, id, stokNo: son.kart.stokNo, kartAcildi };
    });
  } catch (e) {
    if (/unique|UX_BD_KasaTipi_Kod/i.test(e.message || '')) {
      throw new Error(`"${girdi.kod}" kodlu bir kasa tipi zaten var.`);
    }
    throw e;
  }
}

// Vega stok kartı silinmez: hareket görmüş olabilir, silmek Vega'nın işi.
async function kasaTipiSil(id) {
  await hazirla();
  const no = Number(id);
  if (!no) throw new Error('Kasa tipi kimliği eksik.');
  await calistir(
    `UPDATE [${vt()}].dbo.BD_KasaTipi SET Aktif = 0 WHERE Id = @id`,
    { id: no }
  );
  return { tamam: true };
}

// --- Yazma günlüğü + geri alma bilgisi ---------------------------------------
//
// t verilirse (bir işlem/transaction aracı), o transaction içinde yazılır —
// asıl Vega yazmasıyla aynı atomik işlemin parçası olur: ikisi de ya birlikte
// kalır ya da hata durumunda birlikte geri sarılır.
async function islemYaz(t, kayit) {
  const db = vt();
  const k = kimlik(kayit.kullanici);
  const alanlar = {
    // BD_Islem.Tarih Son Belgeler ekranında belge tarihi olarak gösterilir.
    // Varsayılan GETDATE kayıt anını verdiği için geçmiş tarihli bir belge
    // düzenlenince listede bugüne sıçrıyordu; iş tarihini açıkça sakla.
    tarih: new Date(kayit.tarih || Date.now()),
    konu: kayit.konu || null,
    firma: kayit.firma || null,
    donem: kayit.donem || null,
    cariInd: kayit.cariInd != null ? Number(kayit.cariInd) : null,
    cariAd: kayit.cariAd || null,
    belgeNo: kayit.belgeNo || null,
    tutar: kayit.tutar != null ? Number(kayit.tutar) : null,
    aciklama: kayit.aciklama || null,
    fisNo: kayit.fisNo ? String(kayit.fisNo).trim().substring(0, 50) : null,
    yazilan: kayit.yazilan ? JSON.stringify(kayit.yazilan) : null,
    kullanici: k.kullanici,
    bilgisayar: k.bilgisayar
  };
  // KayitTarihi yazılmıyor: sütunun GETDATE varsayılanı işlemin yapıldığı anı
  // sunucu saatiyle verir.
  const fisSutunu = islemEkKolonlari ? ', FisNo' : '';
  const fisDegeri = islemEkKolonlari ? ', @fisNo' : '';
  const sorguMetni = `
    INSERT INTO [${db}].dbo.BD_Islem
      (Tarih, Konu, Firma, Donem, CariInd, CariAd, BelgeNo, Tutar, Aciklama${fisSutunu}, Yazilan, Kullanici, Bilgisayar)
    OUTPUT INSERTED.Id AS id
    VALUES
      (@tarih, @konu, @firma, @donem, @cariInd, @cariAd, @belgeNo, @tutar, @aciklama${fisDegeri}, @yazilan, @kullanici, @bilgisayar)
  `;
  const r = t ? await t.sorgu(sorguMetni, alanlar) : await sorgu(sorguMetni, alanlar);
  return Number(r[0].id);
}

async function islemGetir(id) {
  await hazirla();
  const r = await sorgu(`SELECT * FROM [${vt()}].dbo.BD_Islem WHERE Id = @id`, { id: Number(id) });
  if (!r.length) throw new Error('İşlem bulunamadı.');
  return r[0];
}

// Son Belgeler'deki kalem düğmesi için güvenli, düzenlenebilir belge özeti.
// Vega bağlantı listesi (Yazilan) arayüze açılmaz; yalnız formu yeniden
// doldurmak için gereken müşteri, satır ve tahsilat bilgileri döner.
// Ödemeden program önekini ("NAKİT - ", "HAVALE tahsilat", "Fiş 12 - ")
// ayıklayıp kullanıcının yazdığı notu verir — eski kayıtlarda not ayrıca
// saklanmıyordu.
function odemeNotunuAyikla(aciklama) {
  let m = String(aciklama || '').trim();
  m = m.replace(/^(NAK[İI]T|HAVALE|EFT)\s*(-\s*|tahsilat\s*$|$)/i, '').trim();
  m = m.replace(/^Fi[şs]\s+\S+\s*(-\s*|$)/i, '').trim();
  return /^tahsilat$/i.test(m) ? '' : m;
}

async function cariBakiyesiOku(kayit) {
  try {
    return await vega.cariBakiye({
      firma: kayit.Firma,
      donem: kayit.Donem,
      cariInd: Number(kayit.CariInd)
    });
  } catch (e) {
    return 0; // Form yine açılır; bakiye yalnız bilgilendirme amaçlı.
  }
}

// 30.09.2026 müşteri isteği: "düşülen paraları düzeltemiyoruz, sadece geri
// alabiliyoruz". Ödeme ve kasa iadesi de formda yeniden açılabiliyor; yazma
// tarafı eskiyi silip yenisini tek transaction'da yazar (yazma.js → odemeYaz,
// kasaIadesiYaz).
async function odemeDetayi(id, kayit) {
  let yazilan = [];
  try { yazilan = JSON.parse(kayit.Yazilan || '[]'); } catch (e) { yazilan = []; }
  const ilk = yazilan[0] || {};
  return {
    islemId: id,
    tur: 'odeme',
    firma: kayit.Firma,
    donem: kayit.Donem,
    tarih: kayit.Tarih,
    fisNo: kayit.FisNo || ilk.fisNo || '',
    tutar: Number(kayit.Tutar) || 0,
    aciklama: ilk.not != null ? String(ilk.not) : odemeNotunuAyikla(kayit.Aciklama),
    cari: { cariInd: Number(kayit.CariInd), ad: kayit.CariAd || '', bakiye: await cariBakiyesiOku(kayit) }
  };
}

async function kasaIadeDetayi(id, kayit) {
  const k = (await sorgu(
    `SELECT TOP 1 StokNo, StokKodu, StokAdi, Adet, Tarih
     FROM [${vt()}].dbo.BD_KasaHareket WHERE IslemId = @id ORDER BY Id`,
    { id }
  ))[0];
  if (!k) throw new Error('Bu kasa iadesinin kasa defteri kaydı bulunamadı.');
  // 03.10.2026: elle girilen iade birim fiyatı Yazilan'da saklanır.
  let yazilan = [];
  try { yazilan = JSON.parse(kayit.Yazilan || '[]'); } catch (e) { yazilan = []; }
  const fis = yazilan.find((y) => y && y.tur === 'kasaIade') || {};
  return {
    islemId: id,
    tur: 'kasaIade',
    firma: kayit.Firma,
    donem: kayit.Donem,
    tarih: k.Tarih || kayit.Tarih,
    fisNo: kayit.FisNo || '',
    stokNo: Number(k.StokNo),
    stokKodu: k.StokKodu || '',
    adet: Math.abs(Number(k.Adet) || 0),
    tutar: Number(kayit.Tutar) || 0,
    birimFiyat: fis.birimFiyat != null ? Number(fis.birimFiyat) : null,
    cari: { cariInd: Number(kayit.CariInd), ad: kayit.CariAd || '', bakiye: await cariBakiyesiOku(kayit) }
  };
}

// Alış faturası satırları Vega'da da duruyor ama formu doldurmak için
// yazılan kaydın kendi özeti yeterli (stok no, miktar, fiyat).
async function alisFaturasiDetayi(id, kayit) {
  let yazilan = [];
  try { yazilan = JSON.parse(kayit.Yazilan || '[]'); } catch (e) { yazilan = []; }
  const f = yazilan.find((y) => y && y.tur === 'alisFaturasi') || {};
  return {
    islemId: id,
    tur: 'alisFaturasi',
    firma: kayit.Firma,
    donem: kayit.Donem,
    tarih: kayit.Tarih,
    faturaNo: kayit.FisNo || f.faturaNo || '',
    aciklama: f.not || '',
    kdvOrani: Number(f.kdvOrani) || 0,
    satirlar: (f.satirlar || []).map((s) => ({
      stokNo: Number(s.stokNo), stokKodu: s.stokKodu || '', stokAdi: s.stokAdi || '',
      miktar: Number(s.miktar) || 0, fiyat: Number(s.fiyat) || 0
    })),
    cari: { cariInd: Number(kayit.CariInd), ad: kayit.CariAd || '', bakiye: await cariBakiyesiOku(kayit) }
  };
}

async function islemDetayGetir(secenek) {
  const id = Number(secenek && secenek.islemId);
  const kayit = await islemGetir(id);
  if (kayit.GeriAlindi) throw new Error('Geri alınmış belge düzenlenemez.');
  if (kayit.Konu === 'tahsilat') return odemeDetayi(id, kayit);
  if (kayit.Konu === 'KasaIade') return kasaIadeDetayi(id, kayit);
  if (kayit.Konu === 'alisFaturasi') return alisFaturasiDetayi(id, kayit);
  if (kayit.Konu !== 'satisFaturasi' && kayit.Konu !== 'cariCikis') {
    throw new Error('Bu belge türü düzenlenemez.');
  }

  const satirlar = await sorgu(`
    SELECT S.Id, S.Tarih, S.FisNo, S.SiraNo, S.StokNo, S.StokKodu, S.StokAdi,
           S.KasaAdedi, S.KasaTipiKod, S.KasaDepozito, S.KasaTutari,
           S.BrutMiktar, S.Dara, S.DaraliMiktar, S.Fiyat, S.Tutar, S.Aciklama,
           K.Id AS KasaStokNo, K.Ad AS KasaTipiAdi
    FROM [${vt()}].dbo.BD_BelgeSatir S
    OUTER APPLY (
      SELECT TOP 1 KT.Id, KT.Ad
      FROM [${vt()}].dbo.BD_KasaTipi KT
      WHERE UPPER(ISNULL(KT.Kod, '')) = UPPER(ISNULL(S.KasaTipiKod, ''))
      ORDER BY KT.Aktif DESC, KT.Id DESC
    ) K
    WHERE S.IslemId = @islemId AND ISNULL(S.GeriAlindi, 0) = 0
    ORDER BY ISNULL(S.SiraNo, 2147483647), S.Id
  `, { islemId: id });

  let yazilan = [];
  try { yazilan = JSON.parse(kayit.Yazilan || '[]'); } catch (e) { yazilan = []; }
  const tahsilatKaydi = yazilan.find((y) => y && y.tur === 'tahsilat');
  const fisNo = satirlar[0] && satirlar[0].FisNo
    ? String(satirlar[0].FisNo).trim()
    : (kayit.FisNo || String(kayit.Aciklama || '').replace(/^Fiş\s+/i, '').trim());
  const bakiye = await cariBakiyesiOku(kayit);

  return {
    islemId: id,
    tur: 'belge',
    firma: kayit.Firma,
    donem: kayit.Donem,
    belgeTuru: kayit.Konu,
    tarih: satirlar[0] ? satirlar[0].Tarih : kayit.Tarih,
    fisNo,
    cari: { cariInd: Number(kayit.CariInd), ad: kayit.CariAd || '', bakiye },
    tahsilat: tahsilatKaydi ? Number(tahsilatKaydi.toplam) || 0 : 0,
    tahsilatAciklama: tahsilatKaydi && tahsilatKaydi.aciklama
      ? String(tahsilatKaydi.aciklama)
      : (tahsilatKaydi ? 'Tahsilat' : ''),
    satirlar: satirlar.map((s) => ({
      stokNo: s.StokNo == null ? null : Number(s.StokNo),
      stokKodu: s.StokKodu || null,
      stokAdi: s.StokAdi || null,
      kasaAdedi: Number(s.KasaAdedi) || 0,
      kasaStokNo: s.KasaStokNo == null ? null : Number(s.KasaStokNo),
      kasaTipiKod: s.KasaTipiKod || null,
      kasaTipiAdi: s.KasaTipiAdi || null,
      kasaDepozito: Number(s.KasaDepozito) || 0,
      kasaTutari: Number(s.KasaTutari) || 0,
      brutMiktar: Number(s.BrutMiktar) || 0,
      dara: Number(s.Dara) || 0,
      daraliMiktar: Number(s.DaraliMiktar) || 0,
      fiyat: Number(s.Fiyat) || 0,
      tutar: Number(s.Tutar) || 0,
      aciklama: s.Aciklama || ''
    }))
  };
}

// Son Belgeler listesi. Arama verilmezse en yeni `limit` kayıt gelir.
//
// 17.09.2026 kullanıcı raporu: "00812 fiş numarası aramada çıkmıyor ama
// ekstrede görünüyor". Arama yalnız indirilen son 200 kaydın içinde
// yapılıyordu; daha eski fiş hiç bulunamıyordu. Arama artık sunucuda, bütün
// günlükte yapılıyor (fiş no BD_BelgeSatir'den de taranıyor). Ayrıca günlükte
// hiç kaydı olmayan ama Vega'da duran belge (VegaWin'den kesilmiş fatura, fiş
// no'su fatura notunda) salt okunur satır olarak eklenir — ekstrede görünen
// her belge burada da bulunabilsin.
const ARAMA_HARMANI = 'Latin1_General_CI_AI';

function aramaKosulu(ifade, parcalar, parametreler, onek) {
  return parcalar.map((p, i) => {
    const ad = onek + i;
    parametreler[ad] = '%' + p + '%';
    return `${ifade} COLLATE ${ARAMA_HARMANI} LIKE @${ad} COLLATE ${ARAMA_HARMANI}`;
  });
}

// 03.10.2026 müşteri raporu: "ödemelerden girilenlerin saatleri gözükmüyor".
// KayitTarihi sütunu 30.09.2026'da eklendi; göç, eski kaydın anını yalnız
// BD_BelgeSatir / BD_KasaHareket'ten geri doldurabildi. Ödeme (tahsilat) ve
// tutarsız cari giriş kayıtlarının ikisinde de satırı yok, saatleri boş
// kaldı. Bu kayıtların gerçek anı programın Vega'ya yazdığı cari hareketin
// ISLEMTARIHI'nde duruyor (cariHareketEkle → GETDATE()). Oturum başına bir
// kez, her firma/dönem için o hareketten doldurulur. Yeni kayıtlarda sütunun
// GETDATE varsayılanı zaten anı yazıyor.
let kayitZamaniTamamlandiVt = null;

async function kayitZamanlariniTamamla(db, zorla) {
  if (!islemEkKolonlari || (kayitZamaniTamamlandiVt === db && !zorla)) return;
  kayitZamaniTamamlandiVt = db;
  try {
    const gruplar = await sorgu(`
      SELECT DISTINCT Firma, Donem FROM [${db}].dbo.BD_Islem
      WHERE KayitTarihi IS NULL AND ISNULL(BelgeNo, '') <> ''
        AND Firma IS NOT NULL AND Donem IS NOT NULL`);
    for (const g of gruplar) {
      const firma = String(g.Firma || '').trim();
      const donem = String(g.Donem || '').trim();
      if (!/^[A-Za-z0-9_]+$/.test(firma) || !/^[A-Za-z0-9_]+$/.test(donem)) continue;
      if (!(await tabloVarMi(firma, donem, 'TBLCARIHAREKETLERI'))) continue;
      const hareket = tablo(db, firma, donem, 'TBLCARIHAREKETLERI');
      if (!(await vega.kolonVarMi(hareket, 'ISLEMTARIHI'))) continue;
      // BelgeNo birden çok belgeyi ' / ' ile tutabilir (fatura / tahsilat).
      await calistir(`
        UPDATE I SET KayitTarihi = X.an
        FROM [${db}].dbo.BD_Islem I
        CROSS APPLY (
          SELECT MIN(H.ISLEMTARIHI) AS an
          FROM ${hareket} H
          WHERE H.FIRMANO = I.CariInd AND ISNULL(H.EVRAKNO, '') <> ''
            AND ' / ' + I.BelgeNo + ' / ' LIKE '% / ' + LTRIM(RTRIM(H.EVRAKNO)) + ' / %'
        ) X
        WHERE I.KayitTarihi IS NULL AND I.Firma = @firma AND I.Donem = @donem
          AND ISNULL(I.BelgeNo, '') <> '' AND X.an IS NOT NULL`,
        { firma: g.Firma, donem: g.Donem });
    }
  } catch (e) {
    // Saat yalnız bilgi; dolduramazsak liste yine açılır.
    console.error('[kayitZamani] geri doldurulamadı:', e.message);
  }
}

async function sonIslemleriGetir(secenek) {
  await hazirla();
  const db = vt();
  await kayitZamanlariniTamamla(db);
  const limit = Math.min(Number((secenek && secenek.limit) || 100), 1000);
  const parcalar = String((secenek && secenek.arama) || '')
    .split(/\s+/).map((p) => p.trim()).filter(Boolean).slice(0, 6);
  const parametreler = {};
  const kosullar = [];
  if (secenek && secenek.firma) {
    kosullar.push('I.Firma = @firma');
    parametreler.firma = secenek.firma;
  }

  if (parcalar.length) {
    const metin = `(ISNULL(I.CariAd, '') + ' ' + ISNULL(I.BelgeNo, '') + ' ' +
      ISNULL(I.Aciklama, '') + ' ' + ISNULL(I.Kullanici, '') + ' ' +
      CASE I.Konu WHEN 'satisFaturasi' THEN N'Satış Faturası'
                  WHEN 'cariCikis' THEN N'Cari Giriş'
                  WHEN 'tahsilat' THEN N'Tahsilat Ödeme'
                  WHEN 'KasaIade' THEN N'Kasa İadesi'
                  WHEN 'alisFaturasi' THEN N'Alış Faturası'
                  ELSE ISNULL(I.Konu, '') END + ' ' +
      CONVERT(NVARCHAR(10), I.Tarih, 104) + ' ' + ${islemEkKolonlari ? "ISNULL(I.FisNo, '')" : "''"} + ' ' +
      ISNULL((SELECT TOP 1 X.FisNo FROM [${db}].dbo.BD_BelgeSatir X
              WHERE X.IslemId = I.Id AND ISNULL(X.FisNo, '') <> ''), ''))`;
    kosullar.push(...aramaKosulu(metin, parcalar, parametreler, 'ara'));
  }

  const islemler = await sorgu(`
    SELECT TOP ${limit} I.Id,
           COALESCE(
             (SELECT MIN(S.Tarih) FROM [${db}].dbo.BD_BelgeSatir S
              WHERE S.IslemId = I.Id AND ISNULL(S.GeriAlindi, 0) = 0),
             (SELECT MIN(K.Tarih) FROM [${db}].dbo.BD_KasaHareket K
              WHERE K.IslemId = I.Id),
             I.Tarih
           ) AS Tarih,
           I.Konu, I.Firma, I.Donem, I.CariInd, I.CariAd, I.BelgeNo,
           COALESCE(
             (SELECT TOP 1 S.FisNo FROM [${db}].dbo.BD_BelgeSatir S
              WHERE S.IslemId = I.Id AND ISNULL(S.FisNo, '') <> ''),
             ${islemEkKolonlari ? "NULLIF(I.FisNo, '')" : 'NULL'}
           ) AS FisNo,
           ${islemEkKolonlari ? vega.yerelAniUtcYap('I.KayitTarihi') + ' AS KayitTarihi' : 'NULL AS KayitTarihi'},
           I.Tutar, I.Aciklama, I.GeriAlindi, I.Kullanici, I.Bilgisayar
    FROM [${db}].dbo.BD_Islem I
    ${kosullar.length ? 'WHERE ' + kosullar.join(' AND ') : ''}
    ORDER BY I.Id DESC
  `, parametreler);

  if (!parcalar.length || !(secenek && secenek.firma && secenek.donem)) return islemler;

  let vegadan = [];
  try {
    vegadan = await vegaBelgeleriniAra(secenek.firma, secenek.donem, parcalar, limit);
  } catch (e) { /* Vega araması düşerse günlük sonuçları yine gösterilir */ }
  return islemler.concat(vegadan);
}

// Günlükte olmayan Vega belgeleri — satış faturası ile cari giriş/çıkış.
// Numarası günlükteki herhangi bir BelgeNo içinde geçen belge atlanır.
async function vegaBelgeleriniAra(firmaHam, donemHam, parcalar, limit) {
  const { firma, donem } = await dogrula(firmaHam, donemHam);
  const v = vt();
  const kaynaklar = [
    { ad: 'TBLSATFATBASLIK', not: 'ALTNOT', konu: 'vegaSatisFaturasi' },
    { ad: 'TBLALFATBASLIK', not: 'ALTNOT', konu: 'vegaAlisFaturasi' },
    { ad: 'TBLCARGIRBASLIK', not: 'ACIKLAMA', konu: 'vegaCariGiris' },
    { ad: 'TBLCARCIKBASLIK', not: 'ACIKLAMA', konu: 'vegaCariCikis' }
  ];
  const sonuc = [];
  // Belgenin girildiği an: cari hareketin ISLEMTARIHI (03.10.2026).
  const hareket = tablo(v, firma, donem, 'TBLCARIHAREKETLERI');
  const anVar = (await tabloVarMi(firma, donem, 'TBLCARIHAREKETLERI')) &&
    (await vega.kolonVarMi(hareket, 'ISLEMTARIHI'));
  const anIfadesi = anVar
    ? vega.yerelAniUtcYap(`(SELECT MIN(H.ISLEMTARIHI) FROM ${hareket} H
        WHERE H.FIRMANO = B.FIRMANO AND ISNULL(B.BELGENO, '') <> '' AND H.EVRAKNO = B.BELGENO)`)
    : 'NULL';

  for (const k of kaynaklar) {
    if (!(await tabloVarMi(firma, donem, k.ad))) continue;
    const tam = tablo(v, firma, donem, k.ad);
    const tutarIfadesi = (await vega.kolonVarMi(tam, 'TUTAR')) ? 'ISNULL(B.TUTAR, 0)' : '0';
    const iptalFiltresi = (await vega.kolonVarMi(tam, 'IPTAL')) ? 'ISNULL(B.IPTAL, 0) = 0 AND' : '';
    const parametreler = { firma };
    const cariAd = `COALESCE(NULLIF(LTRIM(RTRIM(C.FIRMAADI)), ''), NULLIF(LTRIM(RTRIM(C.UNVAN)), ''), '')`;
    const metin = `(ISNULL(B.BELGENO, '') + ' ' + ISNULL(CAST(B.${k.not} AS NVARCHAR(500)), '') + ' ' +
      ${cariAd} + ' ' + CONVERT(NVARCHAR(10), B.TARIH, 104))`;
    const kosullar = aramaKosulu(metin, parcalar, parametreler, 'va');
    const r = await sorgu(`
      SELECT TOP ${limit} B.IND AS vegaInd, B.TARIH AS Tarih, B.FIRMANO AS CariInd,
             ${cariAd} AS CariAd, ISNULL(B.BELGENO, '') AS BelgeNo,
             ${tutarIfadesi} AS Tutar,
             ${anIfadesi} AS KayitTarihi,
             CAST(B.${k.not} AS NVARCHAR(250)) AS Aciklama
      FROM ${tam} B
      LEFT JOIN ${kart(v, firma, 'TBLCARI')} C ON C.IND = B.FIRMANO
      WHERE ${iptalFiltresi} ${kosullar.join(' AND ')}
        AND NOT EXISTS (
          SELECT 1 FROM [${v}].dbo.BD_Islem I
          WHERE I.Firma = @firma AND ISNULL(B.BELGENO, '') <> ''
            AND ISNULL(I.BelgeNo, '') LIKE '%' + B.BELGENO + '%')
      ORDER BY B.TARIH DESC, B.IND DESC
    `, parametreler);
    for (const s of r) {
      const not = String(s.Aciklama || '').trim();
      const fis = /fis\s+(\S+)/i.exec(not);
      sonuc.push({
        Id: null,
        kaynak: 'vega',
        Tarih: s.Tarih,
        Konu: k.konu,
        Firma: firma,
        Donem: donem,
        CariInd: Number(s.CariInd),
        CariAd: s.CariAd || '',
        BelgeNo: String(s.BelgeNo || '').trim(),
        FisNo: fis ? fis[1] : null,
        KayitTarihi: s.KayitTarihi || null,
        Tutar: Number(s.Tutar) || 0,
        Aciklama: not,
        GeriAlindi: false,
        Kullanici: '',
        Bilgisayar: ''
      });
    }
  }
  return sonuc;
}

// --- Kasa depozito defteri ---------------------------------------------------
//
// Adet ARTI = müşteriye kasa verildi (borçlandı), EKSİ = kasa geri geldi
// (borcu düştü). Açık bakiye bu sütunun toplamıdır.
async function kasaHareketiYaz(t, ayrinti) {
  const db = vt();
  const alanlar = {
    firma: ayrinti.firma,
    donem: ayrinti.donem,
    tarih: new Date(ayrinti.tarih || Date.now()),
    cariInd: Number(ayrinti.cariInd),
    cariAd: ayrinti.cariAd || null,
    stokNo: Number(ayrinti.stokNo),
    stokKodu: ayrinti.stokKodu || null,
    stokAdi: ayrinti.stokAdi || null,
    adet: Number(ayrinti.adet),
    depozito: Number(ayrinti.depozito) || 0,
    tutar: Number(ayrinti.tutar) || 0,
    yon: ayrinti.yon,
    islemId: ayrinti.islemId != null ? Number(ayrinti.islemId) : null,
    kullanici: ayrinti.kullanici || null,
    bilgisayar: ayrinti.bilgisayar || null
  };
  const sorguMetni = `
    INSERT INTO [${db}].dbo.BD_KasaHareket
      (Firma, Donem, Tarih, CariInd, CariAd, StokNo, StokKodu, StokAdi,
       Adet, Depozito, Tutar, Yon, IslemId, Kullanici, Bilgisayar)
    OUTPUT INSERTED.Id AS id
    VALUES
      (@firma, @donem, @tarih, @cariInd, @cariAd, @stokNo, @stokKodu, @stokAdi,
       @adet, @depozito, @tutar, @yon, @islemId, @kullanici, @bilgisayar)
  `;
  const r = t ? await t.sorgu(sorguMetni, alanlar) : await sorgu(sorguMetni, alanlar);
  return Number(r[0].id);
}

async function kasaBakiyesi(secenek) {
  await hazirla();
  const db = vt();
  const parametreler = { firma: secenek.firma };
  let filtre = 'WHERE Firma = @firma';
  if (secenek.cariInd) {
    filtre += ' AND CariInd = @cariInd';
    parametreler.cariInd = Number(secenek.cariInd);
  }

  const satirlar = await sorgu(
    `
    SELECT CariInd, MAX(CariAd) AS CariAd, StokNo, MAX(StokKodu) AS StokKodu, MAX(StokAdi) AS StokAdi,
           SUM(Adet) AS acikAdet, SUM(Tutar) AS acikTutar
    FROM [${db}].dbo.BD_KasaHareket
    ${filtre}
    GROUP BY CariInd, StokNo
    HAVING SUM(Adet) <> 0
    ORDER BY MAX(CariAd), MAX(StokKodu)
  `,
    parametreler
  );

  return satirlar.map((s) => ({
    cariInd: Number(s.CariInd),
    cariAd: s.CariAd || '',
    stokNo: Number(s.StokNo),
    kasaTipiKod: s.StokKodu || s.StokAdi || '',
    acikAdet: Number(s.acikAdet) || 0,
    acikTutar: Number(s.acikTutar) || 0
  }));
}

// Müşteride bu tipten kaç kasa ve bu kasalara ait kaç TL depozito borcu açık?
// İade hem adedi hem de verildiği günkü gerçek açık tutarı kapatır.
async function acikKasaDurumu(firma, cariInd, stokNo, t) {
  await hazirla();
  const sorgula = t ? t.sorgu.bind(t) : sorgu;
  const kilit = t ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
  const r = await sorgula(
    `SELECT ISNULL(SUM(Adet), 0) AS acikAdet, ISNULL(SUM(Tutar), 0) AS acikTutar
     FROM [${vt()}].dbo.BD_KasaHareket${kilit}
     WHERE Firma = @firma AND CariInd = @cariInd AND StokNo = @stokNo`,
    { firma, cariInd: Number(cariInd), stokNo: Number(stokNo) }
  );
  return {
    acikAdet: Number(r[0] ? r[0].acikAdet : 0) || 0,
    acikTutar: Number(r[0] ? r[0].acikTutar : 0) || 0
  };
}

// --- Belge satır günlüğü (ayrıntılı rapor kaynağı) ---------------------------
//
// Belgeye girilen HER satır buraya bir kez yazılır — belge Vega'da fatura mı
// yoksa cari dekont mu oldu fark etmez. Ekstre ekranındaki fiş bazlı ayrıntılı
// rapordaki CİNSİ / K.ADET / K.TÜRÜ / K.TUTAR / FİYAT / TUTAR / AÇIKLAMA /
// FİŞ NO sütunları bu tablodan gelir. Vega'nın kendi tablolarına ek olarak tutuluyor, onların
// yerine değil: bakiye/borç hep TBLCARIHAREKETLERI'nden okunur.
async function belgeSatirYaz(t, ayrinti) {
  const db = vt();
  const alanlar = {
    islemId: ayrinti.islemId != null ? Number(ayrinti.islemId) : null,
    firma: ayrinti.firma || null,
    donem: ayrinti.donem || null,
    tarih: new Date(ayrinti.tarih || Date.now()),
    cariInd: Number(ayrinti.cariInd),
    cariAd: ayrinti.cariAd || null,
    belgeTuru: ayrinti.belgeTuru || null,
    belgeNo: ayrinti.belgeNo || null,
    fisNo: ayrinti.fisNo || null,
    siraNo: ayrinti.siraNo != null ? Number(ayrinti.siraNo) : null,
    stokNo: ayrinti.stokNo != null ? Number(ayrinti.stokNo) : null,
    stokKodu: ayrinti.stokKodu || null,
    stokAdi: ayrinti.stokAdi || null,
    kasaAdedi: Number(ayrinti.kasaAdedi) || 0,
    kasaTipiKod: ayrinti.kasaTipiKod || null,
    kasaDepozito: Number(ayrinti.kasaDepozito) || 0,
    kasaTutari: Number(ayrinti.kasaTutari) || 0,
    brutMiktar: Number(ayrinti.brutMiktar) || 0,
    dara: Number(ayrinti.dara) || 0,
    daraliMiktar: Number(ayrinti.daraliMiktar) || 0,
    fiyat: Number(ayrinti.fiyat) || 0,
    tutar: Number(ayrinti.tutar) || 0,
    aciklama: ayrinti.aciklama ? String(ayrinti.aciklama).substring(0, 250) : null
  };
  const sorguMetni = `
    INSERT INTO [${db}].dbo.BD_BelgeSatir
      (IslemId, Firma, Donem, Tarih, CariInd, CariAd, BelgeTuru, BelgeNo, FisNo, SiraNo,
       StokNo, StokKodu, StokAdi, KasaAdedi, KasaTipiKod, KasaDepozito, KasaTutari,
       BrutMiktar, Dara, DaraliMiktar, Fiyat, Tutar, Aciklama)
    VALUES
      (@islemId, @firma, @donem, @tarih, @cariInd, @cariAd, @belgeTuru, @belgeNo, @fisNo, @siraNo,
       @stokNo, @stokKodu, @stokAdi, @kasaAdedi, @kasaTipiKod, @kasaDepozito, @kasaTutari,
       @brutMiktar, @dara, @daraliMiktar, @fiyat, @tutar, @aciklama)
  `;
  if (t) await t.calistir(sorguMetni, alanlar);
  else await calistir(sorguMetni, alanlar);
}

// Geri alma ve düzenleme artık yardımcı günlükte de iz bırakmaz. Üç tablo aynı
// SQL transaction'ında temizlenir; sonraki yazım başarısız olursa düzenlemede
// eski kayıtlar otomatik geri gelir.
async function islemKayitlariniTamSil(t, islemId) {
  const parametreler = { islemId: Number(islemId) };
  const sonuc = { kasa: 0, satir: 0, islem: 0 };
  const k = await t.calistir(
    `DELETE FROM [${vt()}].dbo.BD_KasaHareket WHERE IslemId = @islemId`, parametreler);
  sonuc.kasa = Number(k[0]) || 0;
  const s = await t.calistir(
    `DELETE FROM [${vt()}].dbo.BD_BelgeSatir WHERE IslemId = @islemId`, parametreler);
  sonuc.satir = Number(s[0]) || 0;
  const i = await t.calistir(
    `DELETE FROM [${vt()}].dbo.BD_Islem WHERE Id = @islemId`, parametreler);
  sonuc.islem = Number(i[0]) || 0;
  if (sonuc.islem !== 1) throw new Error('İşlem günlüğü tamamen silinemedi.');
  return sonuc;
}

module.exports = {
  hazirla,
  islemEkKolonlariVarMi,
  kasaTipleriGetir,
  kasaTipiSorunlari,
  kasaTipiKaydet,
  kasaTipiSil,
  islemYaz,
  islemGetir,
  islemDetayGetir,
  sonIslemleriGetir,
  kayitZamanlariniTamamla,
  kasaHareketiYaz,
  kasaBakiyesi,
  acikKasaDurumu,
  islemKayitlariniTamSil,
  belgeSatirYaz
};
