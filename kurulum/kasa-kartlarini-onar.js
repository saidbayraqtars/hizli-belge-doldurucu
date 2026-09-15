'use strict';

// Yalnız BD_Islem.Yazilan ile tek tek kanıtlanan kasa satırlarını onarır.
// Varsayılan tarama salt okunurdur. --uygula önce programdan açılıp Vega'ya
// işlenmemiş kasa tiplerinin kartlarını açar, sonra yedek alır ve tek
// transaction'da yerinde UPDATE yapar; --geri-al aynı satırları önceki
// değerine döndürür (açılan kartlar silinmez). Paketli uygulama güncellemeden
// sonra aynı işi otomatikCalistir ile bir kez yapar (main.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

function secenekleriOku(argv) {
  const o = { uygula: false, firma: null, fis: null, ayar: null, geriAl: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--uygula') o.uygula = true;
    else if (argv[i] === '--firma') o.firma = argv[++i];
    else if (argv[i] === '--fis') o.fis = argv[++i];
    else if (argv[i] === '--ayar') o.ayar = argv[++i];
    else if (argv[i] === '--geri-al') o.geriAl = argv[++i];
    else throw new Error(`Bilinmeyen seçenek: ${argv[i]}`);
  }
  if (o.uygula && o.geriAl) throw new Error('--uygula ve --geri-al birlikte kullanılamaz.');
  return o;
}

const cli = require.main === module ? secenekleriOku(process.argv.slice(2)) : null;
if (cli && cli.ayar) process.env.BELGE_AYAR_DOSYASI = path.resolve(cli.ayar);
if (cli && !process.env.BELGE_AYAR_DOSYASI) {
  const kurulu = path.join(process.env.APPDATA || '', 'hizli-belge-doldurucu', 'ayarlar.json');
  if (fs.existsSync(kurulu)) process.env.BELGE_AYAR_DOSYASI = kurulu;
}

const sql = require('../db/sql');
const { ayarOku } = require('../db/ayar');
const firmaDb = require('../db/firma');
const kasa = require('../db/kasa');

function veritabani() {
  const v = String(ayarOku().vegaVeritabani || '');
  if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error('Geçersiz veritabanı adı.');
  return v;
}
function kod(s) { return String(s || '').trim().toLocaleUpperCase('tr-TR'); }
function refler(grup, ad) {
  return (Array.isArray(grup.kayitlar) ? grup.kayitlar : [])
    .filter((x) => x && x.tablo === ad && x.donemli === true &&
      Number.isSafeInteger(Number(x.ind)) && Number(x.ind) > 0)
    .map((x) => Number(x.ind));
}
function ayni(a, b) {
  return a == null || b == null ? a == null && b == null : Number(a) === Number(b);
}
function tablo(v, f, d, ad) { return firmaDb.tablo(v, f, d, ad); }

async function kartHaritasi(v, firma) {
  const stok = firmaDb.kart(v, firma, 'TBLSTOKLAR');
  const birim = firmaDb.kart(v, firma, 'TBLBIRIMLEREX');
  const kolon = await sql.sorgu(`SELECT name FROM [${v}].sys.columns
    WHERE object_id = OBJECT_ID(@tablo) AND name = 'DELETED'`, { tablo: stok });
  const aktif = kolon.length ? 'AND ISNULL(S.DELETED, 0) = 0' : '';
  const tipler = await sql.sorgu(`SELECT Id, Kod FROM [${v}].dbo.BD_KasaTipi`);
  const kartlar = await sql.sorgu(`SELECT S.IND AS stokNo, S.STOKKODU AS kod,
      ISNULL(S.STOKTIPI,0) AS stokTipi, B.IND AS birimEx
    FROM ${stok} S LEFT JOIN ${birim} B ON B.STOKNO=S.IND AND B.VARSAYILAN=1
    WHERE UPPER(LTRIM(RTRIM(ISNULL(S.KOD1,''))))='KASA' ${aktif}`);
  const tipMap = new Map(tipler.map((x) => [kod(x.Kod), x]));
  const kartMap = new Map();
  for (const k of kartlar) {
    const key = kod(k.kod);
    if (!kartMap.has(key)) kartMap.set(key, []);
    kartMap.get(key).push(k);
  }
  return { tipMap, kartMap };
}

