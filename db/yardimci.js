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

const { sorgu, calistir } = require('./sql');
const { ayarOku } = require('./ayar');
const vega = require('./vega');
const os = require('os');

function vt() {
  return ayarOku().vegaVeritabani;
}

let hazirlandiVt = null;

// Şemayı VEGADB içinde kurar. Var olanı bozmaz; yalnızca eksik olanı ekler.
// Bunun çalışması için SQL kullanıcısının VEGADB üzerinde CREATE TABLE
// yetkisi (db_owner ya da db_ddladmin+db_datawriter) olması gerekir —
// kurulum/sql-kullanici-olustur.sql bunu artık baştan veriyor.
async function hazirla(zorla) {
  const db = vt();
  if (hazirlandiVt === db && !zorla) return { tamam: true, zatenHazir: true };

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
  `);

  hazirlandiVt = db;
  return { tamam: true };
}

function kimlik(kullanici) {
  return {
    kullanici: kullanici || os.userInfo().username || '',
    bilgisayar: os.hostname() || ''
  };
}

// --- Kasa tipleri ------------------------------------------------------------
//
// İki kaynaktan besleniyor:
//   1. Elle eklenenler (eski Access programının PK/SBÜYÜK/SMUZ/UP gibi kendi
//      kodları — Vega'da hiç karşılığı yok).
//   2. Vega'da KOD1 = 'KASA' işaretli stok kartları (gerçek veriyle
//      doğrulandı) — her okumada BD_KasaTipi'de yoksa otomatik eklenir.
// Tek liste BD_KasaTipi'de birleşiyor: BD_KasaHareket hep aynı Id'ye
// referans verir, kaynağı Vega mı elle mi olduğu fark etmez. Senkronizasyon
// yalnızca EKLER — var olan bir satırın Ad/Depozito/Dara'sını değiştirmez,
// kullanıcı elle düzelttiyse ezilmesin diye.
//
// Silme YUMUŞAK (Aktif=0) — geçmiş BD_KasaHareket satırları bu Id'ye
// referans veriyor, silinirse geçmiş hareketlerin adı/kodu kaybolur.

async function vegaKasaKartlariniSenkronizeEt(firma, donem) {
  if (!firma) return;
  let vegaKartlari = [];
  try {
    vegaKartlari = await vega.kasaKartlariniGetir({ firma, donem });
  } catch (e) {
    return; // KOD1 sütunu yok ya da firma geçersiz — sessizce atla.
  }
  if (!vegaKartlari.length) return;

  const db = vt();
  const mevcut = await sorgu(`SELECT Kod FROM [${db}].dbo.BD_KasaTipi`);
  const mevcutKodlar = new Set(mevcut.map((s) => String(s.Kod || '').trim().toUpperCase()));

  for (const k of vegaKartlari) {
    const kod = k.kod || ('KASA-' + k.id);
    if (mevcutKodlar.has(kod.toUpperCase())) continue;
    try {
      await calistir(
        `IF NOT EXISTS (SELECT 1 FROM [${db}].dbo.BD_KasaTipi WHERE Kod = @kod)
           INSERT INTO [${db}].dbo.BD_KasaTipi (Kod, Ad, Dara, Depozito)
           VALUES (@kod, @ad, 0, @depozito)`,
        { kod, ad: k.ad || kod, depozito: k.depozito || 0 }
      );
      mevcutKodlar.add(kod.toUpperCase());
    } catch (e) {
      // Yarış durumunda UNIQUE hatası olabilir — sorun değil, satır zaten var.
    }
  }
}

async function kasaTipleriGetir(secenek) {
  await hazirla();
  const ayrinti = typeof secenek === 'object' && secenek ? secenek : { sadeceAktif: secenek };
  await vegaKasaKartlariniSenkronizeEt(ayrinti.firma, ayrinti.donem);

  const filtre = ayrinti.sadeceAktif ? 'WHERE Aktif = 1' : '';
  const satirlar = await sorgu(
    `SELECT Id, Kod, Ad, Dara, Depozito, Aktif FROM [${vt()}].dbo.BD_KasaTipi ${filtre} ORDER BY Kod`
  );
  return satirlar.map((s) => ({
    id: Number(s.Id),
    kod: String(s.Kod || '').trim(),
    ad: String(s.Ad || '').trim(),
    dara: Number(s.Dara) || 0,
    depozito: Number(s.Depozito) || 0,
    aktif: !!s.Aktif
  }));
}

async function kasaTipiKaydet(ayrinti) {
  await hazirla();
  const db = vt();
  const kod = String((ayrinti && ayrinti.kod) || '').trim();
  if (!kod) throw new Error('Kasa tipi kodu boş olamaz.');
  const ad = (ayrinti && ayrinti.ad) ? String(ayrinti.ad).trim() : null;
  const dara = Number(ayrinti && ayrinti.dara) || 0;
  const depozito = Number(ayrinti && ayrinti.depozito) || 0;
  const id = ayrinti && ayrinti.id ? Number(ayrinti.id) : null;

  try {
    if (id) {
      await calistir(
        `UPDATE [${db}].dbo.BD_KasaTipi
         SET Kod = @kod, Ad = @ad, Dara = @dara, Depozito = @depozito
         WHERE Id = @id`,
        { id, kod, ad, dara, depozito }
      );
      return { tamam: true, id };
    }
    const r = await sorgu(
      `INSERT INTO [${db}].dbo.BD_KasaTipi (Kod, Ad, Dara, Depozito)
       OUTPUT INSERTED.Id AS id
       VALUES (@kod, @ad, @dara, @depozito)`,
      { kod, ad, dara, depozito }
    );
    return { tamam: true, id: Number(r[0].id) };
  } catch (e) {
    if (/unique|UX_BD_KasaTipi_Kod/i.test(e.message || '')) {
      throw new Error(`"${kod}" kodlu bir kasa tipi zaten var.`);
    }
    throw e;
  }
}

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
    konu: kayit.konu || null,
    firma: kayit.firma || null,
    donem: kayit.donem || null,
    cariInd: kayit.cariInd != null ? Number(kayit.cariInd) : null,
    cariAd: kayit.cariAd || null,
    belgeNo: kayit.belgeNo || null,
    tutar: kayit.tutar != null ? Number(kayit.tutar) : null,
    aciklama: kayit.aciklama || null,
    yazilan: kayit.yazilan ? JSON.stringify(kayit.yazilan) : null,
    kullanici: k.kullanici,
    bilgisayar: k.bilgisayar
  };
  const sorguMetni = `
    INSERT INTO [${db}].dbo.BD_Islem
      (Konu, Firma, Donem, CariInd, CariAd, BelgeNo, Tutar, Aciklama, Yazilan, Kullanici, Bilgisayar)
    OUTPUT INSERTED.Id AS id
    VALUES
      (@konu, @firma, @donem, @cariInd, @cariAd, @belgeNo, @tutar, @aciklama, @yazilan, @kullanici, @bilgisayar)
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

async function islemGeriAlindiIsaretle(id) {
  await calistir(
    `UPDATE [${vt()}].dbo.BD_Islem SET GeriAlindi = 1 WHERE Id = @id`,
    { id: Number(id) }
  );
}

async function sonIslemleriGetir(secenek) {
  await hazirla();
  const limit = Math.min(Number((secenek && secenek.limit) || 100), 1000);
  const parametreler = { firma: secenek && secenek.firma };
  let filtre = '';
  if (secenek && secenek.firma) filtre = 'WHERE Firma = @firma';
  return sorgu(`
    SELECT TOP ${limit} Id, Tarih, Konu, Firma, Donem, CariInd, CariAd, BelgeNo,
           Tutar, Aciklama, GeriAlindi, Kullanici, Bilgisayar
    FROM [${vt()}].dbo.BD_Islem
    ${filtre}
    ORDER BY Id DESC
  `, parametreler);
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

// Müşteride bu tipten kaç kasa açık? İade adedi bunu aşamaz.
async function acikKasaAdedi(firma, cariInd, stokNo) {
  await hazirla();
  const r = await sorgu(
    `SELECT ISNULL(SUM(Adet), 0) AS acikAdet
     FROM [${vt()}].dbo.BD_KasaHareket
     WHERE Firma = @firma AND CariInd = @cariInd AND StokNo = @stokNo`,
    { firma, cariInd: Number(cariInd), stokNo: Number(stokNo) }
  );
  return Number(r[0] ? r[0].acikAdet : 0);
}

// İşlem geri alınırken o işleme bağlı kasa hareketlerini de siler.
async function kasaHareketleriniSil(t, islemId) {
  const sorguMetni = `DELETE FROM [${vt()}].dbo.BD_KasaHareket WHERE IslemId = @islemId`;
  const parametreler = { islemId: Number(islemId) };
  if (t) await t.calistir(sorguMetni, parametreler);
  else await calistir(sorguMetni, parametreler);
}

module.exports = {
  hazirla,
  kasaTipleriGetir,
  kasaTipiKaydet,
  kasaTipiSil,
  islemYaz,
  islemGetir,
  islemGeriAlindiIsaretle,
  sonIslemleriGetir,
  kasaHareketiYaz,
  kasaBakiyesi,
  acikKasaAdedi,
  kasaHareketleriniSil
};
