'use strict';

// PROGRAMIN KENDİ VERİTABANI (varsayılan: BELGE_DOLDURUCU)
//
// Girilen belgeler, satırları, kasa tipi tanımları ve kasa depozito defteri
// burada durur. VEGADB'ye yazma kapalıyken de program tam çalışır: kayıt buraya
// düşer, Vega'ya yazma sonradan açıldığında aynı kayıt oradan gönderilir.
//
// Neden ayrı bir SQL veritabanı, dosya değil: program ağdaki birkaç
// bilgisayara kurulacak ve kasa depozito bakiyesinin hepsinde aynı olması şart.
//
// SQL Server 2008 uyumu: SEQUENCE, THROW, IIF, CONCAT, OFFSET/FETCH ve
// TRY_CAST kullanılmaz — Windows 7 kurulumlarında eski sunucu çıkabiliyor.

const { sorgu, calistir, islem } = require('./sql');
const { ayarOku } = require('./ayar');

const os = require('os');

// Veritabanı adı sorguya metin olarak gömülüyor (CREATE DATABASE parametre
// kabul etmez), o yüzden harf/rakam/alt çizgi dışına izin verilmiyor.
function p() {
  const ad = String(ayarOku().kendiVeritabani || 'BELGE_DOLDURUCU').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(ad)) {
    throw new Error(
      `Geçersiz veritabanı adı: ${ad}. Yalnızca harf, rakam ve alt çizgi kullanılabilir.`
    );
  }
  return ad;
}

let hazirlandi = false;

