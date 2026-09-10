'use strict';

// Geçmiş Hızlı Belge Doldurucu kayıtlarını üç kaynaktan karşılaştırır:
//   1) BD_BelgeSatir      -> haftalık raporun ayrıntı kaynağı
//   2) BD_KasaHareket     -> müşterideki açık kasa defteri
//   3) gerçek Vega belgesi -> fatura/cari giriş satırları
//
// Varsayılan çalışma salt okunurdur. --uygula yalnız iki kanıtlı ve güvenli
// düzeltmeyi yapar:
//   - BD_Islem'deki kayıt-anı / belge-tarihi karışıklığını düzeltir.
//   - Rapor satırı ile Vega aynıyken farklı kalan kasa defterini yeniden kurar.
// Vega ile rapor kaynağı birbiriyle çelişiyorsa veri uydurmaz; kaydı rapora
// yazar ve elle incelenmek üzere bırakır.

const fs = require('fs');
const os = require('os');
const path = require('path');

function argumanlariOku(argv) {
  const sonuc = { uygula: false, yardim: false, firma: null, fis: null, ayar: null, geriAl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uygula') sonuc.uygula = true;
    else if (a === '--yardim' || a === '-h') sonuc.yardim = true;
    else if (a === '--firma') sonuc.firma = argv[++i] || null;
    else if (a === '--fis') sonuc.fis = argv[++i] || null;
    else if (a === '--ayar') sonuc.ayar = argv[++i] || null;
    else if (a === '--geri-al') sonuc.geriAl = argv[++i] || null;
    else throw new Error(`Bilinmeyen seçenek: ${a}`);
  }
  return sonuc;
}

function kuruluAyarYolu() {
  const kok = process.env.APPDATA || '';
  const adaylar = [
    path.join(kok, 'hizli-belge-doldurucu', 'ayarlar.json'),
    path.join(kok, 'Hizli Belge Doldurucu', 'ayarlar.json')
  ];
  return adaylar.find((p) => fs.existsSync(p)) || null;
}

// Ayar yolu db modülleri yüklenmeden önce belirlenmeli; ayar.js yolu önbelleğe alır.
const cli = require.main === module ? argumanlariOku(process.argv.slice(2)) : null;
if (cli && cli.ayar) process.env.BELGE_AYAR_DOSYASI = path.resolve(cli.ayar);
if (cli && !process.env.BELGE_AYAR_DOSYASI) {
  const kurulu = kuruluAyarYolu();
  if (kurulu) process.env.BELGE_AYAR_DOSYASI = kurulu;
}

const sql = require('../db/sql');
const { ayarOku, ayarYolu } = require('../db/ayar');
const firmaDb = require('../db/firma');

const TOLERANS = 0.01;

function dbAdi(ad) {
  const s = String(ad || '');
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`Güvensiz veritabanı adı: ${s}`);
  return s;
}

function kod(ham) {
  return String(ham || '').trim().toLocaleUpperCase('tr-TR');
}

function sayi(ham) {
  return Number(ham) || 0;
}

