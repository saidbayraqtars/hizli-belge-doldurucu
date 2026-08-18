'use strict';

const { sorgu } = require('./sql');
const { ayarOku } = require('./ayar');

// VegaWin tablo adı deseni:
//   Kart tablosu  : F0102TBLCARI              (dönem yok)
//   Dönemli tablo : F0102D0002TBLCARIHAREKETLERI
//
// Firma ve dönem kodları tablo adına metin olarak gömüldüğü için — parametre
// olarak verilemezler — yalnızca veritabanında GERÇEKTEN var olan kodlara izin
// veriyoruz. Bu, kod enjeksiyonuna kapalı tek yol.

let onbellek = null;

function gecerliKod(kod, harf) {
  return typeof kod === 'string' && new RegExp('^' + harf + '\\d{4}$').test(kod);
}

// Bu programın çalışabilmesi için firmada cari ve stok kartı, dönemde de cari
// hareket tablosu bulunmalı. Eksik olan firma/dönem listeye hiç girmez; yarım
// kalmış DEMO firmaları böylece kullanıcıya gösterilmiyor.
async function firmalariGetir(yenile) {
  if (onbellek && !yenile) return onbellek;
  const v = ayarOku().vegaVeritabani;

  const firmalar = await sorgu(`
    SELECT IND, KOD, KISAAD, AD1
    FROM [${v}].dbo.TBLFIRMA
    ORDER BY IND
  `);

  const kartTablolari = await sorgu(`
    SELECT
      LEFT(name, CHARINDEX('TBL', name) - 1) AS onek,
      SUBSTRING(name, CHARINDEX('TBL', name), 200) AS tablo
    FROM [${v}].sys.tables
    WHERE name LIKE 'F[0-9][0-9][0-9][0-9]TBL%'
      AND SUBSTRING(name, CHARINDEX('TBL', name), 200) IN ('TBLCARI', 'TBLSTOKLAR')
  `);
  const kartHaritasi = {};
  for (const k of kartTablolari) {
    if (!gecerliKod(k.onek, 'F')) continue;
    if (!kartHaritasi[k.onek]) kartHaritasi[k.onek] = new Set();
    kartHaritasi[k.onek].add(k.tablo);
  }

  const donemTablolari = await sorgu(`
    SELECT LEFT(name, CHARINDEX('TBL', name) - 1) AS onek
    FROM [${v}].sys.tables
    WHERE name LIKE 'F[0-9][0-9][0-9][0-9]D[0-9][0-9][0-9][0-9]TBLCARIHAREKETLERI'
  `);
  const donemHaritasi = {};
  for (const satir of donemTablolari) {
    const onek = satir.onek || '';
    const firmaKodu = onek.substring(0, 5);
    const donemKodu = onek.substring(5);
    if (!gecerliKod(firmaKodu, 'F') || !gecerliKod(donemKodu, 'D')) continue;
    if (!donemHaritasi[firmaKodu]) donemHaritasi[firmaKodu] = [];
    donemHaritasi[firmaKodu].push(donemKodu);
  }

  const liste = [];
  for (const f of firmalar) {
    const kod = 'F' + String(f.IND).padStart(4, '0');
    const kartlar = kartHaritasi[kod];
    if (!kartlar || kartlar.size < 2) continue;
    const donemler = (donemHaritasi[kod] || []).slice().sort();
    if (!donemler.length) continue;
    liste.push({
      kod,
      no: f.IND,
      kisaAd: (f.KISAAD || f.KOD || kod).trim(),
      unvan: (f.AD1 || '').trim(),
      donemler
    });
  }

  // Her dönemin son cari hareketi — kullanıcı hangisinin canlı olduğunu görsün.
  for (const firma of liste) {
    firma.donemBilgi = [];
    for (const d of firma.donemler) {
      try {
        const r = await sorgu(`
          SELECT COUNT(*) AS adet, MAX(TARIH) AS sonTarih
          FROM [${v}].dbo.${firma.kod}${d}TBLCARIHAREKETLERI
        `);
        firma.donemBilgi.push({
          donem: d,
          hareket: r[0] ? Number(r[0].adet) : 0,
          sonTarih: r[0] ? r[0].sonTarih : null
        });
      } catch (e) {
        firma.donemBilgi.push({ donem: d, hareket: 0, sonTarih: null });
      }
    }
    const enYogun = firma.donemBilgi.slice().sort((x, y) => y.hareket - x.hareket)[0];
    firma.varsayilanDonem = enYogun ? enYogun.donem : firma.donemler[0];
  }

  onbellek = liste;
  return liste;
}

// Verilen firma/dönem gerçekten var mı? Yazma ve okuma yollarının tamamı buradan
// geçer; doğrulanmamış bir kod tablo adına asla gömülmez.
async function dogrula(firmaKodu, donemKodu) {
  const a = ayarOku();
  const istenenFirma = firmaKodu || a.varsayilanFirma;
  const istenenDonem = donemKodu || a.varsayilanDonem;

  if (!istenenFirma) {
    throw new Error('Firma seçilmemiş. Ayarlar ekranından firma ve dönem seçin.');
  }

  const liste = await firmalariGetir();
  const firma = liste.find((f) => f.kod === istenenFirma);
  if (!firma) throw new Error(`Firma bulunamadı: ${istenenFirma}`);

  const donem = istenenDonem || firma.varsayilanDonem;
  if (!firma.donemler.includes(donem)) {
    throw new Error(`Dönem bulunamadı: ${istenenFirma} / ${donem}`);
  }
  return { firma: firma.kod, donem, ad: firma.kisaAd };
}

// Dönemli tablo adı
function tablo(vt, firmaKodu, donemKodu, ad) {
  return `[${vt}].dbo.${firmaKodu}${donemKodu}${ad}`;
}

// Kart tablosu adı (dönemsiz)
function kart(vt, firmaKodu, ad) {
  return `[${vt}].dbo.${firmaKodu}${ad}`;
}

async function depolariGetir() {
  const v = ayarOku().vegaVeritabani;
  try {
    return await sorgu(`
      SELECT IND AS no, DEPOADI AS ad, DEPOKODU AS kod
      FROM [${v}].dbo.TBLDEPOLAR
      ORDER BY IND
    `);
  } catch (e) {
    return [];
  }
}

// Müşteri veritabanlarında 15 binden fazla tablo olabiliyor; hepsini birden
// çekmek ilk çağrıyı saniyelerce bekletiyor. Yalnızca sorulan tabloyu soruyor
// ve cevabı akılda tutuyoruz.
const tabloOnbellek = new Map();

async function tabloVarMi(firmaKodu, donemKodu, ad) {
  const tamAd = firmaKodu + (donemKodu || '') + ad;
  if (tabloOnbellek.has(tamAd)) return tabloOnbellek.get(tamAd);

  const bekleyen = (async () => {
    const v = ayarOku().vegaVeritabani;
    const r = await sorgu(
      `SELECT CASE WHEN OBJECT_ID(@tam, 'U') IS NULL THEN 0 ELSE 1 END AS varMi`,
      { tam: `[${v}].dbo.[${tamAd}]` }
    );
    const sonuc = !!(r[0] && Number(r[0].varMi) === 1);
    tabloOnbellek.set(tamAd, sonuc);
    return sonuc;
  })();

  tabloOnbellek.set(tamAd, bekleyen);
  return bekleyen;
}

function onbellekTemizle() {
  onbellek = null;
  tabloOnbellek.clear();
}

module.exports = {
  firmalariGetir,
  dogrula,
  tablo,
  kart,
  depolariGetir,
  tabloVarMi,
  onbellekTemizle
};