// Şemayı kurar. Var olanı bozmaz; yalnızca eksik olanı ekler.
async function hazirla(zorla) {
  if (hazirlandi && !zorla) return { tamam: true, zatenHazir: true };
  const db = p();

  await calistir(`
    IF DB_ID('${db}') IS NULL CREATE DATABASE [${db}];
  `);

  await calistir(`
    -- Kasa/kap türleri ve depozito bedelleri. Bedel Vega'da tanımlı olmadığı
    -- için burada tutuluyor; Ayarlar ekranından değiştirilir.
    IF OBJECT_ID('[${db}].dbo.KasaTipi', 'U') IS NULL
    CREATE TABLE [${db}].dbo.KasaTipi (
      Id            INT IDENTITY(1,1) PRIMARY KEY,
      Kod           NVARCHAR(20)  NOT NULL,
      Ad            NVARCHAR(100) NULL,
      Depozito      DECIMAL(18,2) NOT NULL DEFAULT 0,
      Aktif         BIT           NOT NULL DEFAULT 1,
      OlusturmaTarihi DATETIME    NOT NULL DEFAULT GETDATE()
    );

    IF OBJECT_ID('[${db}].dbo.Belge', 'U') IS NULL
    CREATE TABLE [${db}].dbo.Belge (
      Id            INT IDENTITY(1,1) PRIMARY KEY,
      Firma         NVARCHAR(5)   NOT NULL,
      Donem         NVARCHAR(5)   NOT NULL,
      Tarih         DATE          NOT NULL,
      CariInd       INT           NOT NULL,
      CariKod       NVARCHAR(50)  NULL,
      CariAd        NVARCHAR(250) NULL,
      -- 'satisFaturasi' veya 'cariCikis' — kullanıcı hangi tuşa bastıysa.
      BelgeTuru     NVARCHAR(20)  NOT NULL,
      FisNo         NVARCHAR(50)  NULL,
      UrunTutari    DECIMAL(18,2) NOT NULL DEFAULT 0,
      KasaTutari    DECIMAL(18,2) NOT NULL DEFAULT 0,
      ToplamTutar   DECIMAL(18,2) NOT NULL DEFAULT 0,
      Aciklama      NVARCHAR(250) NULL,
      VegayaYazildi BIT           NOT NULL DEFAULT 0,
      VegaBelgeNo   NVARCHAR(100) NULL,
      VegaKayit     NVARCHAR(MAX) NULL,
      Kullanici     NVARCHAR(100) NULL,
      Bilgisayar    NVARCHAR(100) NULL,
      OlusturmaTarihi DATETIME    NOT NULL DEFAULT GETDATE()
    );

    IF OBJECT_ID('[${db}].dbo.BelgeSatir', 'U') IS NULL
    CREATE TABLE [${db}].dbo.BelgeSatir (
      Id            INT IDENTITY(1,1) PRIMARY KEY,
      BelgeId       INT           NOT NULL,
      Sira          INT           NOT NULL DEFAULT 0,
      StokNo        INT           NOT NULL,
      StokKodu      NVARCHAR(50)  NULL,
      StokAdi       NVARCHAR(250) NULL,
      Birim         NVARCHAR(20)  NULL,
      BirimEx       INT           NULL,
      DaraliMiktar  DECIMAL(18,3) NOT NULL DEFAULT 0,
      KasaAdedi     DECIMAL(18,3) NOT NULL DEFAULT 0,
      KasaTipiId    INT           NULL,
      KasaTipiKod   NVARCHAR(20)  NULL,
      Fiyat         DECIMAL(18,4) NOT NULL DEFAULT 0,
      Tutar         DECIMAL(18,2) NOT NULL DEFAULT 0
    );

    -- Kasa depozito defteri. Adet ARTI = müşteriye kasa verildi (borçlandı),
    -- EKSİ = kasa geri geldi (borcu düştü). Açık bakiye bu sütunun toplamıdır.
    IF OBJECT_ID('[${db}].dbo.KasaHareket', 'U') IS NULL
    CREATE TABLE [${db}].dbo.KasaHareket (
      Id            INT IDENTITY(1,1) PRIMARY KEY,
      Firma         NVARCHAR(5)   NOT NULL,
      Donem         NVARCHAR(5)   NOT NULL,
      Tarih         DATE          NOT NULL,
      CariInd       INT           NOT NULL,
      CariAd        NVARCHAR(250) NULL,
      KasaTipiId    INT           NULL,
      KasaTipiKod   NVARCHAR(20)  NULL,
      Adet          DECIMAL(18,3) NOT NULL,
      Depozito      DECIMAL(18,2) NOT NULL DEFAULT 0,
      Tutar         DECIMAL(18,2) NOT NULL DEFAULT 0,
      Yon           NVARCHAR(10)  NOT NULL,
      BelgeId       INT           NULL,
      VegayaYazildi BIT           NOT NULL DEFAULT 0,
      VegaBelgeNo   NVARCHAR(100) NULL,
      VegaKayit     NVARCHAR(MAX) NULL,
      Kullanici     NVARCHAR(100) NULL,
      Bilgisayar    NVARCHAR(100) NULL,
      OlusturmaTarihi DATETIME    NOT NULL DEFAULT GETDATE()
    );

    -- Vega'ya yazılan her şeyin günlüğü. Bir kaydın nereden geldiği sorulduğunda
    -- cevap buradan çıkar.
    IF OBJECT_ID('[${db}].dbo.Islem', 'U') IS NULL
    CREATE TABLE [${db}].dbo.Islem (
      Id            INT IDENTITY(1,1) PRIMARY KEY,
      Konu          NVARCHAR(50)  NULL,
      Aciklama      NVARCHAR(250) NULL,
      Ayrinti       NVARCHAR(MAX) NULL,
      Kullanici     NVARCHAR(100) NULL,
      Bilgisayar    NVARCHAR(100) NULL,
      Tarih         DATETIME      NOT NULL DEFAULT GETDATE()
    );
  `);

  // sys.indexes veritabanı adıyla nitelenmeli. Bağlantı havuzu VEGADB'ye
  // bağlı olduğu için nitelenmemiş "sys.indexes" VEGADB'nin indekslerini
  // gösteriyor; kontrol her zaman boş dönüyor ve indeks ikinci çalıştırmada
  // "already exists" hatası veriyordu.
  await calistir(`
    IF NOT EXISTS (SELECT 1 FROM [${db}].sys.indexes
                   WHERE name = 'IX_BelgeSatir_BelgeId'
                     AND object_id = OBJECT_ID('[${db}].dbo.BelgeSatir'))
      CREATE INDEX IX_BelgeSatir_BelgeId ON [${db}].dbo.BelgeSatir (BelgeId);

    IF NOT EXISTS (SELECT 1 FROM [${db}].sys.indexes
                   WHERE name = 'IX_Belge_Tarih'
                     AND object_id = OBJECT_ID('[${db}].dbo.Belge'))
      CREATE INDEX IX_Belge_Tarih ON [${db}].dbo.Belge (Firma, Tarih);

    IF NOT EXISTS (SELECT 1 FROM [${db}].sys.indexes
                   WHERE name = 'IX_KasaHareket_Cari'
                     AND object_id = OBJECT_ID('[${db}].dbo.KasaHareket'))
      CREATE INDEX IX_KasaHareket_Cari ON [${db}].dbo.KasaHareket (Firma, CariInd);
  `);

  // Videodaki kasa türleri ilk açılışta hazır dursun; bedelleri kullanıcı girer.
  await calistir(`
    IF NOT EXISTS (SELECT 1 FROM [${db}].dbo.KasaTipi)
      INSERT INTO [${db}].dbo.KasaTipi (Kod, Ad, Depozito)
      VALUES ('SBÜ', 'Süt büyük kasa', 0), ('PK', 'Plastik kasa', 0);
  `);

  hazirlandi = true;
  return { tamam: true };
}

