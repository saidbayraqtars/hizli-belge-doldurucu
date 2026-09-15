'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  KASA/KAP TİPİ ↔ VEGA KASA KARTI
// ═══════════════════════════════════════════════════════════════════════════
//
// BD_KasaTipi programın kendi listesidir (Id kasa defterinde referans), ama bir
// tip ancak seçili firmada STOKKODU aynı, KOD1 = 'KASA', silinmemiş ve tek
// varsayılan birimli bir Vega kartı varsa kullanılabilir. 15.09.2026'ya kadar
// programdan eklenen tipler yalnız BD_KasaTipi'ye yazılıyordu; Vega'da kartı
// olmayan tip seçilince fatura yazılamıyordu (MPK, MUP, S.MUZ, KAYIK, MSK).
// Artık tip kaydedilirken kart da aynı transaction'da Vega'ya açılıyor.
//
// KART DESENİ tahminle değil canlı veriden çıkarıldı: müşteri kopyasında
// VegaWin'in kendi açtığı PK/UP/SB kasa kartları (F0102, 22.08.2026) ve aynı
// firmadaki 66 kartın tamamı aşağıdaki alan kümesini taşıyor. Beş kurulumda
// her kartta dolu olan alanlar: STOKKODU, MALINCINSI, ANABIRIM, BIRIMEX,
// STOKTIPI; birimde BIRIMADI, CARPAN, PB1-3. Bağ çift yönlü:
//   TBLSTOKLAR.BIRIMEX = TBLSTOKLAR.ANABIRIM = TBLBIRIMLEREX.IND
//   TBLBIRIMLEREX.STOKNO = TBLSTOKLAR.IND
// Dara birimin AGIRLIK'ında, depozito SATISFIYATI1'de (bkz. db/vega.js →
// kasaKartlariniGetir). TBLSTOKENVANTER'e kasa kartı için satır açılmıyor.
//
// Tuzaklar:
//   - STOKKODU üzerinde UNIQUE indeks var (IDXSTOKKODU): SİLİNMİŞ kart da kodu
//     tutar. Aynı kodlu her kart çakışmadır, üzerine yazılmaz.
//   - Aynı kod KASA işaretsiz bir üründe olabilir (müşteride İNCİR, kart 129).
//     Ürün kartı asla kendiliğinden kasaya çevrilmez.
//   - KDVGRUBU numarası firmadan firmaya farklı oran: F0102'de IND 1 = %0,
//     F0101'de IND 1 = %1. Grup, orana (KDV = 0) bakılarak seçilir.

const crypto = require('crypto');
const { sorgu } = require('./sql');
const { ayarOku } = require('./ayar');
const { kart } = require('./firma');
const { kolonVarMi } = require('./vega');

function vt() {
  return ayarOku().vegaVeritabani;
}

function vegaUid() {
  return '{' + crypto.randomUUID().toUpperCase() + '}';
}

const sutunOnbellek = new Map();

// Sütun adı → karakter sınırı (sınırsız/ sayısal sütunlarda null).
async function sutunlar(tamTabloAdi) {
  if (sutunOnbellek.has(tamTabloAdi)) return sutunOnbellek.get(tamTabloAdi);
  const bekleyen = (async () => {
    const r = await sorgu(
      `SELECT c.name AS ad, ty.name AS tip, c.max_length AS bayt
       FROM sys.columns c
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       WHERE c.object_id = OBJECT_ID(@tablo) AND c.is_identity = 0 AND c.is_computed = 0`,
      { tablo: tamTabloAdi }
    );
    if (!r.length) throw new Error(`Tablo bulunamadı ya da okunamadı: ${tamTabloAdi}`);
    const harita = new Map();
    for (const s of r) {
      const tip = String(s.tip).toLowerCase();
      const bayt = Number(s.bayt);
      let sinir = null;
      if (bayt > 0 && (tip === 'nvarchar' || tip === 'nchar')) sinir = bayt / 2;
      else if (bayt > 0 && (tip === 'varchar' || tip === 'char')) sinir = bayt;
      harita.set(String(s.ad).toUpperCase(), sinir);
    }
    return harita;
  })();
  sutunOnbellek.set(tamTabloAdi, bekleyen);
  try {
    return await bekleyen;
  } catch (e) {
    sutunOnbellek.delete(tamTabloAdi);
    throw e;
  }
}