async function kasaSatiri(oku, v, firma, donem, tur, baslikInd, satirInd, kilitle = false) {
  const satis = tur === 'satisFaturasi';
  const hareket = tablo(v, firma, donem, satis ? 'TBLSATFATHAREKET' : 'TBLSTKGIRHAREKET');
  const stok = tablo(v, firma, donem, 'TBLSTOKHAREKETLERI');
  const envanter = tablo(v, firma, donem, 'TBLDEPOENVANTER');
  return oku(`SELECT H.IND AS hInd, H.EVRAKNO AS hBaslik, H.ACIKLAMA AS aciklama,
      H.STOKKODU AS kod, H.STOKNO AS hStok, H.BIRIMEX AS hBirim,
      H.STOKTIPI AS hTip, S.IND AS sInd, S.LN AS sLn, S.BELGENO AS sBaslik,
      S.STOKNO AS sStok, S.BIRIMEX AS sBirim,
      E.IND AS eInd, E.HAREKETIND AS eHareket, E.BELGEIND AS eBaslik,
      E.STOKNO AS eStok
    FROM ${hareket} H ${kilitle ? 'WITH (UPDLOCK,HOLDLOCK)' : ''}
    LEFT JOIN ${stok} S ${kilitle ? 'WITH (UPDLOCK,HOLDLOCK)' : ''}
      ON S.LN=H.IND AND S.BELGENO=@baslikInd AND S.IZAHAT=@tip
    LEFT JOIN ${envanter} E ${kilitle ? 'WITH (UPDLOCK,HOLDLOCK)' : ''}
      ON E.HAREKETIND=H.IND AND E.BELGEIND=@baslikInd AND E.BELGETIPI=@tip
    WHERE H.IND=@satirInd AND H.EVRAKNO=@baslikInd`,
  { baslikInd, satirInd, tip: satis ? 21 : 34 });
}