function kimlik(kullanici) {
  return {
    kullanici: kullanici || os.userInfo().username || '',
    bilgisayar: os.hostname() || ''
  };
}

async function kayitGunlugu(konu, aciklama, ayrinti, kullanici) {
  const k = kimlik(kullanici);
  try {
    await calistir(
      `INSERT INTO [${p()}].dbo.Islem (Konu, Aciklama, Ayrinti, Kullanici, Bilgisayar)
       VALUES (@konu, @aciklama, @ayrinti, @kullanici, @bilgisayar)`,
      {
        konu: String(konu || '').substring(0, 50),
        aciklama: String(aciklama || '').substring(0, 250),
        ayrinti: ayrinti ? JSON.stringify(ayrinti) : null,
        kullanici: k.kullanici,
        bilgisayar: k.bilgisayar
      }
    );
  } catch (e) {
    // Günlük yazılamazsa asıl iş durmasın.
  }
}

// --- Kasa tipleri ----------------------------------------------------------

async function kasaTipleriGetir(hepsi) {
  await hazirla();
  const filtre = hepsi ? '' : 'WHERE Aktif = 1';
  const satirlar = await sorgu(`
    SELECT Id, Kod, Ad, Depozito, Aktif
    FROM [${p()}].dbo.KasaTipi ${filtre}
    ORDER BY Kod
  `);
  return satirlar.map((s) => ({
    id: Number(s.Id),
    kod: String(s.Kod || '').trim(),
    ad: String(s.Ad || '').trim(),
    depozito: Number(s.Depozito) || 0,
    aktif: !!s.Aktif
  }));
}

