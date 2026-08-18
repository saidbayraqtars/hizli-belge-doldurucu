'use strict';

const mssql = require('mssql');
const { ayarOku } = require('./ayar');

// Windows oturumuyla bağlanmak isteyen kurulumlar için isteğe bağlı sürücü.
// Kurulu değilse program SQL kullanıcısıyla çalışmaya devam eder.
let mssqlWindows = null;
try {
  mssqlWindows = require('mssql/msnodesqlv8');
} catch (e) {
  mssqlWindows = null;
}

let havuz = null;
let havuzAnahtari = '';
let aktifSurucu = mssql;

// Sunucu adını sürücünün anlayacağı hale getirir.
//
// Microsoft'un kendi araçları (SSMS, Vega, sqlcmd) "(local)", "." ve
// "(local)\SQLEXPRESS" gibi takma adları kabul eder; kullandığımız tedious
// sürücüsü etmez, gerçek makine adı ister. Ayrıca "MAKINE\SQLEXPRESS"
// biçimindeki adlandırılmış örnekler ayrı bir alanla (instanceName) verilmek
// zorunda; port yerine SQL Browser üzerinden bulunuyor.
function sunucuCoz(ham) {
  const metin = String(ham || '').trim();
  const parcalar = metin.split('\\');
  let makine = (parcalar[0] || '').trim();
  const ornek = parcalar.length > 1 ? parcalar.slice(1).join('\\').trim() : '';

  const yerelTakmaAdlar = ['', '.', '(local)', 'local', '(localhost)'];
  if (yerelTakmaAdlar.includes(makine.toLowerCase())) makine = 'localhost';

  return { makine, ornek };
}

function anahtarUret(a) {
  return [a.sunucu, a.port, a.windowsGirisi ? 'win' : a.kullanici, a.vegaVeritabani].join('|');
}

function baglantiAyari(a) {
  const { makine, ornek } = sunucuCoz(a.sunucu);

  if (a.windowsGirisi && mssqlWindows) {
    return {
      surucu: mssqlWindows,
      config: {
        // msnodesqlv8 takma adları zaten anlıyor; kullanıcının yazdığını
        // olduğu gibi veriyoruz.
        server: a.sunucu,
        database: a.vegaVeritabani,
        driver: 'msnodesqlv8',
        options: {
          trustedConnection: true,
          trustServerCertificate: true
        },
        pool: { max: 8, min: 0, idleTimeoutMillis: 30000 },
        requestTimeout: 120000
      }
    };
  }

  const config = {
    server: makine,
    user: a.kullanici,
    password: a.sifre,
    database: a.vegaVeritabani,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true
    },
    pool: { max: 8, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 120000
  };

  if (ornek) {
    // Adlandırılmış örnekte portu SQL Browser bulur; ikisi birden verilemez.
    config.options.instanceName = ornek;
  } else {
    config.port = Number(a.port) || 1433;
  }

  return { surucu: mssql, config };
}

async function havuzAl() {
  const a = ayarOku();
  const anahtar = anahtarUret(a);
  if (havuz && havuzAnahtari === anahtar && havuz.connected) return havuz;
  if (havuz) {
    try { await havuz.close(); } catch (e) { /* kapalıysa sorun değil */ }
    havuz = null;
  }
  if (a.windowsGirisi && !mssqlWindows) {
    throw new Error(
      'Windows oturumuyla bağlanma seçili ama gerekli sürücü kurulu değil. ' +
      'Ayarlar ekranından SQL kullanıcı adı ve şifresi girin.'
    );
  }
  const { surucu, config } = baglantiAyari(a);
  havuz = await new surucu.ConnectionPool(config).connect();
  aktifSurucu = surucu;
  havuzAnahtari = anahtar;
  return havuz;
}

async function havuzKapat() {
  if (havuz) {
    try { await havuz.close(); } catch (e) { /* yoksay */ }
    havuz = null;
    havuzAnahtari = '';
  }
}

function parametreEkle(istek, parametreler) {
  if (!parametreler) return istek;
  for (const ad of Object.keys(parametreler)) {
    const p = parametreler[ad];
    if (p && typeof p === 'object' && !(p instanceof Date) && 'tip' in p) {
      istek.input(ad, p.tip, p.deger);
    } else {
      istek.input(ad, p);
    }
  }
  return istek;
}

// Parametreli sorgu. parametreler: { ad: deger } veya { ad: { tip, deger } }
async function sorgu(metin, parametreler) {
  const h = await havuzAl();
  const sonuc = await parametreEkle(h.request(), parametreler).query(metin);
  return sonuc.recordset || [];
}

async function calistir(metin, parametreler) {
  const h = await havuzAl();
  const sonuc = await parametreEkle(h.request(), parametreler).query(metin);
  return sonuc.rowsAffected || [];
}

// Birden fazla tabloya yazan işlemler için. Bir adım hata verirse hiçbir satır
// kalmaz; yarım belge oluşmaz.
//
//   await islem(async (t) => {
//     const r = await t.sorgu('INSERT ... OUTPUT INSERTED.IND AS ind ...', {...});
//     await t.calistir('INSERT ...', { ind: r[0].ind });
//   });
async function islem(isFn) {
  const h = await havuzAl();
  const gecis = new aktifSurucu.Transaction(h);
  await gecis.begin();

  const araclar = {
    sorgu: async (metin, p) =>
      (await parametreEkle(new aktifSurucu.Request(gecis), p).query(metin)).recordset || [],
    calistir: async (metin, p) =>
      (await parametreEkle(new aktifSurucu.Request(gecis), p).query(metin)).rowsAffected || []
  };

  let tamamlandi = false;
  try {
    const sonuc = await isFn(araclar);
    await gecis.commit();
    tamamlandi = true;
    return sonuc;
  } finally {
    if (!tamamlandi) {
      try { await gecis.rollback(); } catch (e) { /* zaten geri alınmışsa yoksay */ }
    }
  }
}

async function baglantiTesti() {
  const a = ayarOku();
  const satirlar = await sorgu('SELECT @@VERSION AS surum, DB_NAME() AS veritabani');
  return {
    tamam: true,
    sunucu: a.sunucu,
    veritabani: satirlar[0] ? satirlar[0].veritabani : a.vegaVeritabani,
    surum: satirlar[0] ? String(satirlar[0].surum).split('\n')[0] : ''
  };
}

module.exports = {
  mssql,
  sorgu,
  calistir,
  islem,
  havuzAl,
  havuzKapat,
  baglantiTesti
};