async function tara(o = {}) {
  const v = veritabani();
  const p = {};
  const filtre = ["ISNULL(I.GeriAlindi,0)=0", "I.Konu IN ('satisFaturasi','KasaIade')"];
  if (o.firma) { filtre.push('I.Firma=@firma'); p.firma = o.firma; }
  if (o.fis) {
    filtre.push(`(I.Aciklama=@fisAciklama OR EXISTS (
      SELECT 1 FROM [${v}].dbo.BD_BelgeSatir X
      WHERE X.IslemId=I.Id AND X.FisNo=@fis))`);
    p.fis = String(o.fis); p.fisAciklama = `Fiş ${o.fis}`;
  }
  const islemler = await sql.sorgu(`SELECT I.Id,I.Konu,I.Firma,I.Donem,I.Yazilan
    FROM [${v}].dbo.BD_Islem I WHERE ${filtre.join(' AND ')} ORDER BY I.Id`, p);
  const rapor = { veritabani: v, taramaTarihi: new Date().toISOString(),
    islemSayisi: islemler.length, kasaSatiriSayisi: 0, duzeltmeler: [],
    kartBekleyen: [], riskli: [], zatenDogru: 0 };
  const kartCache = new Map();
  for (const islem of islemler) {
    if (!islem.Firma || !islem.Donem) { rapor.riskli.push({ islemId: islem.Id, neden: 'Firma/dönem eksik.' }); continue; }
    await firmaDb.dogrula(islem.Firma, islem.Donem);
    if (!kartCache.has(islem.Firma)) kartCache.set(islem.Firma, await kartHaritasi(v, islem.Firma));
    const { tipMap, kartMap } = kartCache.get(islem.Firma);
    let gruplar;
    try { gruplar = JSON.parse(islem.Yazilan || '[]'); }
    catch (e) { gruplar = null; }
    if (!Array.isArray(gruplar)) { rapor.riskli.push({ islemId: islem.Id, neden: 'Yazilan JSON bozuk.' }); continue; }
    const tur = islem.Konu === 'KasaIade' ? 'kasaIade' : 'satisFaturasi';
    const baslikAdi = tur === 'kasaIade' ? 'TBLSTKGIRBASLIK' : 'TBLSATFATBASLIK';
    const hareketAdi = tur === 'kasaIade' ? 'TBLSTKGIRHAREKET' : 'TBLSATFATHAREKET';
    for (const grup of gruplar.filter((g) => g && g.tur === tur)) {
      const basliklar = refler(grup, baslikAdi);
      const satirlar = refler(grup, hareketAdi);
      if (basliklar.length !== 1 || !satirlar.length) {
        rapor.riskli.push({ islemId: islem.Id, neden: 'Günlükte tek başlık ve satır bağlantısı yok.' }); continue;
      }
      const baslikInd = basliklar[0];
      const baslik = await sql.sorgu(`SELECT IND,ALTNOT FROM ${tablo(v,islem.Firma,islem.Donem,baslikAdi)}
        WHERE IND=@ind`, { ind: baslikInd });
      const imza = tur === 'kasaIade' ? 'KASA IADE' : 'Hizli Belge Doldurucu';
      if (baslik.length !== 1 || !String(baslik[0].ALTNOT || '').startsWith(imza)) {
        rapor.riskli.push({ islemId: islem.Id, baslikInd, neden: 'Program başlık imzası doğrulanamadı.' }); continue;
      }
      const stokRef = new Set(refler(grup, 'TBLSTOKHAREKETLERI'));
      const envRef = new Set(refler(grup, 'TBLDEPOENVANTER'));
      for (const satirInd of satirlar) {
        const r = await kasaSatiri(sql.sorgu, v, islem.Firma, islem.Donem, tur, baslikInd, satirInd);
        if (!r.length) { rapor.riskli.push({ islemId: islem.Id, satirInd, neden: 'Günlük satırı Vega’da yok.' }); continue; }
        if (tur === 'satisFaturasi' && kod(r[0].aciklama) !== 'KASA') continue;
        rapor.kasaSatiriSayisi++;
        const s = r[0];
        if (r.length !== 1 || !s.sInd || !s.eInd || !stokRef.has(Number(s.sInd)) ||
            !envRef.has(Number(s.eInd)) || !ayni(s.hStok,s.sStok) || !ayni(s.hStok,s.eStok)) {
          rapor.riskli.push({ islemId: islem.Id, satirInd, neden: 'LN/HAREKETIND veya stok bağlantısı tutarsız.' }); continue;
        }
        const key = kod(s.kod), tip = tipMap.get(key), kartlar = kartMap.get(key) || [];
        if (!key || !tip) { rapor.riskli.push({ islemId: islem.Id, satirInd, neden: `Kasa tipi kodu doğrulanamadı: ${key}.` }); continue; }
        if (!kartlar.length) { rapor.kartBekleyen.push({ islemId: islem.Id, satirInd, kod: key }); continue; }
        if (kartlar.length !== 1 || !kartlar[0].birimEx) {
          rapor.riskli.push({ islemId: islem.Id, satirInd, neden: `${key}: birden çok kart/birim veya varsayılan birim yok.` }); continue;
        }
        const hedef = kartlar[0];
        const eski = { hStok:s.hStok, hBirim:s.hBirim, hTip:s.hTip,
          sStok:s.sStok, sBirim:s.sBirim, eStok:s.eStok };
        const yeni = { hStok:hedef.stokNo, hBirim:hedef.birimEx, hTip:hedef.stokTipi,
          sStok:hedef.stokNo, sBirim:hedef.birimEx, eStok:hedef.stokNo };
        if (Object.keys(yeni).every((k) => ayni(eski[k],yeni[k]))) { rapor.zatenDogru++; continue; }
        rapor.duzeltmeler.push({ islemId:Number(islem.Id), firma:islem.Firma, donem:islem.Donem,
          tur, baslikInd, satirInd, stokInd:Number(s.sInd), envanterInd:Number(s.eInd),
          kod:key, eski, yeni });
      }
    }
  }
  return rapor;
}