async function kasaTipiKaydet(kayit) {
  await hazirla();
  const kod = String(kayit.kod || '').trim();
  if (!kod) throw new Error('Kasa tipi kodu boş olamaz.');
  const depozito = Number(kayit.depozito);
  if (!Number.isFinite(depozito) || depozito < 0) {
    throw new Error('Depozito bedeli sıfır veya daha büyük bir sayı olmalı.');
  }

  if (kayit.id) {
    await calistir(
      `UPDATE [${p()}].dbo.KasaTipi
       SET Kod = @kod, Ad = @ad, Depozito = @depozito, Aktif = @aktif
       WHERE Id = @id`,
      {
        id: Number(kayit.id),
        kod,
        ad: String(kayit.ad || '').trim() || null,
        depozito,
        aktif: kayit.aktif === false ? 0 : 1
      }
    );
    return { tamam: true, id: Number(kayit.id) };
  }

  const r = await sorgu(
    `INSERT INTO [${p()}].dbo.KasaTipi (Kod, Ad, Depozito, Aktif)
     OUTPUT INSERTED.Id AS id
     VALUES (@kod, @ad, @depozito, @aktif)`,
    {
      kod,
      ad: String(kayit.ad || '').trim() || null,
      depozito,
      aktif: kayit.aktif === false ? 0 : 1
    }
  );
  return { tamam: true, id: Number(r[0].id) };
}

// --- Belge kaydı -----------------------------------------------------------
//
// Belge ve satırları tek işlemde yazılır: yarım belge kalmaz.
async function belgeKaydet(belge) {
  await hazirla();
  const db = p();
  const k = kimlik(belge.kullanici);

  const satirlar = Array.isArray(belge.satirlar) ? belge.satirlar : [];
  if (!satirlar.length) throw new Error('Belgeye en az bir satır girilmeli.');
  if (!Number(belge.cariInd)) throw new Error('Müşteri seçilmeli.');
  if (belge.belgeTuru !== 'satisFaturasi' && belge.belgeTuru !== 'cariCikis') {
    throw new Error('Belge türü "satisFaturasi" veya "cariCikis" olmalı.');
  }

  const urunTutari = satirlar.reduce((t, s) => t + (Number(s.tutar) || 0), 0);
  const kasaTutari = satirlar.reduce((t, s) => t + (Number(s.kasaTutari) || 0), 0);

  return islem(async (t) => {
    const b = await t.sorgu(
      `INSERT INTO [${db}].dbo.Belge
         (Firma, Donem, Tarih, CariInd, CariKod, CariAd, BelgeTuru, FisNo,
          UrunTutari, KasaTutari, ToplamTutar, Aciklama, Kullanici, Bilgisayar)
       OUTPUT INSERTED.Id AS id
       VALUES
         (@firma, @donem, @tarih, @cariInd, @cariKod, @cariAd, @belgeTuru, @fisNo,
          @urunTutari, @kasaTutari, @toplam, @aciklama, @kullanici, @bilgisayar)`,
      {
        firma: belge.firma,
        donem: belge.donem,
        tarih: new Date(belge.tarih || Date.now()),
        cariInd: Number(belge.cariInd),
        cariKod: belge.cariKod || null,
        cariAd: belge.cariAd || null,
        belgeTuru: belge.belgeTuru,
        fisNo: belge.fisNo || null,
        urunTutari,
        kasaTutari,
        toplam: urunTutari + kasaTutari,
        aciklama: belge.aciklama || null,
        kullanici: k.kullanici,
        bilgisayar: k.bilgisayar
      }
    );
    const belgeId = Number(b[0].id);

    let sira = 0;
    for (const s of satirlar) {
      await t.calistir(
        `INSERT INTO [${db}].dbo.BelgeSatir
           (BelgeId, Sira, StokNo, StokKodu, StokAdi, Birim, BirimEx,
            DaraliMiktar, KasaAdedi, KasaTipiId, KasaTipiKod, Fiyat, Tutar)
         VALUES
           (@belgeId, @sira, @stokNo, @stokKodu, @stokAdi, @birim, @birimEx,
            @miktar, @kasaAdedi, @kasaTipiId, @kasaTipiKod, @fiyat, @tutar)`,
        {
          belgeId,
          sira: sira++,
          stokNo: Number(s.stokNo),
          stokKodu: s.stokKodu || null,
          stokAdi: s.stokAdi || null,
          birim: s.birim || null,
          birimEx: s.birimEx != null ? Number(s.birimEx) : null,
          miktar: Number(s.daraliMiktar) || 0,
          kasaAdedi: Number(s.kasaAdedi) || 0,
          kasaTipiId: s.kasaTipiId != null ? Number(s.kasaTipiId) : null,
          kasaTipiKod: s.kasaTipiKod || null,
          fiyat: Number(s.fiyat) || 0,
          tutar: Number(s.tutar) || 0
        }
      );

      // Kasa verildi → depozito defterine artı satır.
      const adet = Number(s.kasaAdedi) || 0;
      if (adet > 0 && s.kasaTipiId) {
        await t.calistir(
          `INSERT INTO [${db}].dbo.KasaHareket
             (Firma, Donem, Tarih, CariInd, CariAd, KasaTipiId, KasaTipiKod,
              Adet, Depozito, Tutar, Yon, BelgeId, Kullanici, Bilgisayar)
           VALUES
             (@firma, @donem, @tarih, @cariInd, @cariAd, @kasaTipiId, @kasaTipiKod,
              @adet, @depozito, @tutar, 'verilen', @belgeId, @kullanici, @bilgisayar)`,
          {
            firma: belge.firma,
            donem: belge.donem,
            tarih: new Date(belge.tarih || Date.now()),
            cariInd: Number(belge.cariInd),
            cariAd: belge.cariAd || null,
            kasaTipiId: Number(s.kasaTipiId),
            kasaTipiKod: s.kasaTipiKod || null,
            adet,
            depozito: Number(s.kasaDepozito) || 0,
            tutar: Number(s.kasaTutari) || 0,
            belgeId,
            kullanici: k.kullanici,
            bilgisayar: k.bilgisayar
          }
        );
      }
    }

    return { tamam: true, belgeId, urunTutari, kasaTutari, toplam: urunTutari + kasaTutari };
  });
}

