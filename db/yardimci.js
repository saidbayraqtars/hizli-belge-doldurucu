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
// referans verir, kaynağı Vega mı elle mi olduğu fark etmez.
//
// 24.08.2026: Dara VE Depozito artık Vega eşleşmesi olan kodlarda HER
// okumada canlı Vega değerleriyle GÜNCELLENİYOR (TBLBIRIMLEREX.AGIRLIK /
// SATISFIYATI1 — bkz. db/vega.js → kasaKartlariniGetir). Önceden ikisi de
// yalnızca ilk görüldüğünde INSERT ediliyordu (Dara hep 0 ile), sonrasında
// elle düzeltilmesi gerekiyordu — artık gerekmiyor. BD_KasaTipi satırı yine
// de duruyor (Id sabit kalsın, BD_KasaHareket ona referans veriyor), sadece
// Ad/Dara/Depozito'su artık "canlı ayna". Vega'da karşılığı OLMAYAN gerçekten
// elle eklenmiş kodlar (KOD1='KASA' değil) bu güncellemeden etkilenmez,
// kendi elle girilmiş değerleriyle kalır.
//
// Silme YUMUŞAK (Aktif=0) — geçmiş BD_KasaHareket satırları bu Id'ye
// referans veriyor, silinirse geçmiş hareketlerin adı/kodu kaybolur.

async function vegaKasaKartlariniSenkronizeEt(firma, donem) {
  if (!firma) return new Map();
  let vegaKartlari = [];
  try {
    vegaKartlari = await vega.kasaKartlariniGetir({ firma, donem });
  } catch (e) {
    return new Map(); // KOD1 sütunu yok ya da firma geçersiz — sessizce atla.
  }
  if (!vegaKartlari.length) return new Map();

  const db = vt();
  const mevcut = await sorgu(`SELECT Kod FROM [${db}].dbo.BD_KasaTipi`);
  const mevcutKodlar = new Set(mevcut.map((s) => String(s.Kod || '').trim().toUpperCase()));
  const vegaHaritasi = new Map();

  for (const k of vegaKartlari) {
    const kod = k.kod || ('KASA-' + k.id);
    vegaHaritasi.set(kod.toUpperCase(), k);

    if (mevcutKodlar.has(kod.toUpperCase())) continue;
    try {
      await calistir(
        `IF NOT EXISTS (SELECT 1 FROM [${db}].dbo.BD_KasaTipi WHERE Kod = @kod)
           INSERT INTO [${db}].dbo.BD_KasaTipi (Kod, Ad, Dara, Depozito)
           VALUES (@kod, @ad, @dara, @depozito)`,
        { kod, ad: k.ad || kod, dara: k.dara || 0, depozito: k.depozito || 0 }
      );
      mevcutKodlar.add(kod.toUpperCase());
    } catch (e) {
      // Yarış durumunda UNIQUE hatası olabilir — sorun değil, satır zaten var.
    }
  }
  return vegaHaritasi;
}

async function kasaTipleriGetir(secenek) {
  await hazirla();
  const ayrinti = typeof secenek === 'object' && secenek ? secenek : { sadeceAktif: secenek };
  const vegaHaritasi = await vegaKasaKartlariniSenkronizeEt(ayrinti.firma, ayrinti.donem);

  const filtre = ayrinti.sadeceAktif ? 'WHERE Aktif = 1' : '';
  const satirlar = await sorgu(
    `SELECT Id, Kod, Ad, Dara, Depozito, Aktif FROM [${vt()}].dbo.BD_KasaTipi ${filtre} ORDER BY Kod`
  );
  return satirlar.map((s) => {
    const kod = String(s.Kod || '').trim();
    const canli = vegaHaritasi.get(kod.toUpperCase());
    return {
      id: Number(s.Id),
      kod,
      ad: (canli ? canli.ad : '') || String(s.Ad || '').trim(),
      dara: canli ? Number(canli.dara) || 0 : Number(s.Dara) || 0,
      depozito: canli ? Number(canli.depozito) || 0 : Number(s.Depozito) || 0,
      aktif: !!s.Aktif
    };
  });
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
    yazilan: kayit.yazilan ? JSON.stringify(kayit.yazilan) : null,
    kullanici: k.kullanici,
    bilgisayar: k.bilgisayar
  };
  const sorguMetni = `
    INSERT INTO [${db}].dbo.BD_Islem
      (Tarih, Konu, Firma, Donem, CariInd, CariAd, BelgeNo, Tutar, Aciklama, Yazilan, Kullanici, Bilgisayar)
    OUTPUT INSERTED.Id AS id
    VALUES
      (@tarih, @konu, @firma, @donem, @cariInd, @cariAd, @belgeNo, @tutar, @aciklama, @yazilan, @kullanici, @bilgisayar)
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
async function islemDetayGetir(secenek) {
  const id = Number(secenek && secenek.islemId);
  const kayit = await islemGetir(id);
  if (kayit.GeriAlindi) throw new Error('Geri alınmış belge düzenlenemez.');
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
    : String(kayit.Aciklama || '').replace(/^Fiş\s+/i, '').trim();
  let bakiye = 0;
  try {
    bakiye = await vega.cariBakiye({
      firma: kayit.Firma,
      donem: kayit.Donem,
      cariInd: Number(kayit.CariInd)
    });
  } catch (e) { /* Form yine açılır; bakiye yalnız bilgilendirme amaçlı. */ }

  return {
    islemId: id,
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

async function sonIslemleriGetir(secenek) {
  await hazirla();
  const limit = Math.min(Number((secenek && secenek.limit) || 100), 1000);
  const parametreler = { firma: secenek && secenek.firma };
  let filtre = '';
  if (secenek && secenek.firma) filtre = 'WHERE I.Firma = @firma';
  return sorgu(`
    SELECT TOP ${limit} I.Id,
           COALESCE(
             (SELECT MIN(S.Tarih) FROM [${vt()}].dbo.BD_BelgeSatir S
              WHERE S.IslemId = I.Id AND ISNULL(S.GeriAlindi, 0) = 0),
             (SELECT MIN(K.Tarih) FROM [${vt()}].dbo.BD_KasaHareket K
              WHERE K.IslemId = I.Id),
             I.Tarih
           ) AS Tarih,
           I.Konu, I.Firma, I.Donem, I.CariInd, I.CariAd, I.BelgeNo,
           I.Tutar, I.Aciklama, I.GeriAlindi, I.Kullanici, I.Bilgisayar
    FROM [${vt()}].dbo.BD_Islem I
    ${filtre}
    ORDER BY I.Id DESC
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
  kasaTipleriGetir,
  kasaTipiKaydet,
  kasaTipiSil,
  islemYaz,
  islemGetir,
  islemDetayGetir,
  sonIslemleriGetir,
  kasaHareketiYaz,
  kasaBakiyesi,
  acikKasaDurumu,
  islemKayitlariniTamSil,
  belgeSatirYaz
};