async function satirlariGuncelle(t, v, e, once, sonra) {
  const hAdi = e.tur === 'kasaIade' ? 'TBLSTKGIRHAREKET' : 'TBLSATFATHAREKET';
  const baslikAdi = e.tur === 'kasaIade' ? 'TBLSTKGIRBASLIK' : 'TBLSATFATBASLIK';
  const h = tablo(v,e.firma,e.donem,hAdi);
  const s = tablo(v,e.firma,e.donem,'TBLSTOKHAREKETLERI');
  const env = tablo(v,e.firma,e.donem,'TBLDEPOENVANTER');
  const islem = await t.sorgu(`SELECT Yazilan,GeriAlindi,Firma,Donem FROM [${v}].dbo.BD_Islem WITH (UPDLOCK,HOLDLOCK)
    WHERE Id=@id`, { id:e.islemId });
  if (islem.length!==1 || islem[0].GeriAlindi || islem[0].Firma!==e.firma || islem[0].Donem!==e.donem) {
    throw new Error(`İşlem bağlantısı değişmiş: ${e.islemId}`);
  }
  const gruplar = JSON.parse(islem[0].Yazilan || '[]');
  const grup = gruplar.find((g) => g && g.tur===e.tur &&
    refler(g,baslikAdi).includes(e.baslikInd) && refler(g,hAdi).includes(e.satirInd) &&
    refler(g,'TBLSTOKHAREKETLERI').includes(e.stokInd) &&
    refler(g,'TBLDEPOENVANTER').includes(e.envanterInd));
  if (!grup) throw new Error(`Günlükte satır bağlantısı değişmiş: ${e.satirInd}`);
  const baslik = await t.sorgu(`SELECT ALTNOT FROM ${tablo(v,e.firma,e.donem,baslikAdi)}
    WITH (UPDLOCK,HOLDLOCK) WHERE IND=@id`, { id:e.baslikInd });
  const imza = e.tur==='kasaIade' ? 'KASA IADE' : 'Hizli Belge Doldurucu';
  if (baslik.length!==1 || !String(baslik[0].ALTNOT || '').startsWith(imza)) {
    throw new Error(`Program başlık imzası değişmiş: ${e.baslikInd}`);
  }
  const r = await kasaSatiri(t.sorgu, v,e.firma,e.donem,e.tur,e.baslikInd,e.satirInd,true);
  if (r.length!==1 || Number(r[0].sInd)!==e.stokInd || Number(r[0].eInd)!==e.envanterInd ||
      kod(r[0].kod)!==e.kod || (e.tur==='satisFaturasi' && kod(r[0].aciklama)!=='KASA') ||
      !Object.keys(once).every((k) => ayni(r[0][k],once[k]))) {
    throw new Error(`Vega satırı yedekten sonra değişmiş: ${e.firma}/${e.satirInd}`);
  }
  if (sonra===e.yeni) {
    const stokTablosu = firmaDb.kart(v,e.firma,'TBLSTOKLAR');
    const birimTablosu = firmaDb.kart(v,e.firma,'TBLBIRIMLEREX');
    const silinmisKolonu = await t.sorgu(`SELECT name FROM [${v}].sys.columns
      WHERE object_id=OBJECT_ID(@tablo) AND name='DELETED'`, { tablo:stokTablosu });
    const aktif = silinmisKolonu.length ? 'AND ISNULL(S.DELETED,0)=0' : '';
    const hedef = await t.sorgu(`SELECT S.IND,B.IND AS BirimEx,ISNULL(S.STOKTIPI,0) AS STOKTIPI
      FROM ${stokTablosu} S WITH (UPDLOCK,HOLDLOCK)
      JOIN ${birimTablosu} B WITH (UPDLOCK,HOLDLOCK) ON B.STOKNO=S.IND AND B.VARSAYILAN=1
      WHERE S.IND=@stok AND S.STOKKODU=@kod AND S.KOD1='KASA' ${aktif}`,
    { stok:e.yeni.hStok, kod:e.kod });
    if (hedef.length!==1 || !ayni(hedef[0].BirimEx,e.yeni.hBirim) ||
        !ayni(hedef[0].STOKTIPI,e.yeni.hTip)) {
      throw new Error(`Hedef Vega kartı/birimi değişmiş: ${e.kod}`);
    }
  }
  const p = { hi:e.satirInd, si:e.stokInd, ei:e.envanterInd,
    stok:sonra.hStok, birim:sonra.hBirim, tip:sonra.hTip };
  const sayilar = [
    await t.calistir(`UPDATE ${h} SET STOKNO=@stok,BIRIMEX=@birim,STOKTIPI=@tip WHERE IND=@hi`,p),
    await t.calistir(`UPDATE ${s} SET STOKNO=@stok,BIRIMEX=@birim WHERE IND=@si AND LN=@hi`,p),
    await t.calistir(`UPDATE ${env} SET STOKNO=@stok WHERE IND=@ei AND HAREKETIND=@hi`,p)
  ];
  if (sayilar.some((x) => x[0]!==1)) throw new Error(`Bağlı satır güncellenemedi: ${e.satirInd}`);
  const kontrol = await kasaSatiri(t.sorgu,v,e.firma,e.donem,e.tur,e.baslikInd,e.satirInd);
  if (kontrol.length!==1 || !Object.keys(sonra).every((k) => ayni(kontrol[0][k],sonra[k]))) {
    throw new Error(`Güncelleme doğrulanamadı: ${e.satirInd}`);
  }
}