async function belgeGetir(belgeId) {
  await hazirla();
  const db = p();
  const b = await sorgu(`SELECT * FROM [${db}].dbo.Belge WHERE Id = @id`, {
    id: Number(belgeId)
  });
  if (!b.length) throw new Error('Belge bulunamadı.');
  const satirlar = await sorgu(
    `SELECT * FROM [${db}].dbo.BelgeSatir WHERE BelgeId = @id ORDER BY Sira, Id`,
    { id: Number(belgeId) }
  );
  return { belge: b[0], satirlar };
}

// Belgeyi siler. Vega'ya yazılmış bir belge buradan silinmez — önce Vega
// kaydının geri alınması gerekir, yoksa iki taraf birbirini tutmaz.
async function belgeSil(belgeId, kullanici) {
  await hazirla();
  const db = p();
  const id = Number(belgeId);

  const b = await sorgu(
    `SELECT Id, VegayaYazildi, VegaBelgeNo FROM [${db}].dbo.Belge WHERE Id = @id`,
    { id }
  );
  if (!b.length) throw new Error('Belge bulunamadı.');
  if (b[0].VegayaYazildi) {
    throw new Error(
      "Bu belge Vega'ya yazılmış. Silmeden önce Vega kaydını geri alın " +
      `(belge no: ${b[0].VegaBelgeNo || '—'}).`
    );
  }

  await islem(async (t) => {
    await t.calistir(`DELETE FROM [${db}].dbo.KasaHareket WHERE BelgeId = @id`, { id });
    await t.calistir(`DELETE FROM [${db}].dbo.BelgeSatir WHERE BelgeId = @id`, { id });
    await t.calistir(`DELETE FROM [${db}].dbo.Belge WHERE Id = @id`, { id });
  });

  await kayitGunlugu('Belge', 'Belge silindi', { belgeId: id }, kullanici);
  return { tamam: true };
}

// --- Haftalık rapor (videodaki ilk ekran) ----------------------------------