function tarihAnahtari(ham) {
  if (!ham) return null;
  const d = ham instanceof Date ? ham : new Date(ham);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function gunFarkiVar(a, b) {
  return !!a && !!b && tarihAnahtari(a) !== tarihAnahtari(b);
}

function haritaOlustur(satirlar, alanlar) {
  const m = new Map();
  for (const s of satirlar) {
    const anahtar = kod(s[alanlar.kod]);
    const adet = sayi(s[alanlar.adet]);
    const tutar = sayi(s[alanlar.tutar]);
    if (!anahtar && !adet && !tutar) continue;
    const onceki = m.get(anahtar) || { kod: anahtar || '(KODSUZ)', adet: 0, tutar: 0 };
    onceki.adet += adet;
    onceki.tutar += tutar;
    m.set(anahtar, onceki);
  }
  return m;
}

function haritaToplam(m) {
  const sonuc = { adet: 0, tutar: 0 };
  for (const x of m.values()) {
    sonuc.adet += sayi(x.adet);
    sonuc.tutar += sayi(x.tutar);
  }
  return sonuc;
}

function yakin(a, b) {
  return Math.abs(sayi(a) - sayi(b)) <= TOLERANS;
}

function haritaEsit(a, b) {
  const anahtarlar = new Set([...a.keys(), ...b.keys()]);
  for (const k of anahtarlar) {
    const x = a.get(k) || {};
    const y = b.get(k) || {};
    if (!yakin(x.adet, y.adet) || !yakin(x.tutar, y.tutar)) return false;
  }
  return true;
}

function haritaListe(m) {
  return [...m.values()]
    .map((x) => ({ kod: x.kod, adet: sayi(x.adet), tutar: sayi(x.tutar) }))
    .sort((a, b) => a.kod.localeCompare(b.kod, 'tr'));
}

function jsonOku(ham) {
  try {
    const j = JSON.parse(ham || '[]');
    return Array.isArray(j) ? j : [];
  } catch (e) {
    return [];
  }
}

function baslikInd(grup, tabloAdi) {
  const satir = (grup && Array.isArray(grup.kayitlar) ? grup.kayitlar : [])
    .find((x) => x && x.tablo === tabloAdi && Number.isFinite(Number(x.ind)));
  return satir ? Number(satir.ind) : null;
}

async function eksikVegaBaglantilari(islem, yazilan) {
  const v = dbAdi(ayarOku().vegaVeritabani);
  await firmaDb.dogrula(islem.Firma, islem.Donem);
  const gruplar = new Map();
  for (const belge of yazilan) {
    for (const ref of (belge && Array.isArray(belge.kayitlar) ? belge.kayitlar : [])) {
      const tabloAdi = String(ref && ref.tablo || '');
      const ind = Number(ref && ref.ind);
      if (!/^TBL[A-Z0-9_]+$/.test(tabloAdi) || !Number.isFinite(ind)) continue;
      const anahtar = `${ref.donemli ? 'D' : 'K'}|${tabloAdi}`;
      if (!gruplar.has(anahtar)) gruplar.set(anahtar, { tabloAdi, donemli: !!ref.donemli, idler: new Set() });
      gruplar.get(anahtar).idler.add(ind);
    }
  }

  const eksikler = [];
  for (const g of gruplar.values()) {
    const idler = [...g.idler];
    if (!idler.length) continue;
    const tam = g.donemli
      ? firmaDb.tablo(v, islem.Firma, islem.Donem, g.tabloAdi)
      : firmaDb.kart(v, islem.Firma, g.tabloAdi);
    try {
      const bulunan = await sql.sorgu(`SELECT IND FROM ${tam} WHERE IND IN (${idler.join(',')})`);
      const mevcut = new Set(bulunan.map((x) => Number(x.IND)));
      for (const ind of idler) if (!mevcut.has(ind)) eksikler.push({ tablo: g.tabloAdi, ind });
    } catch (e) {
      for (const ind of idler) eksikler.push({ tablo: g.tabloAdi, ind, neden: e.message });
    }
  }
  return eksikler;
}

async function gercekVegaKasasi(islem, yazilan) {
  const a = ayarOku();
  const v = dbAdi(a.vegaVeritabani);
  await firmaDb.dogrula(islem.Firma, islem.Donem);

  const sonuc = { okunabildi: true, turler: new Map(), toplam: 0, kaynaklar: [] };
  const satis = yazilan.find((g) => g && g.tur === 'satisFaturasi');
  if (satis) {
    const ind = baslikInd(satis, 'TBLSATFATBASLIK');
    if (!ind) return { okunabildi: false, neden: 'Fatura başlık bağlantısı yok.', turler: new Map(), toplam: 0 };
    const baslik = firmaDb.tablo(v, islem.Firma, islem.Donem, 'TBLSATFATBASLIK');
    const hareket = firmaDb.tablo(v, islem.Firma, islem.Donem, 'TBLSATFATHAREKET');
    const r = await sql.sorgu(`
      SELECT B.IND AS BaslikInd,
             UPPER(LTRIM(RTRIM(COALESCE(NULLIF(H.STOKKODU, ''), CAST(H.MALINCINSI AS NVARCHAR(250)), '')))) AS Kod,
             SUM(ISNULL(H.MIKTAR, 0)) AS Adet,
             SUM(ISNULL(H.GERCEKTOPLAM, 0)) AS Tutar
      FROM ${baslik} B
      LEFT JOIN ${hareket} H ON H.EVRAKNO = B.IND
        AND UPPER(LTRIM(RTRIM(ISNULL(CAST(H.ACIKLAMA AS NVARCHAR(60)), '')))) = 'KASA'
      WHERE B.IND = @ind
      GROUP BY B.IND,
               UPPER(LTRIM(RTRIM(COALESCE(NULLIF(H.STOKKODU, ''), CAST(H.MALINCINSI AS NVARCHAR(250)), ''))))`,
      { ind }
    );
    if (!r.length) return { okunabildi: false, neden: 'Bağlı Vega faturası bulunamadı.', turler: new Map(), toplam: 0 };
    const kasaSatirlari = r.filter((x) => kod(x.Kod));
    sonuc.turler = haritaOlustur(kasaSatirlari, { kod: 'Kod', adet: 'Adet', tutar: 'Tutar' });
    sonuc.toplam += haritaToplam(sonuc.turler).tutar;
    sonuc.kaynaklar.push({ tur: 'fatura', ind, belgeNo: satis.belgeNo || null });
  }

  const cari = yazilan.find((g) => g && g.tur === 'cariCikis');
  if (cari) {
    const ind = baslikInd(cari, 'TBLCARGIRBASLIK') || baslikInd(cari, 'TBLCARCIKBASLIK');
    const baslikAdi = baslikInd(cari, 'TBLCARGIRBASLIK') ? 'TBLCARGIRBASLIK' : 'TBLCARCIKBASLIK';
    const hareketAdi = baslikAdi === 'TBLCARGIRBASLIK' ? 'TBLCARGIRHAREKET' : 'TBLCARCIKHAREKET';
    if (!ind) return { okunabildi: false, neden: 'Cari belge başlık bağlantısı yok.', turler: new Map(), toplam: 0 };
    const baslik = firmaDb.tablo(v, islem.Firma, islem.Donem, baslikAdi);
    const hareket = firmaDb.tablo(v, islem.Firma, islem.Donem, hareketAdi);
    const r = await sql.sorgu(`
      SELECT B.IND AS BaslikInd,
             SUM(CASE WHEN UPPER(LTRIM(RTRIM(ISNULL(CAST(H.ACIKLAMA AS NVARCHAR(250)), '')))) = 'KASA TUTARI'
                      THEN ISNULL(H.TUTAR, 0) ELSE 0 END) AS KasaTutari
      FROM ${baslik} B
      LEFT JOIN ${hareket} H ON H.EVRAKNO = B.IND
      WHERE B.IND = @ind
      GROUP BY B.IND`, { ind });
    if (!r.length) return { okunabildi: false, neden: 'Bağlı Vega cari belgesi bulunamadı.', turler: new Map(), toplam: 0 };
    sonuc.toplam += sayi(r[0].KasaTutari);
    sonuc.kaynaklar.push({ tur: 'cari', ind, belgeNo: cari.belgeNo || null });
  }

  // 24.08.2026 öncesi sürümler kasa tutarını ayrı cari çıkış belgesine yazardı.
  // Bu geçerli eski düzeni yeni faturadaki KASA satırı eksik sanmıyoruz.
  for (const eski of yazilan.filter((g) => g && g.tur === 'kasaDepozito')) {
    const hareketRef = (eski.kayitlar || []).find((x) =>
      x && (x.tablo === 'TBLCARCIKHAREKET' || x.tablo === 'TBLCARGIRHAREKET') && Number(x.ind)
    );
    if (!hareketRef) {
      return { okunabildi: false, neden: 'Eski kasa depozito satır bağlantısı yok.', turler: sonuc.turler, toplam: sonuc.toplam };
    }
    const tam = firmaDb.tablo(v, islem.Firma, islem.Donem, hareketRef.tablo);
    const r = await sql.sorgu(`SELECT TUTAR AS KasaTutari FROM ${tam} WHERE IND = @ind`,
      { ind: Number(hareketRef.ind) });
    if (!r.length) {
      return { okunabildi: false, neden: 'Eski kasa depozito Vega satırı bulunamadı.', turler: sonuc.turler, toplam: sonuc.toplam };
    }
    sonuc.toplam += sayi(r[0].KasaTutari);
    sonuc.kaynaklar.push({ tur: 'eski-kasa-belgesi', ind: Number(hareketRef.ind), belgeNo: eski.belgeNo || null });
  }

  if (!satis && !cari && !yazilan.some((g) => g && g.tur === 'kasaDepozito')) {
    return { okunabildi: false, neden: 'Desteklenen satış bağlantısı yok.', turler: new Map(), toplam: 0 };
  }
  return sonuc;
}

async function tara(secenek) {
  const a = ayarOku();
  const v = dbAdi(a.vegaVeritabani);
  const p = {};
  const filtre = ['ISNULL(I.GeriAlindi, 0) = 0', "I.Konu IN ('satisFaturasi', 'cariCikis', 'KasaIade')"];
  if (secenek && secenek.firma) {
    filtre.push('I.Firma = @firma');
    p.firma = secenek.firma;
  }
  if (secenek && secenek.fis) {
    filtre.push(`(I.Aciklama LIKE @fis OR I.BelgeNo LIKE @fis OR EXISTS (
      SELECT 1 FROM [${v}].dbo.BD_BelgeSatir X WHERE X.IslemId = I.Id AND X.FisNo LIKE @fis))`);
    p.fis = `%${secenek.fis}%`;
  }

  const islemler = await sql.sorgu(`
    SELECT I.Id, I.Tarih, I.Konu, I.Firma, I.Donem, I.CariInd, I.CariAd,
           I.BelgeNo, I.Tutar, I.Aciklama, I.Yazilan, I.Kullanici, I.Bilgisayar
    FROM [${v}].dbo.BD_Islem I
    WHERE ${filtre.join(' AND ')}
    ORDER BY I.Id`, p);
  if (!islemler.length) return { veritabani: v, belgeler: [], sorunlar: [], tarihDuzeltmeleri: [], kasaDuzeltmeleri: [] };

  const idler = islemler.map((x) => Number(x.Id)).filter(Number.isFinite).join(',');
  const satirlar = await sql.sorgu(`
    SELECT * FROM [${v}].dbo.BD_BelgeSatir
    WHERE ISNULL(GeriAlindi, 0) = 0 AND IslemId IN (${idler})
    ORDER BY IslemId, SiraNo, Id`);
  const kasalar = await sql.sorgu(`
    SELECT * FROM [${v}].dbo.BD_KasaHareket
    WHERE IslemId IN (${idler}) ORDER BY IslemId, Id`);
  const tipler = await sql.sorgu(`SELECT Id, Kod, Ad FROM [${v}].dbo.BD_KasaTipi WHERE ISNULL(Aktif, 1) = 1`);
  const tipHaritasi = new Map(tipler.map((x) => [kod(x.Kod), x]));
  const satirHaritasi = new Map();
  const kasaHaritasi = new Map();
  for (const s of satirlar) {
    if (!satirHaritasi.has(Number(s.IslemId))) satirHaritasi.set(Number(s.IslemId), []);
    satirHaritasi.get(Number(s.IslemId)).push(s);
  }
  for (const k of kasalar) {
    if (!kasaHaritasi.has(Number(k.IslemId))) kasaHaritasi.set(Number(k.IslemId), []);
    kasaHaritasi.get(Number(k.IslemId)).push(k);
  }

  const rapor = {
    veritabani: v,
    ayarDosyasi: ayarYolu(),
    taramaTarihi: new Date().toISOString(),
    belgeler: [], sorunlar: [], tarihDuzeltmeleri: [], kasaDuzeltmeleri: []
  };

  for (const islem of islemler) {
    const detay = satirHaritasi.get(Number(islem.Id)) || [];
    const kasaDefteri = kasaHaritasi.get(Number(islem.Id)) || [];
    const isTarihi = (detay[0] && detay[0].Tarih) || (kasaDefteri[0] && kasaDefteri[0].Tarih) || null;
    const belge = {
      islemId: Number(islem.Id), fisNo: islem.Aciklama || '', belgeNo: islem.BelgeNo || '',
      konu: islem.Konu, firma: islem.Firma, donem: islem.Donem, cariInd: Number(islem.CariInd),
      cariAd: islem.CariAd || '', kayitTarihi: tarihAnahtari(islem.Tarih), isTarihi: tarihAnahtari(isTarihi),
      durum: 'saglam', sorunlar: []
    };

    if (gunFarkiVar(islem.Tarih, isTarihi)) {
      const sorun = { tur: 'TARIH_KARISIKLIGI', guvenliDuzeltilebilir: true,
        aciklama: `Son Belgeler tarihi ${tarihAnahtari(islem.Tarih)}, iş tarihi ${tarihAnahtari(isTarihi)}.` };
      belge.sorunlar.push(sorun);
      rapor.sorunlar.push({ islemId: belge.islemId, ...sorun });
      rapor.tarihDuzeltmeleri.push({ islemId: belge.islemId, eskiTarih: islem.Tarih, yeniTarih: isTarihi });
    }

    const yazilan = jsonOku(islem.Yazilan);
    const eksikBaglar = await eksikVegaBaglantilari(islem, yazilan);
    if (eksikBaglar.length) {
      const ilkler = eksikBaglar.slice(0, 6).map((x) => `${x.tablo}#${x.ind}`).join(', ');
      const sorun = {
        tur: 'VEGA_BAGLI_KAYIT_EKSIK',
        guvenliDuzeltilebilir: false,
        aciklama: `Günlükte yazıldığı kayıtlı ${eksikBaglar.length} Vega satırı artık yok: ${ilkler}${eksikBaglar.length > 6 ? ', ...' : ''}.`
      };
      belge.sorunlar.push(sorun);
      belge.eksikVegaBaglantilari = eksikBaglar;
      rapor.sorunlar.push({ islemId: belge.islemId, ...sorun });
    }

    if (islem.Konu === 'satisFaturasi' || islem.Konu === 'cariCikis') {
      const beklenenSatirlar = detay.filter((s) => sayi(s.KasaAdedi) !== 0 || sayi(s.KasaTutari) !== 0);
      const beklenen = haritaOlustur(beklenenSatirlar,
        { kod: 'KasaTipiKod', adet: 'KasaAdedi', tutar: 'KasaTutari' });
      const defter = haritaOlustur(kasaDefteri.filter((k) => k.Yon === 'verilen'),
        { kod: 'StokKodu', adet: 'Adet', tutar: 'Tutar' });
      const vega = await gercekVegaKasasi(islem, yazilan);
      const beklenenToplam = haritaToplam(beklenen);
      const vegaEsit = vega.okunabildi && yakin(vega.toplam, beklenenToplam.tutar) &&
        (!vega.turler.size || haritaEsit(vega.turler, beklenen));
      const defterEsit = haritaEsit(defter, beklenen);

      belge.raporKasasi = haritaListe(beklenen);
      belge.kasaDefteri = haritaListe(defter);
      belge.vegaKasasi = { okunabildi: vega.okunabildi, neden: vega.neden || null,
        toplam: sayi(vega.toplam), turler: haritaListe(vega.turler), kaynaklar: vega.kaynaklar || [] };

      if (!vega.okunabildi) {
        // Kasa beklenmeyen yalnız-tahsilat/boş belgelerde desteklenen satış
        // bağlantısı olmaması bir veri hatası değildir.
        if (beklenenToplam.adet || beklenenToplam.tutar) {
          const sorun = { tur: 'VEGA_BAGLANTISI_OKUNAMADI', guvenliDuzeltilebilir: false, aciklama: vega.neden };
          belge.sorunlar.push(sorun); rapor.sorunlar.push({ islemId: belge.islemId, ...sorun });
        }
      } else if (!vegaEsit) {
        const sorun = { tur: 'VEGA_RAPOR_KASA_UYUSMAZLIGI', guvenliDuzeltilebilir: false,
          aciklama: `Rapor kaynağı ${beklenenToplam.adet} kasa/${beklenenToplam.tutar} TL, Vega ${vega.toplam} TL.` };
        belge.sorunlar.push(sorun); rapor.sorunlar.push({ islemId: belge.islemId, ...sorun });
      }

      if (!defterEsit) {
        const eksikTip = beklenenSatirlar.find((s) => !tipHaritasi.has(kod(s.KasaTipiKod)));
        const guvenli = vegaEsit && !eksikTip;
        const sorun = { tur: 'KASA_DEFTERI_UYUSMAZLIGI', guvenliDuzeltilebilir: guvenli,
          aciklama: guvenli
            ? 'Rapor satırı ile Vega aynı; kasa defteri bu iki kanıtlı kaynaktan yeniden kurulabilir.'
            : (eksikTip ? `Kasa tipi bulunamadı: ${eksikTip.KasaTipiKod || '(boş)'}.`
                        : 'Rapor, kasa defteri ve Vega kaynakları aynı sonucu vermiyor.') };
        belge.sorunlar.push(sorun); rapor.sorunlar.push({ islemId: belge.islemId, ...sorun });
        if (guvenli) {
          rapor.kasaDuzeltmeleri.push({
            islemId: belge.islemId,
            eskiSatirlar: kasaDefteri,
            yeniSatirlar: beklenenSatirlar.map((s) => {
              const tip = tipHaritasi.get(kod(s.KasaTipiKod));
              return {
                Firma: s.Firma, Donem: s.Donem, Tarih: s.Tarih,
                CariInd: Number(s.CariInd), CariAd: s.CariAd || islem.CariAd || null,
                StokNo: Number(tip.Id), StokKodu: s.KasaTipiKod || tip.Kod,
                StokAdi: tip.Ad || s.KasaTipiKod || tip.Kod,
                Adet: sayi(s.KasaAdedi), Depozito: sayi(s.KasaDepozito), Tutar: sayi(s.KasaTutari),
                Yon: 'verilen', IslemId: belge.islemId,
                Kullanici: islem.Kullanici || null, Bilgisayar: islem.Bilgisayar || null
              };
            })
          });
        }
      }
    }

    if (belge.sorunlar.length) belge.durum = belge.sorunlar.every((s) => s.guvenliDuzeltilebilir)
      ? 'guvenli-duzeltilebilir' : 'elle-inceleme';
    rapor.belgeler.push(belge);
  }

  return rapor;
}

function ciktiKlasoru(ozelHedef) {
  const kok = process.env.LOCALAPPDATA || os.tmpdir();
  const hedef = ozelHedef || path.join(kok, 'hizli-belge-doldurucu-bakim');
  fs.mkdirSync(hedef, { recursive: true });
  return hedef;
}

function dosyaDamgasi() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function jsonYaz(onEk, veri, ozelHedef) {
  const hedef = path.join(ciktiKlasoru(ozelHedef), `${onEk}-${dosyaDamgasi()}.json`);
  fs.writeFileSync(hedef, JSON.stringify(veri, null, 2), 'utf8');
  return hedef;
}

function durumOku(durumYolu) {
  try {
    const ham = fs.readFileSync(durumYolu, 'utf8').replace(/^\uFEFF/, '');
    const durum = JSON.parse(ham);
    if (durum && typeof durum === 'object' && durum.tamamlananlar) return durum;
  } catch (e) {
    // İlk çalışma veya yarım kalmış durum dosyası: idempotent bakım yeniden
    // taranır; doğrulama bitmeden hiçbir zaman tamamlandı sayılmaz.
  }
  return { surum: 1, tamamlananlar: {} };
}

function durumYaz(durumYolu, durum) {
  fs.mkdirSync(path.dirname(durumYolu), { recursive: true });
  fs.writeFileSync(durumYolu, JSON.stringify(durum, null, 2), 'utf8');
}

function otomatikBakimAnahtari(surum, ayar) {
  return [
    String(surum || 'bilinmeyen'),
    String(ayar.sunucu || 'localhost').trim().toLocaleLowerCase('tr-TR'),
    Number(ayar.port) || 1433,
    dbAdi(ayar.vegaVeritabani).toLocaleLowerCase('tr-TR')
  ].join('|');
}

function logYaz(log, seviye, mesaj) {
  try {
    if (log && typeof log[seviye] === 'function') log[seviye](mesaj);
  } catch (e) {
    // Bakımın sonucu günlükleme arızası yüzünden değişmemeli.
  }
}

/**
 * Paketli uygulama güncellemeden sonra ilk açıldığında çağrılır. Tamamlanma
 * anahtarı uygulama sürümü + sunucu + veritabanıdır; hata olursa anahtar
 * yazılmaz ve sonraki açılışta güvenle tekrar denenir.
 */
async function otomatikCalistir(secenek) {
  const o = secenek || {};
  const a = ayarOku();
  const surum = String(o.surum || 'bilinmeyen');
  const durumYolu = o.durumYolu || path.join(path.dirname(ayarYolu()), 'gecmis-belge-bakim-durumu.json');
  const anahtar = otomatikBakimAnahtari(surum, a);
  const durum = durumOku(durumYolu);
  if (durum.tamamlananlar[anahtar]) {
    logYaz(o.log, 'info', `[gecmis-bakim] Daha önce tamamlandı: ${anahtar}`);
    return { atlandi: true, neden: 'daha-once-tamamlandi', kayit: durum.tamamlananlar[anahtar] };
  }

  logYaz(o.log, 'info', `[gecmis-bakim] Tarama başladı: ${anahtar}`);
  await sql.baglantiTesti();
  // Eski müşteride yardımcı tabloların eksik/erken bir sürümü bulunabilir.
  // Normal uygulama açılışıyla aynı uyumlu şema hazırlığını önce tamamla.
  const yardimci = require('../db/yardimci');
  await yardimci.hazirla();

  const rapor = await tara({});
  const raporYolu = jsonYaz('otomatik-tarama', rapor, o.ciktiKlasoru);
  const yedek = {
    surum: 1,
    uygulamaSurumu: surum,
    veritabani: rapor.veritabani,
    olusturmaTarihi: new Date().toISOString(),
    tarihDuzeltmeleri: rapor.tarihDuzeltmeleri,
    kasaDuzeltmeleri: rapor.kasaDuzeltmeleri
  };
  // Boş olsa bile yedek tarama kanıtıdır; olası tüm yazmalardan önce diske iner.
  const yedekYolu = jsonYaz('otomatik-geri-alma-yedegi', yedek, o.ciktiKlasoru);
  const sonuc = await guvenliDuzelt(rapor);

  const dogrulama = await tara({});
  const dogrulamaYolu = jsonYaz('otomatik-dogrulama', dogrulama, o.ciktiKlasoru);
  const kalanGuvenli = dogrulama.sorunlar.filter((s) => s.guvenliDuzeltilebilir).length;
  if (kalanGuvenli) {
    throw new Error(`${kalanGuvenli} güvenli düzeltme doğrulama sonrasında hâlâ açık.`);
  }

  const elleInceleme = dogrulama.belgeler.filter((b) => b.durum === 'elle-inceleme').length;
  const kayit = {
    tamamlanmaTarihi: new Date().toISOString(),
    uygulamaSurumu: surum,
    sunucu: String(a.sunucu || 'localhost'),
    port: Number(a.port) || 1433,
    veritabani: rapor.veritabani,
    duzeltilenTarih: sonuc.tarih,
    duzeltilenKasaDefteri: sonuc.kasaDefteri,
    elleInceleme,
    raporYolu,
    yedekYolu,
    dogrulamaYolu
  };
  durum.tamamlananlar[anahtar] = kayit;
  durumYaz(durumYolu, durum);
  logYaz(o.log, 'info',
    `[gecmis-bakim] Tamamlandı: ${sonuc.tarih} tarih, ${sonuc.kasaDefteri} kasa defteri; ${elleInceleme} elle inceleme.`);
  return { atlandi: false, ...kayit };
}

async function guvenliDuzelt(rapor) {
  const v = dbAdi(rapor.veritabani);
  return sql.islem(async (t) => {
    for (const d of rapor.tarihDuzeltmeleri) {
      await t.calistir(`UPDATE [${v}].dbo.BD_Islem SET Tarih = @tarih WHERE Id = @id`,
        { tarih: new Date(d.yeniTarih), id: Number(d.islemId) });
    }
    for (const d of rapor.kasaDuzeltmeleri) {
      await t.calistir(`DELETE FROM [${v}].dbo.BD_KasaHareket WHERE IslemId = @id`,
        { id: Number(d.islemId) });
      for (const s of d.yeniSatirlar) {
        await t.calistir(`
          INSERT INTO [${v}].dbo.BD_KasaHareket
            (Firma, Donem, Tarih, CariInd, CariAd, StokNo, StokKodu, StokAdi,
             Adet, Depozito, Tutar, Yon, IslemId, Kullanici, Bilgisayar)
          VALUES
            (@Firma, @Donem, @Tarih, @CariInd, @CariAd, @StokNo, @StokKodu, @StokAdi,
             @Adet, @Depozito, @Tutar, @Yon, @IslemId, @Kullanici, @Bilgisayar)`, s);
      }
    }
    return { tarih: rapor.tarihDuzeltmeleri.length, kasaDefteri: rapor.kasaDuzeltmeleri.length };
  });
}

async function geriAl(yedek) {
  const a = ayarOku();
  const v = dbAdi(a.vegaVeritabani);
  if (v !== yedek.veritabani) {
    throw new Error(`Yedek ${yedek.veritabani} için; bağlı veritabanı ${v}. Geri alma durduruldu.`);
  }
  return sql.islem(async (t) => {
    for (const d of yedek.tarihDuzeltmeleri || []) {
      await t.calistir(`UPDATE [${v}].dbo.BD_Islem SET Tarih = @tarih WHERE Id = @id`,
        { tarih: new Date(d.eskiTarih), id: Number(d.islemId) });
    }
    for (const d of yedek.kasaDuzeltmeleri || []) {
      await t.calistir(`DELETE FROM [${v}].dbo.BD_KasaHareket WHERE IslemId = @id`,
        { id: Number(d.islemId) });
      if (!d.eskiSatirlar || !d.eskiSatirlar.length) continue;
      for (const s of d.eskiSatirlar) {
        // IDENTITY_INSERT oturum kapsamlıdır; mssql her Request için ayrı
        // yürütme bağlamı kullanabildiğinden ON/INSERT/OFF tek batch olmalı.
        await t.calistir(`
          BEGIN TRY
            SET IDENTITY_INSERT [${v}].dbo.BD_KasaHareket ON;
            INSERT INTO [${v}].dbo.BD_KasaHareket
              (Id, Firma, Donem, Tarih, CariInd, CariAd, StokNo, StokKodu, StokAdi,
               Adet, Depozito, Tutar, Yon, IslemId, Kullanici, Bilgisayar, OlusturmaTarihi)
            VALUES
              (@Id, @Firma, @Donem, @Tarih, @CariInd, @CariAd, @StokNo, @StokKodu, @StokAdi,
               @Adet, @Depozito, @Tutar, @Yon, @IslemId, @Kullanici, @Bilgisayar, @OlusturmaTarihi);
            SET IDENTITY_INSERT [${v}].dbo.BD_KasaHareket OFF;
          END TRY
          BEGIN CATCH
            BEGIN TRY
              SET IDENTITY_INSERT [${v}].dbo.BD_KasaHareket OFF;
            END TRY
            BEGIN CATCH
            END CATCH;
            THROW;
          END CATCH`, s);
      }
    }
    return { tarih: (yedek.tarihDuzeltmeleri || []).length, kasaDefteri: (yedek.kasaDuzeltmeleri || []).length };
  });
}

function ozetYaz(rapor) {
  const elle = rapor.belgeler.filter((b) => b.durum === 'elle-inceleme').length;
  console.log(`Veritabanı: ${rapor.veritabani}`);
  console.log(`Taranan belge: ${rapor.belgeler.length}`);
  console.log(`Sorun: ${rapor.sorunlar.length}`);
  console.log(`Güvenli tarih düzeltmesi: ${rapor.tarihDuzeltmeleri.length}`);
  console.log(`Güvenli kasa defteri düzeltmesi: ${rapor.kasaDuzeltmeleri.length}`);
  console.log(`Elle incelenecek belge: ${elle}`);
  for (const b of rapor.belgeler.filter((x) => x.sorunlar.length)) {
    console.log(`  #${b.islemId} ${b.fisNo || b.belgeNo || ''} ${b.cariAd}`);
    for (const s of b.sorunlar) console.log(`    - ${s.tur}: ${s.aciklama}`);
  }
}

async function ana() {
  if (cli.yardim) {
    console.log([
      'Kullanım:',
      '  node kurulum/gecmis-belgeleri-duzelt.js [--ayar DOSYA] [--firma F0102] [--fis 00751]',
      '  node kurulum/gecmis-belgeleri-duzelt.js [filtreler] --uygula',
      '  node kurulum/gecmis-belgeleri-duzelt.js [--ayar DOSYA] --geri-al YEDEK.json',
      '',
      'Varsayılan tarama salt okunurdur. --uygula öncesi otomatik JSON yedeği alınır.'
    ].join('\n'));
    return;
  }
  if (!process.env.BELGE_AYAR_DOSYASI && !fs.existsSync(ayarYolu())) {
    throw new Error('Ayar dosyası bulunamadı. --ayar ile kurulu uygulamanın ayarlar.json dosyasını verin.');
  }
  await sql.baglantiTesti();

  if (cli.geriAl) {
    const yedek = JSON.parse(fs.readFileSync(path.resolve(cli.geriAl), 'utf8'));
    const sonuc = await geriAl(yedek);
    console.log(`Geri alındı: ${sonuc.tarih} tarih, ${sonuc.kasaDefteri} kasa defteri.`);
    return;
  }

  const rapor = await tara({ firma: cli.firma, fis: cli.fis });
  ozetYaz(rapor);
  const raporYolu = jsonYaz('tarama', rapor);
  console.log(`Tarama raporu: ${raporYolu}`);

  if (!cli.uygula) {
    console.log('Veri değiştirilmedi. Güvenli düzeltmeleri uygulamak için aynı komuta --uygula ekleyin.');
    return;
  }

  const yedek = {
    surum: 1, veritabani: rapor.veritabani, olusturmaTarihi: new Date().toISOString(),
    tarihDuzeltmeleri: rapor.tarihDuzeltmeleri,
    kasaDuzeltmeleri: rapor.kasaDuzeltmeleri
  };
  const yedekYolu = jsonYaz('geri-alma-yedegi', yedek);
  const sonuc = await guvenliDuzelt(rapor);
  console.log(`Uygulandı: ${sonuc.tarih} tarih, ${sonuc.kasaDefteri} kasa defteri.`);
  console.log(`Geri alma yedeği: ${yedekYolu}`);

  const dogrulama = await tara({ firma: cli.firma, fis: cli.fis });
  const kalanGuvenli = dogrulama.sorunlar.filter((s) => s.guvenliDuzeltilebilir).length;
  console.log(`Son doğrulama: ${dogrulama.sorunlar.length} sorun, ${kalanGuvenli} uygulanabilir sorun kaldı.`);
  const dogrulamaYolu = jsonYaz('dogrulama', dogrulama);
  console.log(`Doğrulama raporu: ${dogrulamaYolu}`);
  if (kalanGuvenli) throw new Error('Güvenli düzeltmelerin tümü kapanmadı; geri alma yedeğini koruyun.');
}

if (require.main === module) {
  ana().catch((e) => {
    console.error(`Bakım aracı durdu: ${e.message}`);
    process.exitCode = 1;
  }).finally(() => sql.havuzKapat());
}

module.exports = {
  tara,
  guvenliDuzelt,
  geriAl,
  otomatikCalistir,
  _test: { tarihAnahtari, haritaOlustur, haritaToplam, haritaEsit, otomatikBakimAnahtari, durumOku }
};