function dosyaYaz(onek, icerik) {
  const dizin = path.join(process.env.LOCALAPPDATA || os.tmpdir(),'hizli-belge-doldurucu-bakim');
  fs.mkdirSync(dizin,{recursive:true});
  const dosya = path.join(dizin,`kasa-karti-${onek}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.writeFileSync(dosya,JSON.stringify(icerik,null,2),{flag:'wx',mode:0o600});
  return dosya;
}
async function uygula(rapor) {
  if (rapor.veritabani!==veritabani()) throw new Error('Tarama başka veritabanına ait.');
  // Kartı eksik veya bağlantısı tutarsız kayıtları atla; yalnız üç bağlı
  // satırı ve hedef kartı kanıtlanmış kayıtlar yedeğe/transaction'a girer.
  if (!rapor.duzeltmeler.length) return { yedek:null, adet:0,
    kartBekleyen:rapor.kartBekleyen.length, riskli:rapor.riskli.length };
  const yedek = dosyaYaz('yedek', { surum:1, veritabani:rapor.veritabani,
    olusturmaTarihi:new Date().toISOString(), duzeltmeler:rapor.duzeltmeler });
  await sql.islem(async (t) => {
    for (const e of rapor.duzeltmeler) await satirlariGuncelle(t,rapor.veritabani,e,e.eski,e.yeni);
  });
  return { yedek, adet:rapor.duzeltmeler.length,
    kartBekleyen:rapor.kartBekleyen.length, riskli:rapor.riskli.length };
}
async function geriAl(yedek) {
  if (yedek.surum!==1 || yedek.veritabani!==veritabani() || !Array.isArray(yedek.duzeltmeler)) {
    throw new Error('Yedek sürümü veya veritabanı eşleşmiyor.');
  }
  await sql.islem(async (t) => {
    for (const e of yedek.duzeltmeler) await satirlariGuncelle(t,yedek.veritabani,e,e.yeni,e.eski);
  });
  return yedek.duzeltmeler.length;
}

// --- Eksik Vega kasa kartları -------------------------------------------------
//
// 15.09.2026'ya kadar programdan eklenen kasa tipleri yalnız BD_KasaTipi'ye
// yazılıyordu (müşteride MPK, MUP, S.MUZ, KAYIK, XSMUZ, MSK, İNCİR). Programın
// yazdığı her firmada, aktif ya da o firmada kullanılmış tipin kartı yoksa
// VegaWin'in kendi kasa kartı deseniyle açılır (db/kasa.js). Kod başka bir
// kartta duruyorsa (KASA işaretsiz ürün, silinmiş kart) dokunulmaz ve
// "engelli" olarak raporlanır; ürün kartı kasaya çevrilmez.
async function eksikKartlariTara(o = {}) {
  const v = veritabani();
  const p = {};
  if (o.firma) p.firma = o.firma;
  const firmalar = await sql.sorgu(`SELECT Firma, MAX(Donem) AS Donem FROM (
      SELECT Firma, Donem FROM [${v}].dbo.BD_Islem
      UNION ALL SELECT Firma, Donem FROM [${v}].dbo.BD_KasaHareket
      UNION ALL SELECT Firma, Donem FROM [${v}].dbo.BD_BelgeSatir) X
    WHERE ISNULL(Firma,'')<>'' ${o.firma ? 'AND Firma=@firma' : ''}
    GROUP BY Firma ORDER BY Firma`, p);
  if (o.firma && !firmalar.length) firmalar.push({ Firma: o.firma, Donem: null });
  const rapor = { veritabani: v, taramaTarihi: new Date().toISOString(),
    firmalar: [], acilacak: [], engelli: [] };
  for (const f of firmalar) {
    let firma;
    try { ({ firma } = await firmaDb.dogrula(f.Firma, f.Donem || undefined)); }
    catch (e) { rapor.engelli.push({ firma: f.Firma, neden: e.message }); continue; }
    rapor.firmalar.push(firma);
    const kullanilan = new Set((await sql.sorgu(`
      SELECT KasaTipiKod AS kod FROM [${v}].dbo.BD_BelgeSatir
      WHERE Firma=@firma AND ISNULL(KasaAdedi,0)<>0
      UNION SELECT StokKodu FROM [${v}].dbo.BD_KasaHareket WHERE Firma=@firma`,
    { firma })).map((x) => kod(x.kod)));
    for (const e of await kasa.kasaTipiEslesmeleri(firma)) {
      if (e.durum === 'hazir') continue;
      const kullanildi = kullanilan.has(kod(e.kod));
      if (!e.aktif && !kullanildi) continue;
      const kayit = { firma, tipId: e.id, kod: e.kod, ad: e.ad, dara: e.dara,
        depozito: e.depozito, aktif: e.aktif, kullanildi };
      if (e.durum === 'kartYok' && !e.cakisan) rapor.acilacak.push(kayit);
      else rapor.engelli.push({ ...kayit, neden: e.neden });
    }
  }
  return rapor;
}

// Her kart kendi transaction'ında açılır: bir koddaki sorun ötekileri durdurmaz.
async function eksikKartlariAc(rapor) {
  if (rapor.veritabani!==veritabani()) throw new Error('Tarama başka veritabanına ait.');
  if (!ayarOku().vegayaYazmaAktif) throw new Error("Vega'ya yazma kapalı; kasa kartı açılmadı.");
  const sonuc = { acilan: [], atlanan: [], hatalar: [] };
  for (const k of rapor.acilacak) {
    try {
      const acilan = await sql.islem(async (t) => {
        const [e] = await kasa.kasaTipiEslesmeleri(k.firma, { idler: [k.tipId], t, kilitle: true });
        if (!e || kod(e.kod) !== kod(k.kod)) throw new Error(`Kasa tipi taramadan sonra değişmiş: ${k.kod}`);
        if (e.durum === 'hazir') return null;
        if (e.durum !== 'kartYok' || e.cakisan) throw new Error(e.neden);
        const r = await kasa.vegaKasaKartiAc(t, { firma: k.firma, kod: e.kod, ad: e.ad,
          dara: e.dara, depozito: e.depozito });
        const [son] = await kasa.kasaTipiEslesmeleri(k.firma, { idler: [k.tipId], t });
        if (son.durum !== 'hazir') throw new Error(son.neden);
        return r;
      });
      if (acilan) sonuc.acilan.push({ ...k, stokNo: acilan.stokNo, birimEx: acilan.birimEx });
      else sonuc.atlanan.push(k);
    } catch (e) {
      sonuc.hatalar.push({ ...k, neden: e.message });
    }
  }
  return sonuc;
}

function durumOku(dosya) {
  try {
    const d = JSON.parse(fs.readFileSync(dosya, 'utf8').replace(/^\uFEFF/, ''));
    if (d && typeof d === 'object' && d.tamamlananlar) return d;
  } catch (e) { /* ilk çalışma ya da bozuk dosya: yeniden taranır */ }
  return { surum: 1, tamamlananlar: {} };
}
function durumYaz(dosya, d) {
  fs.mkdirSync(path.dirname(dosya), { recursive: true });
  fs.writeFileSync(dosya, JSON.stringify(d, null, 2), 'utf8');
}
function logYaz(log, seviye, mesaj) {
  try { if (log && typeof log[seviye] === 'function') log[seviye](mesaj); }
  catch (e) { /* günlük arızası bakım sonucunu değiştirmez */ }
}

// Paketli uygulama güncellendikten sonra açılışta çağrılır. Tamamlanma anahtarı
// sürüm + sunucu + veritabanıdır. Yazma kapalıysa ya da bir kart açılamadıysa
// anahtar yazılmaz; sonraki açılışta yeniden denenir (iki adım da idempotent).
async function otomatikCalistir(secenek) {
  const o = secenek || {};
  const a = ayarOku();
  if (!a.vegayaYazmaAktif) {
    logYaz(o.log, 'info', "[kasa-karti-bakim] Vega'ya yazma kapalı; atlandı.");
    return { atlandi: true, neden: 'yazma-kapali', acilanKart: 0 };
  }
  const v = veritabani();
  const durumYolu = o.durumYolu || path.join(process.env.LOCALAPPDATA || os.tmpdir(),
    'hizli-belge-doldurucu-bakim', 'kasa-karti-bakim-durumu.json');
  const anahtar = [String(o.surum || 'bilinmeyen'),
    String(a.sunucu || 'localhost').trim().toLocaleLowerCase('tr-TR'),
    Number(a.port) || 1433, v.toLocaleLowerCase('tr-TR')].join('|');
  const durum = durumOku(durumYolu);
  if (durum.tamamlananlar[anahtar]) {
    return { atlandi: true, neden: 'daha-once-tamamlandi', acilanKart: 0, kayit: durum.tamamlananlar[anahtar] };
  }

  await sql.baglantiTesti();
  await require('../db/yardimci').hazirla();

  const kartRaporu = await eksikKartlariTara({});
  const kartSonucu = await eksikKartlariAc(kartRaporu);
  const kartDosyasi = dosyaYaz('otomatik-kartlar', { ...kartRaporu, sonuc: kartSonucu });
  const onarim = await uygula(await tara({}));
  const son = await tara({});
  const dogrulamaDosyasi = dosyaYaz('otomatik-dogrulama', son);
  if (son.duzeltmeler.length) {
    throw new Error(`Son taramada ${son.duzeltmeler.length} kasa satırı düzeltmesi kaldı; yedek: ${onarim.yedek}`);
  }

  const kayit = { tamamlanmaTarihi: new Date().toISOString(), uygulamaSurumu: String(o.surum || ''),
    veritabani: v, acilanKart: kartSonucu.acilan.length, engelliKart: kartRaporu.engelli.length,
    duzeltilenSatir: onarim.adet, kartBekleyen: son.kartBekleyen.length, riskli: son.riskli.length,
    kartDosyasi, yedek: onarim.yedek, dogrulamaDosyasi };
  const ozet = `${kayit.acilanKart} kart açıldı, ${kayit.duzeltilenSatir} kasa satırı onarıldı, ` +
    `${kayit.engelliKart} kod çakışması, ${kayit.riskli} elle incelenecek satır.`;
  if (kartSonucu.hatalar.length) {
    logYaz(o.log, 'error', `[kasa-karti-bakim] ${ozet} Açılamayan kart: ` +
      kartSonucu.hatalar.map((h) => `${h.firma}/${h.kod}: ${h.neden}`).join('; '));
    return { atlandi: false, tamamlandi: false, ...kayit, hatalar: kartSonucu.hatalar };
  }
  durum.tamamlananlar[anahtar] = kayit;
  durumYaz(durumYolu, durum);
  logYaz(o.log, 'info', `[kasa-karti-bakim] Tamamlandı: ${ozet} Rapor: ${kartDosyasi}`);
  return { atlandi: false, tamamlandi: true, ...kayit };
}

async function ana() {
  await sql.baglantiTesti();
  if (cli.geriAl) {
    const adet = await geriAl(JSON.parse(fs.readFileSync(path.resolve(cli.geriAl),'utf8')));
    console.log(`Geri alındı: ${adet} kasa satırı.`); return;
  }
  const kartRaporu = await eksikKartlariTara(cli);
  console.log(`Vega kartı açılacak kasa tipi: ${kartRaporu.acilacak.length}; ` +
    `açılamayan (kod çakışması vb.): ${kartRaporu.engelli.length}.`);
  for (const x of kartRaporu.acilacak) console.log(`Kart açılacak: ${x.firma} / ${x.kod}`);
  for (const x of kartRaporu.engelli) console.log(`Kart açılamaz: ${x.firma} / ${x.kod || '-'}: ${x.neden}`);
  if (cli.uygula && kartRaporu.acilacak.length) {
    const k = await eksikKartlariAc(kartRaporu);
    const dosya = dosyaYaz('acilan-kartlar', { ...kartRaporu, sonuc: k });
    console.log(`Açılan Vega kasa kartı: ${k.acilan.length}; hata: ${k.hatalar.length}. Ayrıntı: ${dosya}`);
    for (const h of k.hatalar) console.log(`Açılamadı: ${h.firma} / ${h.kod}: ${h.neden}`);
  }
  const rapor = await tara(cli);
  const raporDosyasi = dosyaYaz('tarama',rapor);
  console.log(`Veritabanı: ${rapor.veritabani}; kasa satırı: ${rapor.kasaSatiriSayisi}; `+
    `düzeltme: ${rapor.duzeltmeler.length}; kart bekleyen: ${rapor.kartBekleyen.length}; `+
    `riskli: ${rapor.riskli.length}; zaten doğru: ${rapor.zatenDogru}.`);
  console.log(`Tam önizleme: ${raporDosyasi}`);
  if (!cli.uygula) {
    for (const x of rapor.kartBekleyen.slice(0,20)) console.log(`Kart bekliyor: ${x.kod} / işlem ${x.islemId}`);
    for (const x of rapor.riskli.slice(0,20)) console.log(`Elle incele: işlem ${x.islemId}: ${x.neden}`);
    console.log('Veri değiştirilmedi. --uygula eksik kasa kartlarını açar, sonra kasa satırlarını onarır.');
    return;
  }
  const sonuc = await uygula(rapor);
  console.log(`Uygulandı: ${sonuc.adet} kasa satırı; kart bekleyen: ${sonuc.kartBekleyen}; `+
    `elle incelenecek: ${sonuc.riskli}. Geri alma yedeği: ${sonuc.yedek || 'değişiklik yok'}`);
  const son = await tara(cli);
  if (son.duzeltmeler.length) throw new Error(`Son taramada ${son.duzeltmeler.length} düzeltme kaldı; yedeği koruyun.`);
}
if (require.main===module) ana().catch((e)=>{console.error(`Kasa kartı bakımı durdu: ${e.message}`);process.exitCode=1;})
  .finally(()=>sql.havuzKapat());
module.exports = { tara, uygula, geriAl, eksikKartlariTara, eksikKartlariAc, otomatikCalistir };