async function raporGetir(secenek) {
  await hazirla();
  const db = p();
  const parametreler = { firma: secenek.firma };
  let filtre = 'WHERE B.Firma = @firma';

  if (secenek.baslangic) {
    filtre += ' AND B.Tarih >= @baslangic';
    parametreler.baslangic = new Date(secenek.baslangic);
  }
  if (secenek.bitis) {
    filtre += ' AND B.Tarih <= @bitis';
    parametreler.bitis = new Date(secenek.bitis);
  }
  if (secenek.cariInd) {
    filtre += ' AND B.CariInd = @cariInd';
    parametreler.cariInd = Number(secenek.cariInd);
  }

  const satirlar = await sorgu(
    `
    SELECT TOP 5000
      B.Id AS belgeId, B.Tarih AS tarih, B.CariInd AS cariInd, B.CariAd AS cariAd,
      B.BelgeTuru AS belgeTuru, B.FisNo AS fisNo,
      B.VegayaYazildi AS vegayaYazildi, B.VegaBelgeNo AS vegaBelgeNo,
      S.StokAdi AS cinsi, S.DaraliMiktar AS daraliMiktar, S.KasaAdedi AS kasaAdedi,
      S.KasaTipiKod AS kasaTipi, S.Fiyat AS fiyat, S.Tutar AS tutar, S.Sira AS sira
    FROM [${db}].dbo.Belge B
    JOIN [${db}].dbo.BelgeSatir S ON S.BelgeId = B.Id
    ${filtre}
    ORDER BY B.Tarih, B.Id, S.Sira
  `,
    parametreler
  );

  return satirlar.map((s) => ({
    belgeId: Number(s.belgeId),
    tarih: s.tarih,
    cariInd: Number(s.cariInd),
    cariAd: s.cariAd || '',
    belgeTuru: s.belgeTuru,
    fisNo: s.fisNo || '',
    vegayaYazildi: !!s.vegayaYazildi,
    vegaBelgeNo: s.vegaBelgeNo || '',
    cinsi: s.cinsi || '',
    daraliMiktar: Number(s.daraliMiktar) || 0,
    kasaAdedi: Number(s.kasaAdedi) || 0,
    kasaTipi: s.kasaTipi || '',
    fiyat: Number(s.fiyat) || 0,
    tutar: Number(s.tutar) || 0
  }));
}

// --- Kasa depozito bakiyesi ------------------------------------------------

async function kasaBakiyesi(secenek) {
  await hazirla();
  const db = p();
  const parametreler = { firma: secenek.firma };
  let filtre = 'WHERE Firma = @firma';
  if (secenek.cariInd) {
    filtre += ' AND CariInd = @cariInd';
    parametreler.cariInd = Number(secenek.cariInd);
  }

  const satirlar = await sorgu(
    `
    SELECT CariInd, MAX(CariAd) AS CariAd, KasaTipiId, KasaTipiKod,
           SUM(Adet) AS acikAdet, SUM(Tutar) AS acikTutar
    FROM [${db}].dbo.KasaHareket
    ${filtre}
    GROUP BY CariInd, KasaTipiId, KasaTipiKod
    HAVING SUM(Adet) <> 0
    ORDER BY MAX(CariAd), KasaTipiKod
  `,
    parametreler
  );

  return satirlar.map((s) => ({
    cariInd: Number(s.CariInd),
    cariAd: s.CariAd || '',
    kasaTipiId: s.KasaTipiId != null ? Number(s.KasaTipiId) : null,
    kasaTipiKod: s.KasaTipiKod || '',
    acikAdet: Number(s.acikAdet) || 0,
    acikTutar: Number(s.acikTutar) || 0
  }));
}