// Tabloda olmayan sütun atlanır; null/undefined değer yazılmaz.
async function satirEkle(t, tamTabloAdi, alanlar, ozel) {
  const mevcut = await sutunlar(tamTabloAdi);
  const adlar = [];
  const degerler = [];
  const p = {};
  let sira = 0;
  for (const [ad, deger] of Object.entries(alanlar)) {
    if (deger === null || deger === undefined || !mevcut.has(ad)) continue;
    adlar.push(`[${ad}]`);
    degerler.push('@p' + sira);
    p['p' + sira++] = deger;
  }
  for (const [ad, ifade] of Object.entries(ozel || {})) {
    if (!mevcut.has(ad)) continue;
    adlar.push(`[${ad}]`);
    degerler.push(ifade);
  }
  const r = await t.sorgu(
    `INSERT INTO ${tamTabloAdi} (${adlar.join(', ')})
     OUTPUT INSERTED.IND AS ind
     VALUES (${degerler.join(', ')})`,
    p
  );
  const ind = Number(r[0] && r[0].ind);
  if (!ind) throw new Error(`${tamTabloAdi} satırı yazıldı ama numarası okunamadı.`);
  return ind;
}

// --- Girdi ---------------------------------------------------------------------

function negatifOlmayan(ham, etiket, basamak) {
  const n = ham === '' || ham === null || ham === undefined ? 0 : Number(ham);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${etiket} sıfır ya da pozitif bir sayı olmalı.`);
  const k = Math.pow(10, basamak);
  return Math.round(n * k) / k;
}

function kasaTipiGirdisi(ayrinti) {
  const a = ayrinti || {};
  const kod = String(a.kod || '').trim();
  if (!kod) throw new Error('Kasa tipi kodu boş olamaz.');
  return {
    kod,
    ad: String(a.ad || '').trim() || kod,
    dara: negatifOlmayan(a.dara, 'Dara', 3),
    depozito: negatifOlmayan(a.depozito, 'Depozito', 2)
  };
}

function kodAnahtari(kod) {
  return String(kod || '').trim().toLocaleUpperCase('tr-TR');
}

// --- Eşleşme -----------------------------------------------------------------

async function birimIfadeleri(birimTablosu) {
  const f1 = (await kolonVarMi(birimTablosu, 'SATISFIYATI1')) ? 'ISNULL(B.SATISFIYATI1, 0)' : '0';
  const f0 = (await kolonVarMi(birimTablosu, 'SATISFIYATI')) ? 'ISNULL(B.SATISFIYATI, 0)' : '0';
  return {
    depozito: `CASE WHEN ${f1} > 0 THEN ${f1} WHEN ${f0} > 0 THEN ${f0} ELSE ISNULL(S.ALISFIYATI, 0) END`,
    dara: (await kolonVarMi(birimTablosu, 'AGIRLIK')) ? 'ISNULL(B.AGIRLIK, 0)' : '0'
  };
}

function eslesmeKur(satirlar) {
  const ilk = satirlar[0];
  const kod = String(ilk.tipKodu || '').trim();
  const e = {
    id: Number(ilk.tipId),
    kod,
    ad: String(ilk.tipAdi || '').trim() || kod,
    dara: Number(ilk.tipDara) || 0,
    depozito: Number(ilk.tipDepozito) || 0,
    aktif: !!ilk.aktif,
    durum: 'hazir',
    neden: '',
    kart: null,
    cakisan: null
  };
  const kartNumaralari = new Set(satirlar.map((s) => Number(s.stokNo)).filter(Boolean));

  if (!kartNumaralari.size) {
    e.durum = 'kartYok';
    if (ilk.cakisanNo != null) {
      e.cakisan = {
        stokNo: Number(ilk.cakisanNo),
        ad: String(ilk.cakisanAd || '').trim(),
        silindi: !!Number(ilk.cakisanSilindi)
      };
      e.neden = e.cakisan.silindi
        ? `${kod} kodu Vega'da silinmiş bir stok kartında (kart no ${e.cakisan.stokNo}) duruyor; ` +
          'Vega aynı kodla ikinci kart açtırmaz. Kartı Vega\'da geri alıp KOD1=KASA yapın ya da başka kod kullanın.'
        : `${kod} kodu Vega'da kasa olarak işaretlenmemiş "${e.cakisan.ad}" stok kartında ` +
          `(kart no ${e.cakisan.stokNo}) kullanılıyor. Ürün kartı kasaya çevrilmez; ` +
          'kart gerçekten kasaysa Vega\'da KOD1=KASA yapın, değilse başka kod kullanın.';
    } else {
      e.neden = `${kod} kasa tipinin Vega'da etkin stok kartı yok. ` +
        'Ayarlar > Kasa Tipleri ekranında tipi kaydederek kartı açın.';
    }
    return e;
  }
  if (kartNumaralari.size > 1) {
    e.durum = 'cokluKart';
    e.neden = `${kod} koduyla Vega'da birden çok etkin kasa kartı var.`;
    return e;
  }
  if (satirlar.length > 1) {
    e.durum = 'cokluBirim';
    e.neden = `${kod} Vega kasa kartında birden çok varsayılan birim var.`;
    return e;
  }
  if (!Number(ilk.birimEx)) {
    e.durum = 'birimYok';
    e.neden = `${kod} kasa kartının Vega'da varsayılan birimi yok.`;
    return e;
  }
  e.kart = {
    stokNo: Number(ilk.stokNo),
    kod: String(ilk.kod || kod).trim(),
    ad: String(ilk.ad || '').trim() || kod,
    stokTipi: Number(ilk.stokTipi) || 0,
    maliyet: Number(ilk.maliyet) || 0,
    birimEx: Number(ilk.birimEx),
    birim: String(ilk.birim || '').trim(),
    carpan: Number(ilk.carpan) || 1,
    dara: Number(ilk.dara) || 0,
    depozito: Number(ilk.depozito) || 0
  };
  return e;
}

