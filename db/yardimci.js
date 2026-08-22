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

  await calistir(`
    IF OBJECT_ID('[${db}].dbo.BD_KasaTipi', 'U') IS NULL
    CREATE TABLE [${db}].dbo.BD_KasaTipi (
      StokNo   INT PRIMARY KEY,        -- Vega TBLSTOKLAR.IND (kasa/kap karti)
      Dara     DECIMAL(18,3) NOT NULL DEFAULT 0
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
      StokNo     INT           NOT NULL,     -- Vega TBLSTOKLAR.IND (kasa karti)
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

// --- Dara ağırlığı (kasa/kap boşken kaç kg) ---------------------------------

async function kasaDaralariGetir() {
  await hazirla();
  const satirlar = await sorgu(`SELECT StokNo, Dara FROM [${vt()}].dbo.BD_KasaTipi`);
  const harita = {};
  for (const s of satirlar) harita[Number(s.StokNo)] = Number(s.Dara) || 0;
  return harita;
}

async function kasaDarasiKaydet(stokNo, dara) {
  await hazirla();
  const db = vt();
  const no = Number(stokNo);
  if (!no) throw new Error('Kasa kartı numarası eksik.');
  const d = Number(dara) || 0;

  await calistir(
    `
    UPDATE [${db}].dbo.BD_KasaTipi SET Dara = @dara WHERE StokNo = @stokNo;
    IF @@ROWCOUNT = 0
      INSERT INTO [${db}].dbo.BD_KasaTipi (StokNo, Dara) VALUES (@stokNo, @dara);
    `,
    { stokNo: no, dara: d }
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
  kasaDaralariGetir,
  kasaDarasiKaydet,
  islemYaz,
  islemGetir,
  islemGeriAlindiIsaretle,
  sonIslemleriGetir,
  kasaHareketiYaz,
  kasaBakiyesi,
  acikKasaAdedi,
  kasaHareketleriniSil
};