// Kasa iadesi. Müşteriden kasa geri geldiğinde defterden düşer; tutar Vega
// tarafında da alacak olarak yazılacaksa yazma modülü bu kaydı kullanır.
async function kasaIadeKaydet(kayit) {
  await hazirla();
  const db = p();
  const k = kimlik(kayit.kullanici);

  const adet = Number(kayit.adet);
  if (!(adet > 0)) throw new Error('İade adedi sıfırdan büyük olmalı.');
  if (!Number(kayit.cariInd)) throw new Error('Müşteri seçilmeli.');
  if (!kayit.kasaTipiId) throw new Error('Kasa tipi seçilmeli.');

  // Müşteride o tipten kaç kasa açık? Fazlasını iade alamayız — yoksa defter
  // eksiye düşer ve depozito bakiyesi anlamsızlaşır.
  const acik = await sorgu(
    `SELECT ISNULL(SUM(Adet), 0) AS acikAdet
     FROM [${db}].dbo.KasaHareket
     WHERE Firma = @firma AND CariInd = @cariInd AND KasaTipiId = @kasaTipiId`,
    {
      firma: kayit.firma,
      cariInd: Number(kayit.cariInd),
      kasaTipiId: Number(kayit.kasaTipiId)
    }
  );
  const acikAdet = Number(acik[0] ? acik[0].acikAdet : 0);
  if (adet > acikAdet) {
    throw new Error(
      `Bu müşteride bu tipten ${acikAdet} kasa açık görünüyor; ${adet} kasa iade alınamaz.`
    );
  }

  const tipler = await kasaTipleriGetir(true);
  const tip = tipler.find((t) => t.id === Number(kayit.kasaTipiId));
  if (!tip) throw new Error('Kasa tipi bulunamadı.');
  const depozito = kayit.depozito != null ? Number(kayit.depozito) : tip.depozito;
  const tutar = adet * depozito;

  const r = await sorgu(
    `INSERT INTO [${db}].dbo.KasaHareket
       (Firma, Donem, Tarih, CariInd, CariAd, KasaTipiId, KasaTipiKod,
        Adet, Depozito, Tutar, Yon, Kullanici, Bilgisayar)
     OUTPUT INSERTED.Id AS id
     VALUES
       (@firma, @donem, @tarih, @cariInd, @cariAd, @kasaTipiId, @kasaTipiKod,
        @adet, @depozito, @tutar, 'iade', @kullanici, @bilgisayar)`,
    {
      firma: kayit.firma,
      donem: kayit.donem,
      tarih: new Date(kayit.tarih || Date.now()),
      cariInd: Number(kayit.cariInd),
      cariAd: kayit.cariAd || null,
      kasaTipiId: Number(kayit.kasaTipiId),
      kasaTipiKod: tip.kod,
      adet: -adet,
      depozito,
      tutar: -tutar,
      kullanici: k.kullanici,
      bilgisayar: k.bilgisayar
    }
  );

  return {
    tamam: true,
    kasaHareketId: Number(r[0].id),
    adet,
    depozito,
    tutar,
    kalanAdet: acikAdet - adet
  };
}

async function kasaHareketGetir(id) {
  await hazirla();
  const r = await sorgu(`SELECT * FROM [${p()}].dbo.KasaHareket WHERE Id = @id`, {
    id: Number(id)
  });
  if (!r.length) throw new Error('Kasa hareketi bulunamadı.');
  return r[0];
}

async function islemGunlugu(limit) {
  await hazirla();
  return sorgu(`
    SELECT TOP ${Math.min(Number(limit) || 200, 2000)}
      Id, Konu, Aciklama, Ayrinti, Kullanici, Bilgisayar, Tarih
    FROM [${p()}].dbo.Islem
    ORDER BY Id DESC
  `);
}

module.exports = {
  p,
  hazirla,
  kayitGunlugu,
  kasaTipleriGetir,
  kasaTipiKaydet,
  belgeKaydet,
  belgeGetir,
  belgeSil,
  raporGetir,
  kasaBakiyesi,
  kasaIadeKaydet,
  kasaHareketGetir,
  islemGunlugu
};