// Her BD_KasaTipi satırının seçili firmadaki Vega kart durumu. secenek:
//   idler   — yalnız bu tipler (verilmezse hepsi)
//   t       — transaction aracı; kilitle ile satırlar işlem sonuna kadar tutulur
async function kasaTipiEslesmeleri(firma, secenek) {
  const o = secenek || {};
  let idler = null;
  if (o.idler) {
    idler = [...new Set(o.idler.map(Number))];
    if (idler.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('Geçersiz kasa tipi seçimi.');
    }
    if (!idler.length) return [];
  }
  const v = vt();
  const oku = o.t ? o.t.sorgu : sorgu;
  const stokTablosu = kart(v, firma, 'TBLSTOKLAR');
  const birimTablosu = kart(v, firma, 'TBLBIRIMLEREX');
  if (!(await kolonVarMi(stokTablosu, 'KOD1'))) {
    throw new Error(`${firma} stok kartlarında KOD1 sütunu yok; kasa kartı ayırt edilemiyor.`);
  }
  const silinmeVar = await kolonVarMi(stokTablosu, 'DELETED');
  const kilit = o.kilitle ? 'WITH (UPDLOCK, HOLDLOCK)' : '';
  const ifade = await birimIfadeleri(birimTablosu);

  const satirlar = await oku(`
    SELECT KT.Id AS tipId, KT.Kod AS tipKodu, KT.Ad AS tipAdi, KT.Dara AS tipDara,
           KT.Depozito AS tipDepozito, KT.Aktif AS aktif,
           S.IND AS stokNo, S.STOKKODU AS kod, S.MALINCINSI AS ad,
           ISNULL(S.STOKTIPI, 0) AS stokTipi, ISNULL(S.MALIYET, 0) AS maliyet,
           B.IND AS birimEx, B.BIRIMADI AS birim, B.CARPAN AS carpan,
           ${ifade.depozito} AS depozito, ${ifade.dara} AS dara,
           C.IND AS cakisanNo, C.MALINCINSI AS cakisanAd, C.silindi AS cakisanSilindi
    FROM [${v}].dbo.BD_KasaTipi KT ${kilit}
    LEFT JOIN ${stokTablosu} S ${kilit}
      ON UPPER(LTRIM(RTRIM(S.STOKKODU))) = UPPER(LTRIM(RTRIM(KT.Kod)))
     AND UPPER(LTRIM(RTRIM(ISNULL(S.KOD1, '')))) = 'KASA'
     ${silinmeVar ? 'AND ISNULL(S.DELETED, 0) = 0' : ''}
    LEFT JOIN ${birimTablosu} B
      ON B.STOKNO = S.IND AND B.VARSAYILAN = 1
    OUTER APPLY (
      SELECT TOP 1 X.IND, X.MALINCINSI,
             ${silinmeVar ? 'CAST(ISNULL(X.DELETED, 0) AS INT)' : '0'} AS silindi
      FROM ${stokTablosu} X ${kilit}
      WHERE UPPER(LTRIM(RTRIM(X.STOKKODU))) = UPPER(LTRIM(RTRIM(KT.Kod)))
      ORDER BY X.IND
    ) C
    ${idler ? `WHERE KT.Id IN (${idler.join(',')})` : ''}
    ORDER BY KT.Kod, KT.Id, S.IND, B.IND
  `);

  const gruplar = new Map();
  for (const s of satirlar) {
    const id = Number(s.tipId);
    if (!gruplar.has(id)) gruplar.set(id, []);
    gruplar.get(id).push(s);
  }
  return [...gruplar.values()].map(eslesmeKur);
}

// Arayüzdeki kasaStokNo, geçmişten kalan adına rağmen BD_KasaTipi.Id'dir.
// Vega kart numarası firma bazında değişebilir; eşleşmeyi her yazmada koddan
// çözerek başka firmaya ait veya artık geçersiz bir IND kullanılmasını önleriz.
async function kasaKartlariniCoz(firma, tipIdleri, t) {
  const idler = [...new Set(tipIdleri.map(Number))];
  if (idler.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Geçersiz kasa tipi seçimi.');
  }
  if (!idler.length) return new Map();
  const eslesmeler = await kasaTipiEslesmeleri(firma, { idler, t });
  const sonuc = new Map();
  for (const id of idler) {
    const e = eslesmeler.find((x) => x.id === id);
    if (!e || !e.aktif) throw new Error(`Kasa tipi bulunamadı veya pasif: ${id}.`);
    if (e.durum !== 'hazir') throw new Error(e.neden);
    sonuc.set(id, e.kart);
  }
  return sonuc;
}

// --- Kart açma / güncelleme ----------------------------------------------------

async function tabloVar(tamTabloAdi) {
  const r = await sorgu(`SELECT OBJECT_ID(@tablo, 'U') AS id`, { tablo: tamTabloAdi });
  return !!(r[0] && r[0].id != null);
}

// Kasa depozitosu satış değil iade edilecek teminattır; kart %0 grubuna bağlanır.
async function sifirKdvGrubu(t, v, firma) {
  const tablo = kart(v, firma, 'TBLKDVGRUPLARI');
  // Eski kurulumlarda grup tablosu yok; oradaki bütün kartlar KDVGRUBU = 1.
  if (!(await tabloVar(tablo))) return 1;
  const r = await t.sorgu(`SELECT TOP 1 IND FROM ${tablo} WHERE ISNULL(KDV, -1) = 0 ORDER BY IND`);
  if (!r.length) {
    throw new Error(`${firma} firmasında %0 KDV grubu yok. Kasa kartı açmadan önce Vega'da %0 KDV grubu tanımlayın.`);
  }
  return Number(r[0].IND);
}

async function kartDeposu(t, v) {
  const depo = Number(ayarOku().varsayilanDepo) || 1;
  const tablo = `[${v}].dbo.TBLDEPOLAR`;
  if (!(await tabloVar(tablo))) return depo;
  const r = await t.sorgu(`SELECT IND FROM ${tablo} WHERE IND = @depo`, { depo });
  if (!r.length) throw new Error(`Depo ${depo} Vega'da yok. Ayarlar ekranından depo seçin.`);
  return depo;
}

async function zorunluSutunlar(tamTabloAdi, adlar) {
  const mevcut = await sutunlar(tamTabloAdi);
  const eksik = adlar.filter((ad) => !mevcut.has(ad));
  if (eksik.length) {
    throw new Error(`${tamTabloAdi} tablosunda beklenen sütun yok: ${eksik.join(', ')}. Vega sürümü farklı olabilir.`);
  }
  return mevcut;
}

function sinirKontrol(mevcut, sutun, deger, etiket) {
  const sinir = mevcut.get(sutun);
  if (sinir && deger.length > sinir) throw new Error(`${etiket} en fazla ${sinir} karakter olabilir.`);
}

// Seçili firmada kodu boş olan yeni bir KOD1=KASA kartı + varsayılan ADET birimi
// açar. Çağıran, aynı transaction'da eşleşmenin 'kartYok' olduğunu (kilitle
// ile) doğrulamış olmalı; burada kod yine de kilitli okunur.
async function vegaKasaKartiAc(t, secenek) {
  const { kod, ad, dara, depozito } = kasaTipiGirdisi(secenek);
  const firma = secenek.firma;
  const v = vt();
  const stokTablosu = kart(v, firma, 'TBLSTOKLAR');
  const birimTablosu = kart(v, firma, 'TBLBIRIMLEREX');

  const stokSutunlari = await zorunluSutunlar(stokTablosu,
    ['STOKKODU', 'MALINCINSI', 'KOD1', 'STOKTIPI', 'ANABIRIM', 'BIRIMEX']);
  const birimSutunlari = await zorunluSutunlar(birimTablosu,
    ['STOKNO', 'BIRIMADI', 'CARPAN', 'VARSAYILAN']);
  sinirKontrol(stokSutunlari, 'STOKKODU', kod, 'Kasa tipi kodu');
  sinirKontrol(stokSutunlari, 'MALINCINSI', ad, 'Kasa tipi adı');
  const fiyatSutunu = birimSutunlari.has('SATISFIYATI1') ? 'SATISFIYATI1'
    : (birimSutunlari.has('SATISFIYATI') ? 'SATISFIYATI' : null);
  if (depozito > 0 && !fiyatSutunu) {
    throw new Error(`${birimTablosu} tablosunda fiyat sütunu yok; depozito karta yazılamaz.`);
  }

  const ayni = await t.sorgu(
    `SELECT IND FROM ${stokTablosu} WITH (UPDLOCK, HOLDLOCK)
     WHERE UPPER(LTRIM(RTRIM(STOKKODU))) = UPPER(@kod)`,
    { kod }
  );
  if (ayni.length) {
    throw new Error(`${kod} kodu Vega'da başka bir stok kartında (kart no ${ayni[0].IND}) kullanılıyor.`);
  }

  const kdvGrubu = await sifirKdvGrubu(t, v, firma);
  const depo = await kartDeposu(t, v);

  const stokNo = await satirEkle(t, stokTablosu, {
    STOKKODU: kod,
    MALINCINSI: ad,
    KOD1: 'KASA',
    STOKTIPI: 0,
    DEPO: depo,
    DEPOSEVIYESI: true,
    AYLIKVADE: 0,
    GARANTI: 0,
    PRIM: 0,
    IPTAL: false,
    STOKTAKIP: 0,
    TEMINYERI: 1,
    RAFOMRU: 0,
    KALAN: 0,
    REZERV: 0,
    TAKSITSAYISI: 0,
    ALISFIYATI: 0,
    ESKIALISFIYATI: 0,
    MALIYET: 1,
    KDVGRUBU: kdvGrubu,
    AKTIF: false,
    ISCILIKIND: 0,
    ISCILIKBIRIMIND: 0,
    STATUS: 1,
    OIV: 0,
    KARORANI: 0,
    OTV: 0,
    ISK: 0,
    ISKSATISFIYATI2: 0,
    ISKSATISFIYATI3: 0,
    ALISKDVORANI: 0,
    SIPARISALINMASIN: false,
    SIPARISVERILMESIN: false,
    ITSBILDIRIMI: false,
    ACILSEVK: false,
    SOGUKSEVK: false,
    DKUR: 1,
    STOKNEVI: 0,
    OTVORANSAL: true,
    YAZARKASA: false,
    UID: vegaUid()
  }, { KARTINACILMATARIHI: 'GETDATE()' });

  const birimAlanlari = {
    BIRIMADI: 'ADET',
    CARPAN: 1,
    BARCODESTD: 0,
    STOKNO: stokNo,
    SATISFIYATI: 0,
    ACIKLAMA: 'FIYAT',
    KDV: 0,
    KDVDAHIL: true,
    SPARABIRIMI: 1,
    EN: 0,
    BOY: 0,
    YUKSEKLIK: 0,
    AGIRLIK: dara,
    HACIM: 0,
    ESKISATISFIYATI: 0,
    VARSAYILAN: true,
    ANABIRIM: true,
    ACIKLAMAIND: 1,
    UID: vegaUid()
  };
  for (let n = 1; n <= 6; n++) {
    birimAlanlari['SATISFIYATI' + n] = 0;
    birimAlanlari['PB' + n] = 'TL';
    if (n <= 3) birimAlanlari['ESKIFIYAT' + n] = 0;
  }
  if (fiyatSutunu) birimAlanlari[fiyatSutunu] = depozito;
  const birimEx = await satirEkle(t, birimTablosu, birimAlanlari, {
    FIYATDEGISMETARIHI1: 'GETDATE()',
    FIYATDEGISMETARIHI2: 'GETDATE()',
    FIYATDEGISMETARIHI3: 'GETDATE()'
  });

  const bag = await t.calistir(
    `UPDATE ${stokTablosu} SET ANABIRIM = @birimEx, BIRIMEX = @birimEx WHERE IND = @stokNo`,
    { stokNo, birimEx }
  );
  if (Number(bag[0]) !== 1) throw new Error(`${kod} kasa kartı birimine bağlanamadı.`);

  const kontrol = await t.sorgu(
    `SELECT S.IND AS stokNo, B.IND AS birimEx
     FROM ${stokTablosu} S
     JOIN ${birimTablosu} B ON B.STOKNO = S.IND AND B.VARSAYILAN = 1
     WHERE UPPER(LTRIM(RTRIM(S.STOKKODU))) = UPPER(@kod)
       AND S.KOD1 = 'KASA' AND S.BIRIMEX = B.IND AND S.ANABIRIM = B.IND`,
    { kod }
  );
  if (kontrol.length !== 1 || Number(kontrol[0].stokNo) !== stokNo || Number(kontrol[0].birimEx) !== birimEx) {
    throw new Error(`${kod} kasa kartı açıldı ama doğrulanamadı; işlem geri alındı.`);
  }
  return { stokNo, birimEx, kod, ad, dara, depozito, kdvGrubu, depo };
}

// Hazır bir kasa kartının adını, darasını ve depozitosunu günceller. Değişmeyen
// alana dokunulmaz; depozito değişirse Vega'nın yaptığı gibi eski fiyat
// ESKIFIYAT1'e, değişme anı FIYATDEGISMETARIHI1'e yazılır.
async function vegaKasaKartiGuncelle(t, secenek) {
  const { ad, dara, depozito } = kasaTipiGirdisi(secenek);
  const k = secenek.kart;
  const v = vt();
  const stokTablosu = kart(v, secenek.firma, 'TBLSTOKLAR');
  const birimTablosu = kart(v, secenek.firma, 'TBLBIRIMLEREX');
  const stokSutunlari = await sutunlar(stokTablosu);
  const birimSutunlari = await sutunlar(birimTablosu);
  const fiyatSutunu = birimSutunlari.has('SATISFIYATI1') ? 'SATISFIYATI1'
    : (birimSutunlari.has('SATISFIYATI') ? 'SATISFIYATI' : null);
  const agirlikVar = birimSutunlari.has('AGIRLIK');
  sinirKontrol(stokSutunlari, 'MALINCINSI', ad, 'Kasa tipi adı');

  const p = { stokNo: k.stokNo, birimEx: k.birimEx, ad, dara, depozito };
  const b = await t.sorgu(
    `SELECT ${fiyatSutunu ? `ISNULL(B.${fiyatSutunu}, 0)` : '0'} AS fiyat,
            ${agirlikVar ? 'ISNULL(B.AGIRLIK, 0)' : '0'} AS agirlik,
            S.MALINCINSI AS ad
     FROM ${birimTablosu} B WITH (UPDLOCK, HOLDLOCK)
     JOIN ${stokTablosu} S WITH (UPDLOCK, HOLDLOCK) ON S.IND = B.STOKNO
     WHERE B.IND = @birimEx AND B.STOKNO = @stokNo AND S.KOD1 = 'KASA'`,
    p
  );
  if (b.length !== 1) throw new Error(`${k.kod} kasa kartı güncellenirken bulunamadı.`);

  let degisti = false;
  const birimSet = [];
  if (agirlikVar && Math.abs(Number(b[0].agirlik) - dara) > 0.0005) birimSet.push('AGIRLIK = @dara');
  if (fiyatSutunu && Math.abs(Number(b[0].fiyat) - depozito) > 0.005) {
    if (fiyatSutunu === 'SATISFIYATI1' && birimSutunlari.has('ESKIFIYAT1')) {
      birimSet.push('ESKIFIYAT1 = SATISFIYATI1');
    }
    birimSet.push(`${fiyatSutunu} = @depozito`);
    if (fiyatSutunu === 'SATISFIYATI1' && birimSutunlari.has('FIYATDEGISMETARIHI1')) {
      birimSet.push('FIYATDEGISMETARIHI1 = GETDATE()');
    }
  }
  if (birimSet.length) {
    await t.calistir(
      `UPDATE ${birimTablosu} SET ${birimSet.join(', ')} WHERE IND = @birimEx AND STOKNO = @stokNo`, p);
    degisti = true;
  }
  if (String(b[0].ad || '').trim() !== ad) {
    const guncelleme = stokSutunlari.has('GUNCELLEMETARIHI') ? ', GUNCELLEMETARIHI = GETDATE()' : '';
    await t.calistir(
      `UPDATE ${stokTablosu} SET MALINCINSI = @ad${guncelleme} WHERE IND = @stokNo`, p);
    degisti = true;
  }
  return { degisti };
}

module.exports = {
  kasaTipiGirdisi,
  kodAnahtari,
  kasaTipiEslesmeleri,
  kasaKartlariniCoz,
  vegaKasaKartiAc,
  vegaKasaKartiGuncelle
};
