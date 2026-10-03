'use strict';

// Arayüzün tamamı. Çerçeve yok — Windows 7 üzerindeki eski makinelerde de
// anında açılması için düz JavaScript. Veritabanına erişim yalnızca
// window.api.cagir() üzerinden, preload'daki kanal listesiyle sınırlı.
//
// Program kendi ayrı bir veritabanı tutmuyor: "Belge Gir" ekranındaki her
// kayıt butonu doğrudan VEGADB'ye yazar (yazma:belge / yazma:kasaIade).
// Kasa tipleri (kod/ad/depozito) her açılışta canlı Vega'dan okunur; dara
// ağırlığı ve son belgeler listesi VEGADB'nin içindeki küçük yardımcı
// tablolardan gelir (bkz. db/yardimci.js).

const el = (id) => document.getElementById(id);

// ═══════════════════════ Ortak yardımcılar ═══════════════════════

async function cagir(kanal, girdi) {
  const c = await window.api.cagir(kanal, girdi);
  if (!c.tamam) {
    const hata = new Error(c.hata || 'Bilinmeyen hata');
    hata.kod = c.kod;
    throw hata;
  }
  return c.veri;
}

let uyariZamani = null;

function bildir(mesaj, tur) {
  const kutu = el('uyari');
  kutu.textContent = mesaj;
  kutu.className = 'uyari' + (tur ? ' ' + tur : '');
  if (uyariZamani) clearTimeout(uyariZamani);
  if (tur === 'basarili') {
    uyariZamani = setTimeout(() => kutu.classList.add('gizli'), 6000);
  }
}

function uyariKapat() {
  el('uyari').classList.add('gizli');
}

// Kullanıcı hem "30,5" hem "30.5" yazabiliyor. Binlik ayracı olarak nokta
// kullanıldığında ("1.234,56") noktaların atılması gerekiyor.
function sayiOku(ham) {
  let m = String(ham == null ? '' : ham).trim();
  if (!m) return 0;
  m = m.replace(/\s/g, '');
  if (m.indexOf(',') >= 0 && m.indexOf('.') >= 0) {
    m = m.replace(/\./g, '').replace(',', '.');
  } else if (m.indexOf(',') >= 0) {
    m = m.replace(',', '.');
  }
  const n = Number(m);
  return Number.isFinite(n) ? n : 0;
}

// ─── Tutar alanları: binlik ayraç ───
//
// 03.10.2026 müşteri isteği: tutar yazarken araya nokta kendiliğinden girsin
// (40000 → 40.000). tutarGirdisiBagla ile işaretlenen alanlarda nokta YALNIZ
// binlik ayraçtır, ondalık her zaman virgüldür — bu alanlar sayiOku ile değil
// tutarOku ile okunur (sayiOku tek başına duran noktayı ondalık sayar: o
// kurala göre "40.000" kırk olurdu). Miktar/adet alanlarına bağlanmaz.
function tutarBicimle(ham) {
  const m = String(ham == null ? '' : ham).replace(/[^\d,]/g, '');
  const virgul = m.indexOf(',');
  let tam = virgul >= 0 ? m.slice(0, virgul) : m;
  tam = tam.replace(/^0+(?=\d)/, '');
  const gruplu = tam.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (virgul < 0) return gruplu;
  return (gruplu || '0') + ',' + m.slice(virgul + 1).replace(/,/g, '');
}

function tutarOku(ham) {
  const m = String(ham == null ? '' : ham).replace(/[\s.]/g, '').replace(',', '.');
  if (!m) return 0;
  const n = Number(m);
  return Number.isFinite(n) ? n : 0;
}

function tutarGirdisiBagla(girdi) {
  girdi.dataset.tutar = '1';
  girdi.addEventListener('input', () => {
    const eski = girdi.value;
    const yeni = tutarBicimle(eski);
    if (yeni === eski) return;
    // İmleç, solundaki rakam/virgül sayısı korunarak yeniden konur; araya
    // giren noktalar yazarken imleci kaydırmasın.
    const imlec = girdi.selectionStart == null ? eski.length : girdi.selectionStart;
    const solda = eski.slice(0, imlec).replace(/[^\d,]/g, '').length;
    girdi.value = yeni;
    let konum = 0;
    for (let sayac = 0; konum < yeni.length && sayac < solda; konum++) {
      if (/[\d,]/.test(yeni[konum])) sayac++;
    }
    girdi.setSelectionRange(konum, konum);
  });
}

function para(n) {
  return (Number(n) || 0).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function miktarYaz(n) {
  return (Number(n) || 0).toLocaleString('tr-TR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3
  });
}

function tarihYaz(t) {
  if (!t) return '';
  const d = t instanceof Date ? t : new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('tr-TR');
}

function tarihSaatYaz(t) {
  if (!t) return '';
  const d = t instanceof Date ? t : new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('tr-TR') + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function bugun() {
  const d = new Date();
  const ay = String(d.getMonth() + 1).padStart(2, '0');
  const gun = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${ay}-${gun}`;
}

function tarihKutusu(d) {
  const t = d instanceof Date ? d : new Date(d);
  const ay = String(t.getMonth() + 1).padStart(2, '0');
  const gun = String(t.getDate()).padStart(2, '0');
  return `${t.getFullYear()}-${ay}-${gun}`;
}

// ═══════════════════════ "Google gibi" arama ═══════════════════════
//
// İki kural: (1) yazılan kelimeler ayrı ayrı aranır, sırası önemli değil;
// (2) Türkçe aksan ve büyük/küçük harf farkı yok sayılır — "cinar" yazan
// "ÇINAR"ı bulur. Sunucu tarafındaki eşi db/vega.js → aramaFiltresiKur.
// Buradaki iş sıralama: hangi sonuç üstte görünecek.

const TURKCE_HARF = {
  'ı': 'i', 'İ': 'i', 'I': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g',
  'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c',
  'â': 'a', 'Â': 'a', 'î': 'i', 'Î': 'i', 'û': 'u', 'Û': 'u'
};

function sadelestir(metin) {
  return String(metin == null ? '' : metin)
    .replace(/[ıİIşŞğĞüÜöÖçÇâÂîÎûÛ]/g, (c) => TURKCE_HARF[c] || c)
    .toLowerCase();
}

function aramaParcalari(ham) {
  return sadelestir(ham).split(/\s+/).filter(Boolean);
}

// Eşleşmiyorsa -1. Büyük puan = üstte. Kelime başından eşleşme, adın
// başından eşleşme ve kısa ad puanı yükseltir.
function aramaPuani(metin, parcalar) {
  if (!parcalar.length) return 0;
  const m = sadelestir(metin);
  let puan = 0;
  for (const p of parcalar) {
    const yer = m.indexOf(p);
    if (yer < 0) return -1;
    if (yer === 0) puan += 120;
    else if (m[yer - 1] === ' ') puan += 70;
    else puan += 25;
    puan += Math.max(0, 25 - yer);
    if (p.length === m.length) puan += 40; // tam eşleşme
  }
  return puan - Math.min(m.length, 60) / 12;
}

function aramayaGoreSirala(liste, parcalar, adAl) {
  if (!parcalar.length) return liste;
  return liste
    .map((x) => ({ x, puan: aramaPuani(adAl(x), parcalar) }))
    .filter((s) => s.puan >= 0)
    .sort((a, b) => b.puan - a.puan)
    .map((s) => s.x);
}

function boslukTemizle(govde, sutunSayisi, mesaj) {
  govde.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.className = 'bosSatir';
  td.colSpan = sutunSayisi;
  td.textContent = mesaj;
  tr.appendChild(td);
  govde.appendChild(tr);
}

// ═══════════════════════ Uygulama durumu ═══════════════════════

const durum = {
  ayar: null,
  firmalar: [],
  // Cari kartlarında Özel Kod 1'de geçen değerler (süzgeç kutuları buradan dolar)
  ozelKod1: [],
  depolar: [],
  kasaKartlari: [],   // BD_KasaTipi: {id, kod, ad, depozito, dara}; id Vega stok numarası değildir
  stoklar: [],
  stokHaritasi: new Map(),
  stokSecenekleri: [],   // {etiket, kart, aranan} — satır içi ürün araması
  yazmaAcik: false
};

function firmaKodu() {
  return durum.ayar ? durum.ayar.varsayilanFirma : '';
}
function donemKodu() {
  return durum.ayar ? durum.ayar.varsayilanDonem : '';
}
function firmaSecildiMi() {
  return !!(firmaKodu() && donemKodu());
}

// ═══════════════════════ Sekmeler ═══════════════════════

document.querySelectorAll('.sekme').forEach((dugme) => {
  dugme.addEventListener('click', () => sekmeAc(dugme.dataset.sekme));
});

// 30.09.2026 müşteri isteği: "hesaptan hesaba geçerken kişiler sıfırlansın
// (kasa hariç)". Bir sekmeden çıkılınca o sekmede seçili müşteri bırakılır;
// Kasa sekmesi seçimini korur. Düzenleme sürerken seçim korunur — müşteri
// düşerse açık düzenleme kaydedilemez. Başka sekmeden müşteriyle gelen
// geçişler (Haftalık Rapor → Ekstre, Son Belgeler → düzenleme) seçimi
// sekmeAc'tan SONRA yaptığı için etkilenmez.
let etkinSekme = 'belge';

function sekmeMusterisiniBirak(ad) {
  if (ad === 'belge' && !duzenlenenBelge) {
    belgeCari.temizle();
  } else if (ad === 'ekstre') {
    ekstreCari.temizle();
    ekstreRaporSirasi++;   // yoldaki döküm gizlenen rapora yazılmasın
    el('ekstreRapor').classList.add('gizli');
    ekstreYukle();
  } else if (ad === 'alis' && !alisDuzenleme) {
    alisCari.temizle();
  } else if (ad === 'odeme' && !odemeDuzenleme) {
    if (!odemeCari.secili()) return;
    odemeCari.temizle();
    if (!odemeDurum.ilkAcilis) odemeGecmisiGetir();
  }
}

function sekmeAc(ad) {
  if (ad !== etkinSekme) {
    sekmeMusterisiniBirak(etkinSekme);
    etkinSekme = ad;
  }
  document.querySelectorAll('.sekme').forEach((d) => {
    d.classList.toggle('etkin', d.dataset.sekme === ad);
  });
  document.querySelectorAll('.sayfa').forEach((s) => {
    s.classList.toggle('etkin', s.id === 'sayfa-' + ad);
  });
  if (ad === 'kasa') kasaBakiyesiniYukle();
  // Açılışta kasa tipleri okunamadıysa (ör. güncelleme sonrası bakım aynı anda
  // çalışırken) seçim kutuları boş kalmasın: kasa kullanan ekrana gelince tekrar dene.
  if ((ad === 'kasa' || ad === 'belge') && firmaSecildiMi() && !durum.kasaKartlari.length) {
    kasaKartlariniYukle();
  }
  if (ad === 'belgeler') belgelerYukle();
  if (ad === 'ayar') ayarSayfasiniDoldur();
  if (ad === 'rapor') raporSayfasiAcildi();
  if (ad === 'odeme') odemeSayfasiAcildi();
}

// ═══════════════════════ Müşteri arama kutusu ═══════════════════════
//
// Üç yerde kullanılıyor (belge, kasa iadesi, ekstre). Arama sunucuda yapılıyor:
// cari sayısı binleri geçtiğinde hepsini indirip tarayan yaklaşım açılışı
// yavaşlatıyor.

function cariKutusuKur(aramaId, sonucId, seciliId, secildiginde, ekParametre) {
  const arama = el(aramaId);
  const sonuc = el(sonucId);
  const secili = el(seciliId);
  let zaman = null;
  let seciliCari = null;

  function kapat() { sonuc.classList.add('gizli'); }

  function secimiGoster(cari) {
    seciliCari = cari;
    if (!cari) {
      secili.classList.add('gizli');
      secili.innerHTML = '';
      arama.classList.remove('gizli');
      return;
    }
    secili.classList.remove('gizli');
    secili.innerHTML = '';

    // Cari kodu ekranda gösterilmiyor (05.09.2026 kullanıcı isteği: "koda
    // gerek yok"); seçimde yine cariInd taşınıyor, arama kodu da tarıyor.
    const ad = document.createElement('b');
    ad.textContent = cari.ad;
    const bakiye = document.createElement('span');
    bakiye.className = 'bakiye';
    bakiye.textContent = 'Bakiye: ' + para(cari.bakiye) + ' TL';
    if (cari.bakiye < 0) bakiye.classList.add('eksi');

    const degistir = document.createElement('button');
    degistir.className = 'dugme mini ikincil';
    degistir.type = 'button';
    degistir.textContent = 'Değiştir';
    degistir.addEventListener('click', () => {
      secimiGoster(null);
      arama.value = '';
      arama.focus();
      if (secildiginde) secildiginde(null);
    });

    secili.append(ad, bakiye, degistir);
    arama.classList.add('gizli');
    kapat();
  }

  async function ara() {
    const metin = arama.value.trim();
    if (!firmaSecildiMi()) {
      sonuc.classList.remove('gizli');
      sonuc.innerHTML = '<div class="bos">Önce Ayarlar ekranından firma ve dönem seçin.</div>';
      return;
    }
    try {
      const ham = await cagir('vega:cariler', Object.assign({
        firma: firmaKodu(),
        donem: donemKodu(),
        arama: metin,
        limit: 200
      }, ekParametre ? ekParametre() : null));
      // Sunucu "hangi kartlar eşleşiyor"u veriyor; sıralamayı burada yapıyoruz:
      // aranan kelime adın başındaysa o kart üste çıksın.
      const parcalar = aramaParcalari(metin);
      const liste = aramayaGoreSirala(
        ham, parcalar, (c) => c.ad + ' ' + c.kod + ' ' + (c.adres || '')
      ).slice(0, 40);

      sonuc.innerHTML = '';
      if (!liste.length) {
        // Toptan/perakende süzgeci açıkken hiç kart çıkmıyorsa sebebi
        // çoğunlukla kartlarda Özel Kod 1'in boş olmasıdır — kullanıcı
        // "müşteri kayboldu" sanmasın.
        const ekler = ekParametre ? ekParametre() : {};
        const ek = ekler.musteriTipi;
        sonuc.innerHTML = '<div class="bos"></div>';
        sonuc.firstChild.textContent = ekler.tip === 'tedarikci'
          ? 'Eşleşen satıcı yok. Yalnız cari tipi Satıcı (ya da Alıcı + Satıcı) olan kartlar ' +
            'listelenir; tedarikçinin kartında tipi Satıcı yapın ya da "+ Yeni Cari Kartı" ile açın.'
          : ek
            ? `Eşleşen müşteri yok. Cari kartlarında Özel Kod 1 = ${ek} yazmıyorsa ` +
              'yukarıdan "Hepsi" seçin.'
            : 'Eşleşen müşteri yok.';
      } else {
        for (const c of liste) {
          const d = document.createElement('button');
          d.type = 'button';
          const sol = document.createElement('span');
          sol.textContent = c.ad + (c.adres ? ' — ' + c.adres : '');
          const sag = document.createElement('span');
          sag.className = 'kod';
          sag.textContent = para(c.bakiye) + ' TL';
          d.append(sol, sag);
          d.addEventListener('click', () => {
            secimiGoster(c);
            if (secildiginde) secildiginde(c);
          });
          sonuc.appendChild(d);
        }
      }
      sonuc.classList.remove('gizli');
    } catch (e) {
      sonuc.classList.remove('gizli');
      sonuc.innerHTML = '<div class="bos"></div>';
      sonuc.firstChild.textContent = 'Müşteri listesi okunamadı: ' + e.message;
    }
  }

  arama.addEventListener('input', () => {
    if (zaman) clearTimeout(zaman);
    zaman = setTimeout(ara, 220);
  });
  arama.addEventListener('focus', ara);

  document.addEventListener('click', (olay) => {
    if (olay.target !== arama && !sonuc.contains(olay.target)) kapat();
  });

  return {
    secili: () => seciliCari,
    temizle: () => { secimiGoster(null); arama.value = ''; kapat(); },
    // Belge kaydedildikten sonra imleç doğrudan müşteri kutusuna gelsin.
    odakla: () => { arama.focus(); },
    // Toptan/perakende süzgeci değişince açık listeyi tazelemek için.
    tekrarAra: () => { if (!sonuc.classList.contains('gizli')) ara(); },
    // Müşteri listesi penceresinden doğrudan seçim yapılabilsin diye.
    // secenek seçim geri çağrısına aynen geçer (ör. Ekstre'de haftayı koru).
    sec: (cari, secenek) => {
      secimiGoster(cari);
      if (secildiginde) secildiginde(cari, secenek);
    },
    yenile: async () => {
      const istenen = seciliCari;
      if (!istenen) return;
      try {
        const b = await cagir('vega:bakiye', {
          firma: firmaKodu(),
          donem: donemKodu(),
          cariInd: istenen.cariInd
        });
        // Bakiye gelene kadar sekme değişip seçim bırakıldıysa (ya da başka
        // müşteri seçildiyse) eski müşteri kutuya geri yazılmasın.
        if (!seciliCari || Number(seciliCari.cariInd) !== Number(istenen.cariInd)) return;
        secimiGoster(Object.assign({}, seciliCari, { bakiye: b }));
      } catch (e) { /* bakiye tazelenemezse eskisi kalsın */ }
    }
  };
}

// Belge ekranındaki müşteri kutusu, Tarih'in yanındaki Özel Kod 1 süzgecine
// bağlı (05.09.2026 kullanıcı isteği). Seçenekler sabit değil: cari
// kartlarının KOD1 alanında ne yazıyorsa o listeleniyor (ozelKodlariYukle).
// Açılışta TOPTAN varsa o seçili gelir — günlük iş toptan müşterilerle.
function musteriTipi() {
  const s = el('musteriTipi');
  return s ? s.value : '';
}

const belgeCari = cariKutusuKur('cariArama', 'cariSonuc', 'cariSecili', null,
  () => ({ musteriTipi: musteriTipi() }));
const iadeCari = cariKutusuKur('iadeCariArama', 'iadeCariSonuc', 'iadeCariSecili', () =>
  iadeBilgisiniGuncelle()
);
const ekstreCari = cariKutusuKur('ekstreCariArama', 'ekstreCariSonuc', 'ekstreCariSecili',
  (c, secenek) => ekstreCariDegisti(c, secenek));
const odemeCari = cariKutusuKur('odemeCariArama', 'odemeCariSonuc', 'odemeCariSecili',
  () => odemeGecmisiGetir());
// 01.10.2026 müşteri isteği: tedarikçi kutusunda yalnız satıcı tipli cariler;
// perakende ve alıcılar gelmesin (bkz. db/vega.js → cariTipFiltresi).
const alisCari = cariKutusuKur('alisCariArama', 'alisCariSonuc', 'alisCariSecili', null,
  () => ({ tip: 'tedarikci' }));

// ═══════════════════════ BELGE GİR ═══════════════════════

// Ürün listesi bir kez açılışta indiriliyor, arama tarayıcı tarafında yapılıyor
// — her tuşta sunucuya gitmek eski makinelerde gözle görülür gecikme yapıyordu.
function stokListesiniDoldur() {
  durum.stokHaritasi = new Map();
  durum.stokSecenekleri = [];
  for (const s of durum.stoklar) {
    // Aynı isimde iki kart olabiliyor; ayırt etmek için koda düşüyoruz.
    const etiket = durum.stokHaritasi.has(s.ad) && s.kod ? `${s.ad} [${s.kod}]` : s.ad;
    durum.stokHaritasi.set(etiket, s);
    durum.stokSecenekleri.push({ etiket, kart: s, aranan: etiket + ' ' + (s.kod || '') });
  }
}

// ═══════════════════════ Ürün arama kutusu (satır içi) ═══════════════════════
//
// <datalist> yerine kendi açılır listemiz var. Sebebi üç tane: (1) datalist
// sıralamayı bize bırakmıyor — "biber" yazınca en alakalısı üste çıkmıyordu,
// (2) çok kelimeli arama ("kapya biber" / "biber kapya") datalist'te hiç
// çalışmıyor, (3) yön tuşlarıyla gezinmeyi kendimiz yönetmemiz gerekiyor
// (aşağı ok satır tablosunda başka bir iş yapıyor).
function stokKutusuKur(girdi, hucre, secildiginde) {
  const acilir = document.createElement('div');
  acilir.className = 'stokAcilir gizli';
  hucre.appendChild(acilir);

  let secenekler = [];
  let imlec = -1;

  function kapat() {
    acilir.classList.add('gizli');
    acilir.innerHTML = '';
    secenekler = [];
    imlec = -1;
  }

  function acikMi() {
    return !acilir.classList.contains('gizli');
  }

  function imleciTasi(fark) {
    if (!secenekler.length) return;
    imlec = (imlec + fark + secenekler.length) % secenekler.length;
    for (let i = 0; i < acilir.children.length; i++) {
      acilir.children[i].classList.toggle('secilen', i === imlec);
    }
    const secili = acilir.children[imlec];
    if (secili && secili.scrollIntoView) secili.scrollIntoView({ block: 'nearest' });
  }

  function sec(secenek) {
    girdi.value = secenek.etiket;
    kapat();
    if (secildiginde) secildiginde(secenek.kart);
  }

  function goster() {
    const parcalar = aramaParcalari(girdi.value);
    const kaynak = durum.stokSecenekleri || [];
    secenekler = parcalar.length
      ? aramayaGoreSirala(kaynak, parcalar, (s) => s.aranan).slice(0, 12)
      : kaynak.slice(0, 12);

    acilir.innerHTML = '';
    if (!secenekler.length) {
      const bos = document.createElement('div');
      bos.className = 'bos';
      bos.textContent = kaynak.length ? 'Eşleşen ürün yok.' : 'Ürün listesi okunamadı.';
      acilir.appendChild(bos);
    } else {
      secenekler.forEach((s, i) => {
        const d = document.createElement('button');
        d.type = 'button';
        d.tabIndex = -1;
        const sol = document.createElement('span');
        sol.textContent = s.etiket;
        const sag = document.createElement('span');
        sag.className = 'kod';
        sag.textContent = s.kart.kod || '';
        d.append(sol, sag);
        // mousedown: blur'dan önce çalışsın, yoksa tıklama kutuyu kapatıyor.
        d.addEventListener('mousedown', (olay) => { olay.preventDefault(); sec(s); });
        acilir.appendChild(d);
        if (i === 0) d.classList.add('secilen');
      });
      imlec = 0;
    }
    acilir.classList.remove('gizli');
  }

  girdi.addEventListener('input', goster);
  // Boş kutuya odaklanınca liste açılmıyor: yeni satır açıldığında ekranın
  // yarısını kaplayan bir ürün listesi çıkması kullanıcıyı şaşırtıyordu.
  girdi.addEventListener('focus', () => { if (girdi.value.trim()) goster(); });
  girdi.addEventListener('blur', () => setTimeout(kapat, 120));

  return {
    acikMi,
    kapat,
    imleciTasi,
    // Açık listede seçili olanı alır; yoksa yazılan metne birebir uyanı arar.
    secimiOnayla() {
      if (acikMi() && secenekler[imlec]) {
        sec(secenekler[imlec]);
        return true;
      }
      return false;
    }
  };
}

function kasaKartiSecenekleri(secili) {
  const s = document.createElement('select');
  const bos = document.createElement('option');
  bos.value = '';
  bos.textContent = '—';
  s.appendChild(bos);
  for (const k of durum.kasaKartlari) {
    const o = document.createElement('option');
    o.value = String(k.id);
    o.textContent = k.kod || k.ad;
    if (String(secili) === String(k.id)) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function satirEkle() {
  const govde = el('satirGovde');
  const tr = document.createElement('tr');

  const stokHucre = document.createElement('td');
  const stok = document.createElement('input');
  stok.type = 'text';
  stok.placeholder = 'Ürün adı yazın…';
  stok.autocomplete = 'off';
  stokHucre.appendChild(stok);

  function sayiHucresi(yerTutucu) {
    const td = document.createElement('td');
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'sayi';
    i.inputMode = 'decimal';
    i.autocomplete = 'off';
    if (yerTutucu) i.placeholder = yerTutucu;
    td.appendChild(i);
    return { td, girdi: i };
  }

  const kasaAdedi = sayiHucresi('adet');

  const tipHucre = document.createElement('td');
  const tip = kasaKartiSecenekleri('');
  tipHucre.appendChild(tip);

  const brutMiktar = sayiHucresi('kg');

  const daraHucre = document.createElement('td');
  daraHucre.className = 'hesaplanan';
  daraHucre.textContent = '0';

  const daraliMiktarHucre = document.createElement('td');
  daraliMiktarHucre.className = 'hesaplanan';
  daraliMiktarHucre.textContent = '0';

  const fiyat = sayiHucresi('TL');
  tutarGirdisiBagla(fiyat.girdi);

  const tutarHucre = document.createElement('td');
  tutarHucre.className = 'hesaplanan';
  tutarHucre.textContent = '0,00';

  const kasaTutarHucre = document.createElement('td');
  kasaTutarHucre.className = 'hesaplanan';
  kasaTutarHucre.textContent = '0,00';

  // Açıklama elle yazılan rapor notudur. 27.08.2026'ya kadar program buraya
  // dara hesabını otomatik yazıyordu; 03.09.2026'dan itibaren not yalnızca
  // uygulama günlüğü/ayrıntılı raporda tutulur, gerçek Vega satırına yazılmaz.
  const aciklamaHucre = document.createElement('td');
  const aciklama = document.createElement('input');
  aciklama.type = 'text';
  aciklama.placeholder = '(isteğe bağlı)';
  aciklama.autocomplete = 'off';
  aciklama.maxLength = 250;
  // Kullanıcı açıklamaya yalnız fareyle girmek istiyor; hızlı veri girişindeki
  // Tab akışı fiyat alanından doğrudan sonraki satıra geçer.
  aciklama.tabIndex = -1;
  aciklamaHucre.appendChild(aciklama);

  const silHucre = document.createElement('td');
  silHucre.className = 'sayi';
  const sil = document.createElement('button');
  sil.type = 'button';
  sil.className = 'dugme mini ucuncul';
  sil.textContent = 'Sil';
  sil.tabIndex = -1;
  sil.addEventListener('click', () => {
    tr.remove();
    if (!govde.children.length) satirEkle();
    toplamlariGuncelle();
  });
  silHucre.appendChild(sil);

  tr.append(
    stokHucre, brutMiktar.td, kasaAdedi.td, tipHucre, daraHucre,
    daraliMiktarHucre, fiyat.td, tutarHucre, kasaTutarHucre, aciklamaHucre, silHucre
  );
  govde.appendChild(tr);

  // Satır verisini DOM'da değil burada tutuyoruz; hesaplama tek yerden geçiyor.
  tr._satir = {
    stokGirdi: stok,
    brutMiktarGirdi: brutMiktar.girdi,
    kasaAdediGirdi: kasaAdedi.girdi,
    tipSecim: tip,
    fiyatGirdi: fiyat.girdi,
    aciklamaGirdi: aciklama,
    daraHucre,
    daraliMiktarHucre,
    tutarHucre,
    kasaTutarHucre
  };

  function stokSecildi(kart) {
    if (kart && kart.fiyat) {
      sayiGirdisineYaz(fiyat.girdi, kart.fiyat);
    }
    toplamlariGuncelle();
    // Önce kilo giriliyor: ürün seçiminden sonra doğrudan Brüt Miktar'a geç.
    brutMiktar.girdi.focus();
    brutMiktar.girdi.select();
  }

  tr._satir.stokKutusu = stokKutusuKur(stok, stokHucre, stokSecildi);

  stok.addEventListener('change', toplamlariGuncelle);

  [stok, brutMiktar.girdi, kasaAdedi.girdi, fiyat.girdi].forEach((i) => {
    i.addEventListener('input', toplamlariGuncelle);
  });
  tip.addEventListener('change', toplamlariGuncelle);

  // Klavye gezinmesi — kullanıcı isteği:
  //   Tab  → sağa; Fiyat'tan sonra Açıklama/Sil'i atlayıp yeni satıra geçer
  //   ↓    → alttaki satırın aynı sütunu; son satırdaysanız YENİ SATIR açar
  //   ↑    → üstteki satırın aynı sütunu
  //   Enter→ ↓ ile aynı
  // Ürün kutusunda açılır liste açıkken ↑/↓ listede gezinir, Enter seçer —
  // ancak o zaman satır gezinmesine karışmaz.
  for (const girdi of satirAlanlari(tr)) {
    girdi.addEventListener('keydown', (olay) => satirKlavyesi(olay, tr, girdi));
  }

  stok.focus();
  return tr;
}

// Satırdaki hızlı giriş alanları, soldan sağa. Hesaplanan hücrelerle kullanıcı
// isteği gereği yalnız fareyle açılan Açıklama/Sil, Tab akışında yok.
function satirAlanlari(tr) {
  const s = tr._satir;
  if (!s) return [];
  return [s.stokGirdi, s.brutMiktarGirdi, s.kasaAdediGirdi, s.tipSecim, s.fiyatGirdi];
}

function sonrakiSatirinBasinaGec(tr) {
  const govde = el('satirGovde');
  let hedef = tr.nextElementSibling;
  if (!hedef) {
    hedef = satirEkle();
    toplamlariGuncelle();
  }
  if (!hedef || !hedef._satir) return;
  const stok = hedef._satir.stokGirdi;
  stok.focus();
  stok.select();
  if (govde.lastElementChild === hedef && stok.scrollIntoView) {
    stok.scrollIntoView({ block: 'nearest' });
  }
}

function komsuSatiraGec(tr, girdi, yon) {
  const govde = el('satirGovde');
  const alanlar = satirAlanlari(tr);
  const sutun = Math.max(0, alanlar.indexOf(girdi));

  let hedef = yon > 0 ? tr.nextElementSibling : tr.previousElementSibling;

  if (yon > 0 && !hedef) {
    // Son satırda aşağı ok: yeni satır aç (kullanıcı isteği).
    hedef = satirEkle();
    toplamlariGuncelle();
  }
  if (!hedef || !hedef._satir) return;

  const hedefAlanlar = satirAlanlari(hedef);
  const secilen = hedefAlanlar[Math.min(sutun, hedefAlanlar.length - 1)];
  if (!secilen) return;
  secilen.focus();
  if (secilen.select) secilen.select();
  if (govde.lastElementChild === hedef && secilen.scrollIntoView) {
    secilen.scrollIntoView({ block: 'nearest' });
  }
}

function satirKlavyesi(olay, tr, girdi) {
  const kutu = tr._satir && tr._satir.stokKutusu;
  const urunKutusunda = girdi === tr._satir.stokGirdi;

  if (olay.key === 'ArrowDown' || olay.key === 'ArrowUp') {
    if (urunKutusunda && kutu && kutu.acikMi()) {
      olay.preventDefault();
      kutu.imleciTasi(olay.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // Açılır kutusu olan <select> kendi seçeneklerinde gezinsin.
    if (girdi.tagName === 'SELECT' && !olay.altKey) return;
    olay.preventDefault();
    komsuSatiraGec(tr, girdi, olay.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (olay.key === 'Enter') {
    olay.preventDefault();
    if (urunKutusunda && kutu && kutu.secimiOnayla()) return;
    komsuSatiraGec(tr, girdi, 1);
    return;
  }

  if (olay.key === 'Tab' && urunKutusunda && kutu && kutu.acikMi()) {
    // Tab da seçsin: listede gezinip Tab'a basan kullanıcı ürünü kaybetmesin.
    if (kutu.secimiOnayla()) olay.preventDefault();
    return;
  }

  if (olay.key === 'Tab' && !olay.shiftKey && girdi === tr._satir.fiyatGirdi) {
    olay.preventDefault();
    sonrakiSatirinBasinaGec(tr);
    return;
  }

  if (olay.key === 'Escape' && kutu) kutu.kapat();
}

function kdvOraniOku() {
  return Number(durum.ayar && durum.ayar.varsayilanKdv) || 0;
}

function satirOku(tr) {
  const s = tr._satir;
  if (!s) return null;

  const etiket = s.stokGirdi.value.trim();
  const stok = durum.stokHaritasi.get(etiket) || null;
  const brutMiktar = sayiOku(s.brutMiktarGirdi.value);
  const kasaAdedi = sayiOku(s.kasaAdediGirdi.value);
  const fiyatGirilen = tutarOku(s.fiyatGirdi.value);
  const kasaStokNo = s.tipSecim.value ? Number(s.tipSecim.value) : null;
  const kasa = kasaStokNo ? durum.kasaKartlari.find((k) => k.id === kasaStokNo) : null;

  // "Girilen fiyatlara KDV dahil" işaretliyse kullanıcının yazdığı fiyat
  // BRÜT kabul edilir, KDV oranına bölünerek NET fiyata çevrilir — Vega'nın
  // kendi "Kdv Dahil" kutusuyla aynı mantık (24.08.2026, kullanıcının canlı
  // ortamda doğruladığı davranış: kutu kapalıyken 60 TL → 50 TL/9.900 TL
  // görünüyor). Vega'ya her zaman NET fiyat/tutar yazılır, KDV oradan ayrıca
  // hesaplanır (bkz. db/yazma.js → belgeYaz).
  const kdvOrani = kdvOraniOku();
  const kdvDahil = !!(el('kdvDahil') && el('kdvDahil').checked);
  const fiyat = (kdvDahil && kdvOrani) ? fiyatGirilen / (1 + kdvOrani / 100) : fiyatGirilen;

  const kasaDarasi = kasa ? (kasa.dara || 0) : 0;
  const dara = Math.round(kasaAdedi * kasaDarasi * 1000) / 1000;
  const daraliMiktar = Math.round(Math.max(brutMiktar - dara, 0) * 1000) / 1000;
  const tutar = Math.round(daraliMiktar * fiyat * 100) / 100;
  const kasaDepozito = kasa ? kasa.depozito : 0; // depozito KDV'siz, kdvDahil'den etkilenmez
  const kasaTutari = Math.round(kasaAdedi * kasaDepozito * 100) / 100;

  const aciklama = s.aciklamaGirdi ? s.aciklamaGirdi.value.trim() : '';

  return {
    etiket, stok, brutMiktar, dara, daraliMiktar, kasaAdedi, fiyat, tutar,
    kasaStokNo,
    kasaTipiKod: kasa ? kasa.kod : null,
    kasaTipiAdi: kasa ? kasa.ad : null,
    kasaDarasi,
    kasaDepozito,
    kasaTutari,
    aciklama,
    bos: !etiket && !brutMiktar && !kasaAdedi && !fiyatGirilen && !aciklama
  };
}

// KDV, yazma.js → belgeYaz'ın satış faturası dalında satır başına aynı
// formülle uygulanıyor (kdvOrani ? Math.round(tutar*kdvOrani)/100 : 0) ama
// "Cari Giriş Olarak Kaydet" (faturasız) ile hiç eklenmiyor — o yüzden
// burada iki ayrı genel toplam hesaplanıp kullanıcıya hangi tuşun ne tutar
// geçireceği gösteriliyor. `s.tutar` her zaman NET'tir (satirOku KDV Dahil
// kutusunu zaten hesaba katıp fiyatı NET'e çevirir), o yüzden burada tekrar
// bölme yapılmıyor, sadece KDV üstüne EKLENİYOR.
function toplamlariGuncelle() {
  let urun = 0;
  let kasa = 0;
  let kdv = 0;
  const kdvOrani = kdvOraniOku();
  for (const tr of el('satirGovde').children) {
    const s = satirOku(tr);
    if (!s) continue;
    s.stok ? tr._satir.stokGirdi.style.removeProperty('border-color')
           : (tr._satir.stokGirdi.style.borderColor = s.etiket ? '#f87171' : '');
    tr._satir.daraHucre.textContent = miktarYaz(s.dara);
    tr._satir.daraliMiktarHucre.textContent = miktarYaz(s.daraliMiktar);
    tr._satir.tutarHucre.textContent = para(s.tutar);
    tr._satir.kasaTutarHucre.textContent = para(s.kasaTutari);
    urun += s.tutar;
    kasa += s.kasaTutari;
    kdv += kdvOrani ? Math.round(s.tutar * kdvOrani) / 100 : 0;
  }
  const tahsilat = tutarOku(el('tahsilat').value);
  const genelFatura = urun + kdv + kasa; // Satış Faturası Olarak Kaydet
  const genelCariGiris = urun + kasa;    // Cari Giriş Olarak Kaydet (KDV eklenmez)

  el('urunToplam').textContent = para(urun);
  el('kdvToplam').textContent = para(kdv);
  el('kasaToplam').textContent = para(kasa);
  el('genelToplam').textContent = para(genelFatura);
  const not = el('genelToplamNot');
  if (not) {
    not.textContent = kdv > 0
      ? `Cari Giriş ile: ${para(genelCariGiris)} (KDV'siz)`
      : '';
  }
  el('kalanToplam').textContent = para(genelFatura - tahsilat);
}

el('musteriTipi').addEventListener('change', () => belgeCari.tekrarAra());
el('satirEkle').addEventListener('click', () => satirEkle());
tutarGirdisiBagla(el('tahsilat'));
el('tahsilat').addEventListener('input', () => toplamlariGuncelle());
el('kdvDahil').addEventListener('change', () => toplamlariGuncelle());

let duzenlenenBelge = null;

function belgeDuzenlemeGorunumunuSifirla() {
  duzenlenenBelge = null;
  el('belgeDuzenlemeBilgi').classList.add('gizli');
  el('belgeDuzenlemeBilgi').textContent = '';
  el('kaydetFatura').classList.remove('gizli');
  el('kaydetCariCikis').classList.remove('gizli');
  el('kaydetFatura').textContent = 'Satış Faturası Olarak Kaydet';
  el('kaydetCariCikis').textContent = 'Cari Giriş Olarak Kaydet';
  el('formTemizle').textContent = 'Formu Temizle';
}

// Formu boşaltır. sonKaydiGizle=false ise "Kaydedilen Belge" kutusu ekranda
// kalır: belge kaydedildikten hemen sonra form temizlenir ama kullanıcı yazılan
// belge numarasını görebilsin ve gerekirse "Geri Al" diyebilsin.
function belgeFormunuTemizle(sonKaydiGizle) {
  const duzenlemeVardi = !!duzenlenenBelge;
  belgeDuzenlemeGorunumunuSifirla();
  el('satirGovde').innerHTML = '';
  satirEkle();
  el('fisNo').value = '';
  el('tahsilat').value = '';
  el('tahsilatAciklama').value = '';
  if (duzenlemeVardi) el('belgeTarih').value = bugun();
  belgeCari.temizle();
  if (sonKaydiGizle) el('sonKayit').classList.add('gizli');
  toplamlariGuncelle();
}

el('formTemizle').addEventListener('click', () => {
  belgeFormunuTemizle(true);
  uyariKapat();
});

el('kaydetFatura').addEventListener('click', () => belgeKaydet('satisFaturasi'));
el('kaydetCariCikis').addEventListener('click', () => belgeKaydet('cariCikis'));

async function belgeKaydet(belgeTuru) {
  uyariKapat();

  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }

  const cari = belgeCari.secili();
  if (!cari) return bildir('Müşteri seçilmedi.', 'hata');
  if (duzenlenenBelge && duzenlenenBelge.belgeTuru !== belgeTuru) {
    return bildir('Düzenleme sırasında belge türü değiştirilemez.', 'hata');
  }

  const satirlar = [];
  for (const tr of el('satirGovde').children) {
    const s = satirOku(tr);
    if (!s || s.bos) continue;
    // Ürünsüz satıra izin var (05.09.2026 kullanıcı isteği: "ürün seçmeden
    // cariye giriş yapamıyorsun"): yalnız kasa verilen ya da yalnız tahsilat
    // alınan belge de kaydedilebilmeli. Ürün kutusuna bir şey yazılmışsa
    // listeden seçilmiş olması yine şart — yazım hatası sessizce geçmesin.
    const yalnizKasa = !s.etiket && s.kasaAdedi > 0;
    if (!s.stok && !yalnizKasa) {
      return bildir(
        s.etiket
          ? `"${s.etiket}" listede yok. Ürünü açılan listeden seçin.`
          : 'Ürünsüz satırda kasa adedi girilmeli.',
        'hata'
      );
    }
    if (s.stok && !(s.brutMiktar > 0)) {
      return bildir(`"${s.stok.ad}" için brüt miktar girilmedi.`, 'hata');
    }
    if (s.kasaAdedi > 0 && !s.kasaStokNo) {
      return bildir(
        (s.stok ? `"${s.stok.ad}" için ` : '') + 'kasa adedi var ama kasa tipi seçilmedi.',
        'hata'
      );
    }
    satirlar.push({
      stokNo: s.stok ? s.stok.stokNo : null,
      stokKodu: s.stok ? s.stok.kod : null,
      stokAdi: s.stok ? s.stok.ad : null,
      birim: s.stok ? s.stok.birim : null,
      birimEx: s.stok ? s.stok.birimEx : null,
      brutMiktar: s.brutMiktar,
      daraliMiktar: s.daraliMiktar,
      kasaAdedi: s.kasaAdedi,
      kasaDarasi: s.kasaDarasi,
      kasaStokNo: s.kasaStokNo,
      kasaTipiKod: s.kasaTipiKod,
      kasaTipiAdi: s.kasaTipiAdi,
      kasaDepozito: s.kasaDepozito,
      kasaTutari: s.kasaTutari,
      fiyat: s.fiyat,
      tutar: s.tutar,
      aciklama: s.aciklama
    });
  }

  const tahsilat = tutarOku(el('tahsilat').value);
  if (!satirlar.length && !(tahsilat > 0)) {
    return bildir('Belgeye en az bir satır ya da tahsilat girilmeli.', 'hata');
  }

  const dugmeler = [el('kaydetFatura'), el('kaydetCariCikis')];
  dugmeler.forEach((d) => { d.disabled = true; });

  try {
    const sonuc = await cagir('yazma:belge', {
      firma: firmaKodu(),
      donem: donemKodu(),
      tarih: el('belgeTarih').value || bugun(),
      cariInd: cari.cariInd,
      cariAd: cari.ad,
      belgeTuru,
      fisNo: el('fisNo').value.trim(),
      satirlar,
      tahsilat,
      tahsilatAciklama: el('tahsilatAciklama').value.trim(),
      duzenlenenIslemId: duzenlenenBelge ? duzenlenenBelge.islemId : null
    });

    bildir(
      (sonuc.duzenlendi ? `Vega'da güncellendi. Belge no: ${sonuc.belgeNo}`
                        : `Vega'ya yazıldı. Belge no: ${sonuc.belgeNo}`) +
      (sonuc.kasaBelgeNo ? ` · Kasa: ${sonuc.kasaBelgeNo}` : '') +
      (sonuc.tahsilatBelgeNo ? ` · Tahsilat: ${sonuc.tahsilatBelgeNo}` : ''),
      'basarili'
    );
    sonKaydiGoster(sonuc, belgeTuru);
    // 05.09.2026 kullanıcı isteği: kayıttan sonra sıradaki müşteriye hemen
    // geçilebilsin — ürün satırları ve önceki müşteri ekranda kalmasın.
    belgeFormunuTemizle(false);
    belgeCari.odakla();
  } catch (e) {
    bildir("Vega'ya yazılamadı: " + e.message, 'hata');
  } finally {
    dugmeler.forEach((d) => { d.disabled = false; });
  }
}

function sonKaydiGoster(sonuc, belgeTuru) {
  const kutu = el('sonKayit');
  kutu.classList.remove('gizli');
  kutu.innerHTML = '';

  const baslik = document.createElement('h2');
  baslik.textContent = sonuc.duzenlendi ? 'Güncellenen Belge' : 'Kaydedilen Belge';
  const bilgi = document.createElement('p');
  bilgi.className = 'ipucu';
  bilgi.textContent =
    (belgeTuru === 'satisFaturasi' ? 'Satış Faturası' : 'Cari Giriş') +
    ` · Belge no: ${sonuc.belgeNo} · ${para(sonuc.toplam)} TL`;

  const eylem = document.createElement('div');
  eylem.className = 'eylemler sol';

  if (durum.yazmaAcik) {
    const geri = document.createElement('button');
    geri.type = 'button';
    geri.className = 'dugme mini tehlike';
    geri.textContent = 'Bu Belgeyi Geri Al';
    geri.addEventListener('click', async () => {
      const onay = await cagir('onay', {
        baslik: 'Vega kaydını geri al',
        mesaj: `Belge no ${sonuc.belgeNo} Vega'dan silinecek.`,
        ayrinti: 'Bu belgenin satış/cari kayıtları ve stok hareketleri silinir. Müşterinin bakiyesi işlem öncesi haline döner.',
        tamamBaslik: 'Geri al'
      });
      if (!onay.onaylandi) return;
      geri.disabled = true;
      try {
        const r = await cagir('yazma:belgeGeriAl', { islemId: sonuc.islemId });
        bildir(`Geri alındı (${r.silinenSatir} satır silindi).`, 'basarili');
        kutu.classList.add('gizli');
        await belgeCari.yenile();
      } catch (e) {
        bildir('Geri alınamadı: ' + e.message, 'hata');
        geri.disabled = false;
      }
    });
    eylem.appendChild(geri);
  }

  const yeni = document.createElement('button');
  yeni.type = 'button';
  yeni.className = 'dugme ikincil';
  yeni.textContent = 'Yeni Belge';
  yeni.addEventListener('click', () => el('formTemizle').click());
  eylem.appendChild(yeni);

  kutu.append(baslik, bilgi, eylem);
}

// ═══════════════════════ ALIŞ FATURASI ═══════════════════════
//
// 30.09.2026 müşteri isteği: gelen alış faturaları basitçe girilsin. Belge
// Gir'deki kasa/dara hesabı yok: ürün, miktar, KDV hariç birim fiyat. Satır
// tablosu ve klavye düzeni Belge Gir'e benzer ama ayrı — iki formun
// hesapları birbirine karışmasın.

let alisDuzenleme = null;   // { islemId }

function alisKdvVarsayilani() {
  if (!el('alisKdv').value.trim()) el('alisKdv').value = String(kdvOraniOku()).replace('.', ',');
}

function alisSatirEkle(odakla) {
  const govde = el('alisSatirGovde');
  const tr = document.createElement('tr');

  const stokHucre = document.createElement('td');
  const stok = document.createElement('input');
  stok.type = 'text';
  stok.placeholder = 'Ürün adı yazın…';
  stok.autocomplete = 'off';
  stokHucre.appendChild(stok);

  const sayiHucresi = (yerTutucu) => {
    const td = document.createElement('td');
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'sayi';
    i.inputMode = 'decimal';
    i.autocomplete = 'off';
    i.placeholder = yerTutucu;
    td.appendChild(i);
    return { td, girdi: i };
  };
  const miktar = sayiHucresi('miktar');
  const birimHucre = document.createElement('td');
  birimHucre.className = 'hesaplanan';
  const fiyat = sayiHucresi('TL');
  tutarGirdisiBagla(fiyat.girdi);
  const tutarHucre = document.createElement('td');
  tutarHucre.className = 'hesaplanan';
  tutarHucre.textContent = '0,00';

  const silHucre = document.createElement('td');
  silHucre.className = 'sayi';
  const sil = document.createElement('button');
  sil.type = 'button';
  sil.className = 'dugme mini ucuncul';
  sil.textContent = 'Sil';
  sil.tabIndex = -1;
  sil.addEventListener('click', () => {
    tr.remove();
    if (!govde.children.length) alisSatirEkle(true);
    alisToplamlariGuncelle();
  });
  silHucre.appendChild(sil);

  tr.append(stokHucre, miktar.td, birimHucre, fiyat.td, tutarHucre, silHucre);
  govde.appendChild(tr);

  tr._alis = { stokGirdi: stok, miktarGirdi: miktar.girdi, fiyatGirdi: fiyat.girdi, birimHucre, tutarHucre };
  tr._alis.stokKutusu = stokKutusuKur(stok, stokHucre, () => {
    alisToplamlariGuncelle();
    miktar.girdi.focus();
    miktar.girdi.select();
  });

  for (const i of [stok, miktar.girdi, fiyat.girdi]) {
    i.addEventListener('input', alisToplamlariGuncelle);
    i.addEventListener('keydown', (olay) => alisSatirKlavyesi(olay, tr, i));
  }
  if (odakla !== false) stok.focus();
  return tr;
}

function alisSatirAlanlari(tr) {
  const a = tr._alis;
  return a ? [a.stokGirdi, a.miktarGirdi, a.fiyatGirdi] : [];
}

function alisKomsuSatiraGec(tr, girdi, yon) {
  const sutun = Math.max(0, alisSatirAlanlari(tr).indexOf(girdi));
  let hedef = yon > 0 ? tr.nextElementSibling : tr.previousElementSibling;
  if (yon > 0 && !hedef) hedef = alisSatirEkle(false);
  if (!hedef || !hedef._alis) return;
  const secilen = alisSatirAlanlari(hedef)[sutun];
  secilen.focus();
  secilen.select();
}

// Klavye Belge Gir'deki gibi: ↓/Enter alt satır (sonda yeni satır), ↑ üst
// satır, fiyatta Tab sonraki satırın ürün kutusu. Ürün listesi açıkken
// ↑/↓ listede gezinir, Enter/Tab seçer.
function alisSatirKlavyesi(olay, tr, girdi) {
  const kutu = tr._alis.stokKutusu;
  const urunKutusunda = girdi === tr._alis.stokGirdi;
  if (olay.key === 'ArrowDown' || olay.key === 'ArrowUp') {
    olay.preventDefault();
    if (urunKutusunda && kutu.acikMi()) return kutu.imleciTasi(olay.key === 'ArrowDown' ? 1 : -1);
    return alisKomsuSatiraGec(tr, girdi, olay.key === 'ArrowDown' ? 1 : -1);
  }
  if (olay.key === 'Enter') {
    olay.preventDefault();
    if (urunKutusunda && kutu.secimiOnayla()) return;
    return alisKomsuSatiraGec(tr, girdi, 1);
  }
  if (olay.key === 'Tab' && urunKutusunda && kutu.acikMi()) {
    if (kutu.secimiOnayla()) olay.preventDefault();
    return;
  }
  if (olay.key === 'Tab' && !olay.shiftKey && girdi === tr._alis.fiyatGirdi) {
    olay.preventDefault();
    const sonraki = tr.nextElementSibling || alisSatirEkle(false);
    sonraki._alis.stokGirdi.focus();
    sonraki._alis.stokGirdi.select();
    return;
  }
  if (olay.key === 'Escape') kutu.kapat();
}

function alisSatirOku(tr) {
  const a = tr._alis;
  const etiket = a.stokGirdi.value.trim();
  const stok = durum.stokHaritasi.get(etiket) || null;
  const miktar = sayiOku(a.miktarGirdi.value);
  const fiyat = tutarOku(a.fiyatGirdi.value);
  return {
    etiket, stok, miktar, fiyat,
    tutar: Math.round(miktar * fiyat * 100) / 100,
    bos: !etiket && !miktar && !fiyat
  };
}

// KDV, yazma.js → alisFaturasiKaydet'teki formülle aynı: satır başına
// Math.round(tutar * oran) / 100.
function alisToplamlariGuncelle() {
  const kdvOrani = sayiOku(el('alisKdv').value);
  let ara = 0;
  let kdv = 0;
  for (const tr of el('alisSatirGovde').children) {
    const s = alisSatirOku(tr);
    tr._alis.stokGirdi.style.borderColor = s.etiket && !s.stok ? '#f87171' : '';
    tr._alis.birimHucre.textContent = s.stok ? (s.stok.birim || '') : '';
    tr._alis.tutarHucre.textContent = para(s.tutar);
    ara += s.tutar;
    kdv += kdvOrani ? Math.round(s.tutar * kdvOrani) / 100 : 0;
  }
  el('alisAraToplam').textContent = para(ara);
  el('alisKdvToplam').textContent = para(kdv);
  el('alisGenelToplam').textContent = para(ara + kdv);
}

function alisFormunuTemizle() {
  alisDuzenleme = null;
  el('alisDuzenlemeBilgi').classList.add('gizli');
  el('alisDuzenlemeBilgi').textContent = '';
  el('alisKaydet').textContent = 'Alış Faturasını Kaydet';
  el('alisTemizle').textContent = 'Formu Temizle';
  el('alisSatirGovde').innerHTML = '';
  alisSatirEkle(false);
  el('alisFaturaNo').value = '';
  el('alisAciklama').value = '';
  el('alisTarih').value = bugun();
  el('alisKdv').value = '';
  alisKdvVarsayilani();
  alisCari.temizle();
  alisToplamlariGuncelle();
}

function alisDuzenlemeyiAc(d) {
  sekmeAc('alis');
  alisFormunuTemizle();
  alisCari.sec(d.cari);
  el('alisTarih').value = tarihKutusu(d.tarih);
  el('alisFaturaNo').value = d.faturaNo || '';
  el('alisAciklama').value = d.aciklama || '';
  el('alisKdv').value = String(d.kdvOrani || 0).replace('.', ',');
  el('alisSatirGovde').innerHTML = '';
  for (const s of d.satirlar) {
    const tr = alisSatirEkle(false);
    const secenek = durum.stokSecenekleri.find((x) => Number(x.kart.stokNo) === Number(s.stokNo));
    tr._alis.stokGirdi.value = secenek ? secenek.etiket : (s.stokAdi || '');
    sayiGirdisineYaz(tr._alis.miktarGirdi, s.miktar);
    sayiGirdisineYaz(tr._alis.fiyatGirdi, s.fiyat);
  }
  if (!d.satirlar.length) alisSatirEkle(false);

  alisDuzenleme = { islemId: Number(d.islemId) };
  const bilgi = el('alisDuzenlemeBilgi');
  bilgi.textContent = `${d.cari.ad} · ${d.faturaNo || 'fatura no yok'} alış faturası düzenleniyor. ` +
    'Kaydetme tamamlanmazsa eski fatura aynen korunur.';
  bilgi.classList.remove('gizli');
  el('alisKaydet').textContent = 'Değişiklikleri Kaydet';
  el('alisTemizle').textContent = 'Düzenlemeyi İptal Et';
  alisToplamlariGuncelle();
  bildir('Alış faturası düzenlemeye açıldı. Düzeltip Değişiklikleri Kaydet’e basın.', '');
}

el('alisSatirEkle').addEventListener('click', () => alisSatirEkle(true));
el('alisKdv').addEventListener('input', () => alisToplamlariGuncelle());
el('alisTemizle').addEventListener('click', () => { alisFormunuTemizle(); uyariKapat(); });
el('alisKaydet').addEventListener('click', () => alisKaydet());

async function alisKaydet() {
  uyariKapat();
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  const cari = alisCari.secili();
  if (!cari) return bildir('Tedarikçi seçilmedi.', 'hata');

  const satirlar = [];
  for (const tr of el('alisSatirGovde').children) {
    const s = alisSatirOku(tr);
    if (s.bos) continue;
    if (!s.stok) {
      return bildir(s.etiket ? `"${s.etiket}" listede yok. Ürünü açılan listeden seçin.`
                             : 'Ürünü seçilmemiş satır var.', 'hata');
    }
    if (!(s.miktar > 0)) return bildir(`"${s.stok.ad}" için miktar girilmedi.`, 'hata');
    if (!(s.fiyat > 0)) return bildir(`"${s.stok.ad}" için birim fiyat girilmedi.`, 'hata');
    satirlar.push({
      stokNo: s.stok.stokNo, stokKodu: s.stok.kod, stokAdi: s.stok.ad,
      birim: s.stok.birim, birimEx: s.stok.birimEx, carpan: s.stok.carpan,
      miktar: s.miktar, fiyat: s.fiyat
    });
  }
  if (!satirlar.length) return bildir('Faturaya en az bir ürün satırı girilmeli.', 'hata');

  const dugme = el('alisKaydet');
  dugme.disabled = true;
  try {
    const sonuc = await cagir('yazma:alisFaturasi', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      cariAd: cari.ad,
      tarih: el('alisTarih').value || bugun(),
      faturaNo: el('alisFaturaNo').value.trim(),
      aciklama: el('alisAciklama').value.trim(),
      kdvOrani: sayiOku(el('alisKdv').value),
      satirlar,
      duzenlenenIslemId: alisDuzenleme ? alisDuzenleme.islemId : null
    });
    bildir(
      (sonuc.duzenlendi ? "Alış faturası Vega'da düzeltildi: " : "Alış faturası Vega'ya yazıldı: ") +
      `${cari.ad} · ${para(sonuc.toplam)} TL` +
      (sonuc.faturaNo ? ` · Fatura no: ${sonuc.faturaNo}` : '') +
      ` · Belge no: ${sonuc.belgeNo}`,
      'basarili'
    );
    alisFormunuTemizle();
    alisCari.odakla();
  } catch (e) {
    bildir("Alış faturası Vega'ya yazılamadı: " + e.message, 'hata');
  } finally {
    dugme.disabled = false;
  }
}

// ═══════════════════════ KASA ═══════════════════════

function kasaKartiSecimDoldur(secim) {
  const eski = secim.value;
  secim.innerHTML = '';
  const bos = document.createElement('option');
  bos.value = '';
  bos.textContent = '— seçin —';
  secim.appendChild(bos);
  for (const k of durum.kasaKartlari) {
    const o = document.createElement('option');
    o.value = String(k.id);
    o.textContent = k.kod;
    secim.appendChild(o);
  }
  if (eski && durum.kasaKartlari.some((k) => String(k.id) === eski)) secim.value = eski;
}

function kasaIadeTutariHesapla(acikAdet, acikTutar, iadeAdet) {
  const acik = Number(acikAdet) || 0;
  const tutar = Number(acikTutar) || 0;
  const adet = Number(iadeAdet) || 0;
  if (!(adet > 0) || !(acik > 0) || adet > acik) return 0;
  if (Math.abs(adet - acik) < 0.0005) return tutar;
  return Math.round((tutar / acik) * adet * 100) / 100;
}

// ─── Kasa iadesi satırları ───
//
// 03.10.2026 müşteri isteği: aynı fişte ikinci (üçüncü…) kasa tipi için satır
// eklenebilsin, her satırda kasanın geri alındığı birim fiyat girilebilsin.
// Birim fiyat kasa tipi seçilince müşterideki açık depozitonun birim
// fiyatıyla dolar; kullanıcı değiştirmezse sunucuya gönderilmez (eski
// davranış, fark yok). Düşük fiyat girilirse depozito yine tamamen kapanır,
// aradaki fark ayrı dekontla yazılır (bkz. db/yazma.js → kasaIadesiYaz).

// Seçili müşterinin açık kasaları (yardimci:kasaBakiye) — satır hesapları için.
let iadeAcikKasalar = [];

function iadeSatirEkle(odakla) {
  const govde = el('iadeSatirGovde');
  const tr = document.createElement('tr');

  const tipHucre = document.createElement('td');
  const tip = document.createElement('select');
  kasaKartiSecimDoldur(tip);
  tipHucre.appendChild(tip);

  const acikHucre = document.createElement('td');
  acikHucre.className = 'hesaplanan';

  const girdiHucresi = (yerTutucu) => {
    const td = document.createElement('td');
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'sayi';
    i.inputMode = 'decimal';
    i.autocomplete = 'off';
    i.placeholder = yerTutucu;
    td.appendChild(i);
    return { td, girdi: i };
  };
  const adet = girdiHucresi('adet');
  const fiyat = girdiHucresi('TL');
  tutarGirdisiBagla(fiyat.girdi);

  const depozitoHucre = document.createElement('td');
  depozitoHucre.className = 'hesaplanan';
  const farkHucre = document.createElement('td');
  farkHucre.className = 'hesaplanan';

  const silHucre = document.createElement('td');
  silHucre.className = 'sayi';
  const sil = document.createElement('button');
  sil.type = 'button';
  sil.className = 'dugme mini ucuncul';
  sil.textContent = 'Sil';
  sil.tabIndex = -1;
  sil.addEventListener('click', () => {
    tr.remove();
    if (!govde.children.length) iadeSatirEkle(false);
    iadeSatirlariniHesapla();
  });
  silHucre.appendChild(sil);

  tr.append(tipHucre, acikHucre, adet.td, fiyat.td, depozitoHucre, farkHucre, silHucre);
  govde.appendChild(tr);

  // fiyatElle: kullanıcı birim fiyatı kendisi yazdı mı. Yazmadıysa kasa
  // tipi değişince açık depozitonun birim fiyatı yeniden gelir.
  tr._iade = {
    tipSecim: tip, adetGirdi: adet.girdi, fiyatGirdi: fiyat.girdi,
    acikHucre, depozitoHucre, farkHucre, fiyatElle: false, varsayilanFiyat: null
  };

  tip.addEventListener('change', () => {
    tr._iade.fiyatElle = false;
    iadeSatirlariniHesapla();
  });
  adet.girdi.addEventListener('input', () => iadeSatirlariniHesapla());
  fiyat.girdi.addEventListener('input', () => {
    tr._iade.fiyatElle = fiyat.girdi.value.trim() !== '';
    iadeSatirlariniHesapla();
  });
  for (const girdi of [adet.girdi, fiyat.girdi]) {
    girdi.addEventListener('keydown', (olay) => {
      if (olay.key === 'Enter') el('iadeKaydet').click();
    });
  }

  iadeSatirlariniHesapla();
  if (odakla !== false) tip.focus();
  return tr;
}

function iadeSatirlari() {
  return [...el('iadeSatirGovde').children].filter((tr) => tr._iade);
}

// Bir satır boş mu (kasa tipi ve adet ikisi de girilmemiş).
function iadeSatiriBosMu(s) {
  return !s.tipSecim.value && !sayiOku(s.adetGirdi.value);
}

// Açık adet/tutar satır sırasıyla düşülür: aynı tip iki satıra yazılırsa
// ikinci satır birincinin kalanını görür (sunucu da aynı sırayla denetler).
// Düzenlemede, düzenlenen iadenin kendisi açık kasaya geri eklenir.
function iadeAcikKasaHaritasi() {
  const harita = new Map();
  for (const k of iadeAcikKasalar) {
    harita.set(Number(k.stokNo), { adet: Number(k.acikAdet) || 0, tutar: Number(k.acikTutar) || 0 });
  }
  if (iadeDuzenleme && iadeDuzenleme.stokNo) {
    const no = Number(iadeDuzenleme.stokNo);
    const k = harita.get(no) || { adet: 0, tutar: 0 };
    harita.set(no, { adet: k.adet + iadeDuzenleme.adet, tutar: k.tutar + iadeDuzenleme.tutar });
  }
  return harita;
}

function iadeSatirlariniHesapla() {
  const harita = iadeAcikKasaHaritasi();
  for (const tr of iadeSatirlari()) {
    const s = tr._iade;
    const stokNo = Number(s.tipSecim.value);
    const acik = stokNo ? (harita.get(stokNo) || { adet: 0, tutar: 0 }) : null;
    s.acikHucre.textContent = acik ? miktarYaz(acik.adet) : '';
    s.depozitoHucre.textContent = '';
    s.farkHucre.textContent = '';
    s.depozitoHucre.classList.remove('hata');
    s.farkHucre.classList.remove('hata');
    s.varsayilanFiyat = null;
    if (!acik) continue;

    const birimDepozito = acik.adet > 0 ? Math.round((acik.tutar / acik.adet) * 100) / 100 : 0;
    s.varsayilanFiyat = birimDepozito;
    if (!s.fiyatElle) sayiGirdisineYaz(s.fiyatGirdi, birimDepozito);

    const adet = sayiOku(s.adetGirdi.value);
    if (!(adet > 0)) continue;
    if (adet > acik.adet + 0.0005) {
      s.depozitoHucre.textContent = `açık ${miktarYaz(acik.adet)}`;
      s.depozitoHucre.classList.add('hata');
      continue;
    }
    const kapanacak = kasaIadeTutariHesapla(acik.adet, acik.tutar, adet);
    s.depozitoHucre.textContent = para(kapanacak);
    const fiyatMetni = s.fiyatGirdi.value.trim();
    if (s.fiyatElle && fiyatMetni) {
      const fark = Math.round((kapanacak - tutarOku(fiyatMetni) * adet) * 100) / 100;
      if (Math.abs(fark) > Math.max(0.01, adet * 0.005)) {
        // Eksi fark: fiyat açık depozitodan yüksek — sunucu reddeder.
        s.farkHucre.textContent = para(fark);
        s.farkHucre.classList.toggle('hata', fark < 0);
      }
    }
    // Sonraki aynı tip satır kalan açıkla hesaplansın.
    harita.set(stokNo, {
      adet: acik.adet - adet,
      tutar: Math.round((acik.tutar - kapanacak) * 100) / 100
    });
  }
}

async function iadeBilgisiniGuncelle() {
  const bilgi = el('iadeBilgi');
  const cari = iadeCari.secili();
  if (!cari) {
    iadeAcikKasalar = [];
    bilgi.textContent = '';
    iadeSatirlariniHesapla();
    return;
  }
  try {
    iadeAcikKasalar = await cagir('yardimci:kasaBakiye', { firma: firmaKodu(), cariInd: cari.cariInd });
    bilgi.textContent = iadeAcikKasalar.length
      ? 'Açık kasalar: ' + iadeAcikKasalar
          .map((k) => `${k.kasaTipiKod} ${miktarYaz(k.acikAdet)} adet (${para(k.acikTutar)} TL)`)
          .join(' · ')
      : 'Bu müşteride açık kasa görünmüyor.';
  } catch (e) {
    iadeAcikKasalar = [];
    bilgi.textContent = 'Kasa bakiyesi okunamadı: ' + e.message;
  }
  iadeSatirlariniHesapla();
}

// Formdaki kasa satırlarını temizler, tek boş satır bırakır.
function iadeSatirlariniSifirla() {
  el('iadeSatirGovde').innerHTML = '';
  iadeSatirEkle(false);
}

el('iadeSatirEkle').addEventListener('click', () => iadeSatirEkle());

// Kasa iadesi düzeltme (30.09.2026 müşteri isteği: "düşülen paraları
// düzeltemiyoruz"). Son Belgeler'deki ✎ iadeyi bu forma açar; kaydedince eski
// iade silinip yenisi aynı transaction'da yazılır. Düzenlenen iade tek
// satırdır; düzenlemede satır eklenmez.
let iadeDuzenleme = null;

function iadeDuzenlemesiniKapat() {
  iadeDuzenleme = null;
  el('iadeDuzenlemeBilgi').classList.add('gizli');
  el('iadeDuzenlemeBilgi').textContent = '';
  el('iadeKaydet').textContent = 'İadeyi Kaydet';
  el('iadeDuzenlemeIptal').classList.add('gizli');
  el('iadeSatirEkle').classList.remove('gizli');
}

// Kasa tipleri yüklenince satırlardaki seçim kutuları tazelenir.
function iadeSatirSecimleriniTazele() {
  for (const tr of iadeSatirlari()) kasaKartiSecimDoldur(tr._iade.tipSecim);
  iadeSatirlariniHesapla();
}

iadeSatirlariniSifirla();

el('iadeDuzenlemeIptal').addEventListener('click', () => {
  iadeDuzenlemesiniKapat();
  iadeSatirlariniSifirla();
  el('iadeFisNo').value = '';
  el('iadeTarih').value = bugun();
  uyariKapat();
});

async function kasaIadeDuzenlemeyiAc(d) {
  const kasa = durum.kasaKartlari.find((k) => Number(k.id) === Number(d.stokNo));
  if (!kasa) {
    throw new Error(`${d.stokKodu || 'Bu'} kasa tipi artık listede yok; iade düzenlenemez, geri alınabilir.`);
  }
  sekmeAc('kasa');
  iadeDuzenleme = {
    islemId: Number(d.islemId),
    stokNo: Number(kasa.id),
    adet: Number(d.adet) || 0,
    tutar: Number(d.tutar) || 0
  };
  iadeCari.sec(d.cari);

  el('iadeSatirGovde').innerHTML = '';
  const tr = iadeSatirEkle(false);
  const s = tr._iade;
  s.tipSecim.value = String(kasa.id);
  sayiGirdisineYaz(s.adetGirdi, d.adet);
  if (d.birimFiyat != null) {
    sayiGirdisineYaz(s.fiyatGirdi, d.birimFiyat);
    s.fiyatElle = true;
  }
  el('iadeTarih').value = tarihKutusu(d.tarih);
  el('iadeFisNo').value = d.fisNo || '';

  const bilgi = el('iadeDuzenlemeBilgi');
  bilgi.textContent = `${d.cari.ad} · ${miktarYaz(d.adet)} adet ${d.stokKodu || ''} kasa iadesi düzenleniyor. ` +
    'Kaydetme tamamlanmazsa eski iade aynen korunur.';
  bilgi.classList.remove('gizli');
  el('iadeKaydet').textContent = 'Değişiklikleri Kaydet';
  el('iadeDuzenlemeIptal').classList.remove('gizli');
  el('iadeSatirEkle').classList.add('gizli');
  iadeBilgisiniGuncelle();
  bildir('Kasa iadesi düzenlemeye açıldı. Düzeltip Değişiklikleri Kaydet’e basın.', '');
}

el('iadeKaydet').addEventListener('click', async () => {
  uyariKapat();
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  const cari = iadeCari.secili();
  if (!cari) return bildir('Müşteri seçilmedi.', 'hata');

  const dolu = iadeSatirlari().map((tr) => tr._iade).filter((s) => !iadeSatiriBosMu(s));
  if (!dolu.length) return bildir('Kasa tipi ve iade adedi girilmedi.', 'hata');
  const satirlar = [];
  for (const [i, s] of dolu.entries()) {
    const sira = dolu.length > 1 ? `${i + 1}. satır: ` : '';
    const stokNo = Number(s.tipSecim.value);
    if (!stokNo) return bildir(sira + 'Kasa tipi seçilmedi.', 'hata');
    const adet = sayiOku(s.adetGirdi.value);
    if (!(adet > 0)) return bildir(sira + 'İade adedi sıfırdan büyük olmalı.', 'hata');
    const kasa = durum.kasaKartlari.find((k) => k.id === stokNo);
    // Kullanıcı fiyatı değiştirmediyse gönderilmez: sunucu açık depozitonun
    // kuruşu kuruşuna tam değeriyle yazar.
    const fiyatMetni = s.fiyatGirdi.value.trim();
    let birimFiyat = null;
    if (s.fiyatElle && fiyatMetni) {
      birimFiyat = tutarOku(fiyatMetni);
      if (s.varsayilanFiyat != null && Math.abs(birimFiyat - s.varsayilanFiyat) < 0.005) birimFiyat = null;
    }
    satirlar.push({
      stokNo,
      stokKodu: kasa ? kasa.kod : null,
      stokAdi: kasa ? kasa.ad : null,
      adet,
      birimFiyat
    });
  }

  const dugme = el('iadeKaydet');
  dugme.disabled = true;
  try {
    const sonuc = await cagir('yazma:kasaIade', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      cariAd: cari.ad,
      satirlar,
      tarih: el('iadeTarih').value || bugun(),
      fisNo: el('iadeFisNo').value.trim(),
      duzenlenenIslemId: iadeDuzenleme ? iadeDuzenleme.islemId : null
    });

    const parcalar = (sonuc.satirlar || []).map((s) => {
      let m = `${s.stokKodu || 'Kasa'} ${miktarYaz(s.adet)} adet, ${para(s.tutar)} TL depozito kapandı`;
      if (s.fark > 0) {
        m += ` (stoğa ${para(s.birimFiyat)} TL'den ${para(s.fisTutari)} TL, fark ${para(s.fark)} TL)`;
      }
      m += `, kalan ${miktarYaz(s.kalanAdet)} adet`;
      const nolar = [s.belgeNo, s.farkBelgeNo].filter(Boolean).join(' / ');
      if (nolar) m += ` · Vega belge no: ${nolar}`;
      return m;
    });
    bildir((sonuc.duzenlendi ? 'İade düzeltildi: ' : 'İade kaydedildi: ') + parcalar.join(' — ') + '.', 'basarili');

    if (iadeDuzenleme) {
      iadeDuzenlemesiniKapat();
      el('iadeTarih').value = bugun();
    }
    iadeSatirlariniSifirla();
    el('iadeFisNo').value = '';
    await iadeBilgisiniGuncelle();
    await iadeCari.yenile();
    kasaBakiyesiniYukle();
  } catch (e) {
    bildir("Vega'ya yazılamadı: " + e.message, 'hata');
  } finally {
    dugme.disabled = false;
  }
});

el('kasaYenile').addEventListener('click', () => kasaBakiyesiniYukle());

async function kasaBakiyesiniYukle() {
  const govde = el('kasaGovde');
  if (!firmaSecildiMi()) {
    return boslukTemizle(govde, 4, 'Önce Ayarlar ekranından firma ve dönem seçin.');
  }
  try {
    const liste = await cagir('yardimci:kasaBakiye', { firma: firmaKodu() });
    if (!liste.length) {
      return boslukTemizle(govde, 4, 'Müşterilerde açık kasa yok.');
    }
    govde.innerHTML = '';
    let toplamTutar = 0;
    for (const k of liste) {
      const tr = document.createElement('tr');
      const hucreler = [
        [k.cariAd || '#' + k.cariInd, ''],
        [k.kasaTipiKod, ''],
        [miktarYaz(k.acikAdet), 'sayi'],
        [para(k.acikTutar), 'sayi']
      ];
      for (const [metin, sinif] of hucreler) {
        const td = document.createElement('td');
        if (sinif) td.className = sinif;
        td.textContent = metin;
        tr.appendChild(td);
      }
      govde.appendChild(tr);
      toplamTutar += k.acikTutar;
    }
    const tr = document.createElement('tr');
    const bos = document.createElement('td');
    bos.colSpan = 3;
    const t = document.createElement('td');
    t.className = 'sayi';
    const b = document.createElement('b');
    b.textContent = para(toplamTutar) + ' TL';
    t.appendChild(b);
    tr.append(bos, t);
    govde.appendChild(tr);
  } catch (e) {
    boslukTemizle(govde, 4, 'Okunamadı: ' + e.message);
  }
}

// ═══════════════════════ SON BELGELER ═══════════════════════
//
// Yazılan her belge tek adımda VEGADB'ye gittiği için burada "gönder" diye
// bir işlem yok — yalnızca ne yazıldığının kısa günlüğü ve gerektiğinde
// tek tuşla geri alma.

el('belgelerYenile').addEventListener('click', () => belgelerYukle());

// Arama kutusu boşken son 200 belge listelenir. Bir şey yazılınca arama
// sunucuda, bütün günlükte ve Vega'nın kendi belgelerinde yapılır (17.09.2026:
// 200'den eski fiş no bulunamıyordu); sıralama yine burada, müşteri kutusundaki
// mantıkla: kelimeler ayrı ayrı, sırası önemsiz, Türkçe harf duyarsız.
let belgelerListesi = [];
let belgeAramaSonucu = null;   // null = arama yok, son belgeler gösteriliyor
let belgeAramaSirasi = 0;
let belgeAramaZamani = null;

async function belgelerYukle() {
  const govde = el('belgelerGovde');
  if (!firmaSecildiMi()) {
    belgelerListesi = [];
    return boslukTemizle(govde, 9, 'Önce Ayarlar ekranından firma ve dönem seçin.');
  }
  try {
    belgelerListesi = await cagir('yardimci:sonIslemler', { firma: firmaKodu(), limit: 200 });
    if (el('belgelerArama').value.trim()) return belgeAra();
    belgeAramaSonucu = null;
    belgeleriCiz();
  } catch (e) {
    belgelerListesi = [];
    boslukTemizle(govde, 9, 'Okunamadı: ' + e.message);
  }
}

async function belgeAra() {
  const metin = el('belgelerArama').value.trim();
  const sira = ++belgeAramaSirasi;
  if (!metin) {
    belgeAramaSonucu = null;
    return belgeleriCiz();
  }
  if (!firmaSecildiMi()) return;
  el('belgelerBilgi').textContent = 'Aranıyor…';
  try {
    const sonuc = await cagir('yardimci:sonIslemler', {
      firma: firmaKodu(), donem: donemKodu(), limit: 300, arama: metin
    });
    if (sira !== belgeAramaSirasi) return; // arkadan yazılan arama daha yeni
    belgeAramaSonucu = sonuc;
    belgeleriCiz();
  } catch (e) {
    if (sira !== belgeAramaSirasi) return;
    belgeAramaSonucu = [];
    boslukTemizle(el('belgelerGovde'), 9, 'Arama yapılamadı: ' + e.message);
  }
}

function belgeTuruAdi(konu) {
  if (konu === 'satisFaturasi') return 'Satış Faturası';
  if (konu === 'alisFaturasi') return 'Alış Faturası';
  if (konu === 'vegaAlisFaturasi') return 'Alış Faturası (Vega)';
  if (konu === 'cariCikis') return 'Cari Giriş';
  if (konu === 'tahsilat') return 'Tahsilat';
  if (konu === 'KasaIade') return 'Kasa İadesi';
  if (konu === 'vegaSatisFaturasi') return 'Satış Faturası (Vega)';
  if (konu === 'vegaCariGiris') return 'Cari Giriş (Vega)';
  if (konu === 'vegaCariCikis') return 'Cari Çıkış (Vega)';
  return konu || '';
}

function sayiGirdisineYaz(girdi, deger) {
  const n = Number(deger) || 0;
  const metin = n ? String(n).replace('.', ',') : '';
  girdi.value = girdi.dataset.tutar ? tutarBicimle(metin) : metin;
}

// Son Belgeler ve Ödeme Geçmişi'ndeki ✎ — kaydın türüne göre doğru formu açar.
const DUZENLENEBILIR_KONULAR = ['satisFaturasi', 'cariCikis', 'tahsilat', 'KasaIade', 'alisFaturasi'];

async function belgeDuzenlemeyiAc(islemId) {
  try {
    const d = await cagir('yardimci:islemDetay', { islemId });
    if (d.firma !== firmaKodu() || d.donem !== donemKodu()) {
      throw new Error('Bu kayıt başka firma/döneme ait. Önce Ayarlar ekranından o dönemi seçin.');
    }
    if (d.tur === 'odeme') return odemeDuzenlemeyiAc(d);
    if (d.tur === 'kasaIade') return await kasaIadeDuzenlemeyiAc(d);
    if (d.tur === 'alisFaturasi') return alisDuzenlemeyiAc(d);

    sekmeAc('belge');
    belgeFormunuTemizle(true);
    el('belgeTarih').value = tarihKutusu(d.tarih);
    el('fisNo').value = d.fisNo || '';
    sayiGirdisineYaz(el('tahsilat'), d.tahsilat);
    el('tahsilatAciklama').value = d.tahsilatAciklama || '';
    el('kdvDahil').checked = false; // Günlükte saklanan fiyat zaten net fiyattır.
    belgeCari.sec(d.cari);

    el('satirGovde').innerHTML = '';
    for (const s of d.satirlar) {
      const tr = satirEkle();
      const a = tr._satir;
      const stokSecenegi = durum.stokSecenekleri.find((x) =>
        Number(x.kart.stokNo) === Number(s.stokNo) ||
        (s.stokKodu && x.kart.kod === s.stokKodu)
      );
      a.stokGirdi.value = stokSecenegi ? stokSecenegi.etiket : (s.stokAdi || '');
      sayiGirdisineYaz(a.brutMiktarGirdi, s.brutMiktar);
      sayiGirdisineYaz(a.kasaAdediGirdi, s.kasaAdedi);
      sayiGirdisineYaz(a.fiyatGirdi, s.fiyat);
      a.aciklamaGirdi.value = s.aciklama || '';
      const kasa = durum.kasaKartlari.find((k) =>
        Number(k.id) === Number(s.kasaStokNo) ||
        (s.kasaTipiKod && sadelestir(k.kod) === sadelestir(s.kasaTipiKod))
      );
      a.tipSecim.value = kasa ? String(kasa.id) : '';
    }
    if (!d.satirlar.length) satirEkle();

    duzenlenenBelge = { islemId: Number(d.islemId), belgeTuru: d.belgeTuru };
    const bilgi = el('belgeDuzenlemeBilgi');
    bilgi.textContent = `${d.cari.ad} · ${d.fisNo || 'fiş no yok'} belgesi düzenleniyor. ` +
      'Kaydetme tamamlanmazsa eski belge aynen korunur.';
    bilgi.classList.remove('gizli');
    const asil = d.belgeTuru === 'satisFaturasi' ? el('kaydetFatura') : el('kaydetCariCikis');
    const diger = d.belgeTuru === 'satisFaturasi' ? el('kaydetCariCikis') : el('kaydetFatura');
    asil.textContent = 'Değişiklikleri Kaydet';
    diger.classList.add('gizli');
    el('formTemizle').textContent = 'Düzenlemeyi İptal Et';
    toplamlariGuncelle();
    bildir('Belge düzenlemeye açıldı. Kiloyu düzeltip Değişiklikleri Kaydet’e basın.', '');
  } catch (e) {
    bildir('Düzenlemeye açılamadı: ' + e.message, 'hata');
  }
}

function kalemDugmesi(islemId) {
  const duzenle = document.createElement('button');
  duzenle.type = 'button';
  duzenle.className = 'dugme mini ikincil kalemDugmesi';
  duzenle.textContent = '✎';
  duzenle.title = 'Düzenle';
  duzenle.setAttribute('aria-label', 'Düzenle');
  duzenle.addEventListener('click', () => belgeDuzenlemeyiAc(islemId));
  return duzenle;
}

function belgeleriCiz() {
  const govde = el('belgelerGovde');
  const bilgi = el('belgelerBilgi');
  const parcalar = aramaParcalari(el('belgelerArama').value);
  const aramaVar = belgeAramaSonucu !== null && parcalar.length > 0;

  // Sunucu "eşleşenleri" verdi; burada yalnız sıralanıyor. Sunucunun
  // taramadığı ekran metinleri (saat gibi) eşleşmeyi düşürmesin diye
  // eşleşmeyen satır atılmıyor, sona konuyor.
  const liste = aramaVar
    ? (() => {
        const sirali = aramayaGoreSirala(
          belgeAramaSonucu, parcalar,
          (k) => `${k.FisNo || ''} ${k.CariAd || ''} ${k.BelgeNo || ''} ${belgeTuruAdi(k.Konu)} ` +
                 `${k.Kullanici || ''} ${k.Aciklama || ''} ${tarihYaz(k.Tarih)}`
        );
        const kalan = belgeAramaSonucu.filter((k) => !sirali.includes(k));
        return sirali.concat(kalan);
      })()
    : belgelerListesi;

  if (bilgi) {
    const vegaSayisi = aramaVar ? liste.filter((k) => k.kaynak === 'vega').length : 0;
    bilgi.textContent = aramaVar
      ? `${liste.length} belge bulundu` + (vegaSayisi ? ` (${vegaSayisi} tanesi yalnız Vega'da)` : '')
      : (belgelerListesi.length ? `son ${belgelerListesi.length} belge` : '');
  }

  if (!aramaVar && !belgelerListesi.length) {
    return boslukTemizle(govde, 9, 'Henüz belge yazılmamış.');
  }
  if (!liste.length) {
    return boslukTemizle(govde, 9, 'Aramaya uyan belge yok (program günlüğünde ve Vega\'da arandı).');
  }

  govde.innerHTML = '';
  for (const k of liste) {
    const tr = document.createElement('tr');
    // 30.09.2026 müşteri isteği: geçmişe dönük girilen kayıtta belge tarihi
    // ile işlemin yapıldığı an (gün + saat) ayrı sütunlarda.
    const hucreler = [
      [tarihYaz(k.Tarih), ''],
      [k.KayitTarihi ? tarihSaatYaz(k.KayitTarihi) : '', 'islemZamani'],
      [belgeTuruAdi(k.Konu), ''],
      [k.CariAd || '', ''],
      [k.FisNo || '', ''],
      [k.BelgeNo || '', ''],
      [k.Tutar != null ? para(k.Tutar) : '', 'sayi'],
      [k.Kullanici || '', '']
    ];
    for (const [metin, sinif] of hucreler) {
      const td = document.createElement('td');
      if (sinif) td.className = sinif;
      td.textContent = metin;
      tr.appendChild(td);
    }

    const eylemHucre = document.createElement('td');
    eylemHucre.className = 'belgeEylemleri';
    if (k.kaynak === 'vega') {
      const isaret = document.createElement('span');
      isaret.className = 'ipucu';
      isaret.textContent = 'programda kaydı yok';
      isaret.title = "Bu belge Vega'da duruyor ama bu programın günlüğünde değil; düzenleme/geri alma Vega'dan yapılır.";
      eylemHucre.appendChild(isaret);
    } else if (k.GeriAlindi) {
      const isaret = document.createElement('span');
      isaret.className = 'ipucu';
      isaret.textContent = 'geri alındı';
      eylemHucre.appendChild(isaret);
    } else if (durum.yazmaAcik) {
      if (DUZENLENEBILIR_KONULAR.includes(k.Konu)) {
        eylemHucre.appendChild(kalemDugmesi(k.Id));
      }
      const geri = document.createElement('button');
      geri.type = 'button';
      geri.className = 'dugme mini tehlike';
      geri.textContent = 'Geri Al';
      geri.addEventListener('click', async () => {
        const onay = await cagir('onay', {
          baslik: 'Vega kaydını geri al',
          mesaj: `Belge no ${k.BelgeNo || '—'} Vega'dan silinecek.`,
          ayrinti: 'Bu belgenin satış/cari kayıtları ve stok hareketleri silinir. Müşterinin bakiyesi işlem öncesi haline döner.',
          tamamBaslik: 'Geri al'
        });
        if (!onay.onaylandi) return;
        geri.disabled = true;
        try {
          const r = await cagir('yazma:belgeGeriAl', { islemId: k.Id });
          bildir(`Geri alındı (${r.silinenSatir} satır silindi).`, 'basarili');
          belgelerYukle();
        } catch (e) {
          bildir('Geri alınamadı: ' + e.message, 'hata');
          geri.disabled = false;
        }
      });
      eylemHucre.appendChild(geri);
    }
    tr.appendChild(eylemHucre);

    govde.appendChild(tr);
  }
}

el('belgelerArama').addEventListener('input', () => {
  if (belgeAramaZamani) clearTimeout(belgeAramaZamani);
  belgeAramaZamani = setTimeout(belgeAra, 250);
});

// ═══════════════════════ Hafta hesabı (Pazar → Cumartesi) ═══════════════════════
//
// Kullanıcı isteği: "pazardan pazara". Hafta Pazar 00:00'da başlar, Cumartesi
// biter. Aynı kural sunucu tarafında db/rapor.js → haftaAraligi'nda duruyor;
// burada tekrar hesaplanmasının tek sebebi ok tuşlarına basınca her seferinde
// sunucuya gidilmemesi.

function haftaBasi(t) {
  const d = t instanceof Date ? new Date(t) : new Date(t || Date.now());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // getDay(): 0 = Pazar
  return d;
}

function haftaSonu(t) {
  const d = haftaBasi(t);
  d.setDate(d.getDate() + 6);
  return d;
}

function haftaEtiketi(t) {
  return `${tarihYaz(haftaBasi(t))} — ${tarihYaz(haftaSonu(t))}`;
}

// ═══════════════════════ EKSTRE ═══════════════════════
//
// Ekran iki katmanlı: veritabanından TARİH ARALIĞI ile çekiliyor, süzgeçler
// (işlem türü, yön, metin, en az tutar) çekilen satırlar üzerinde tarayıcıda
// uygulanıyor. Süzgeci değiştirmek yeni sorgu açmıyor, anında süzüyor.

// kasaMetni: müşteride açık duran kasalar. Özet satırı her süzgeç
// değişiminde yeniden yazıldığı için ayrı tutulur (önceden süzgece dokununca
// kayboluyordu).
const ekstreDurum = { devir: 0, satirlar: [], sonBakiye: 0, kasaMetni: '' };

el('ekstreGetir').addEventListener('click', () => ekstreYukle());

el('ekstreBuHafta').addEventListener('click', () => ekstreHaftayaGit(new Date()));
el('ekstreOncekiHafta').addEventListener('click', () => ekstreHaftaKaydir(-7));
el('ekstreSonrakiHafta').addEventListener('click', () => ekstreHaftaKaydir(7));
el('ekstreTumu').addEventListener('click', () => {
  el('ekstreBaslangic').value = '';
  el('ekstreBitis').value = '';
  el('ekstreHaftaEtiket').textContent = 'Tüm hareketler';
  ekstreYukle();
});

for (const id of ['ekstreIslem', 'ekstreYon', 'ekstreMetin', 'ekstreEnAz']) {
  const kutu = el(id);
  kutu.addEventListener(kutu.tagName === 'SELECT' ? 'change' : 'input', () => ekstreCiz());
}

// 17.09.2026 kullanıcı raporu: Ekstre'de müşteri değişince tarih önceki
// müşteriden (ya da Haftalık Rapor'dan gelinen haftadan) kalıyordu ve ekranda
// eski müşterinin ayrıntılı raporu duruyordu. Artık elle seçilen her yeni
// müşteride aralık bu haftaya döner; ayrıntılı rapor açıksa yeni müşteri için
// yeniden hazırlanır. Haftalık Rapor'dan geçişte o hafta korunur (haftaKoru).
function ekstreCariDegisti(cari, secenek) {
  if (!cari) {
    // "Değiştir"e basılınca eski müşterinin hareketleri de ekranda kalmasın.
    ekstreRaporSirasi++;
    el('ekstreRapor').classList.add('gizli');
    ekstreYukle();
    return;
  }
  if (!(secenek && secenek.haftaKoru)) {
    const bugunTarih = new Date();
    el('ekstreBaslangic').value = tarihKutusu(haftaBasi(bugunTarih));
    el('ekstreBitis').value = tarihKutusu(haftaSonu(bugunTarih));
    el('ekstreHaftaEtiket').textContent = haftaEtiketi(bugunTarih);
  }
  ekstreYukle();
  // 01.10.2026 müşteri isteği: müşteri seçilince ayrıntılı ekstre de hemen
  // gelsin, "Ayrıntılı Rapor"a ayrıca basmak gerekmesin.
  ekstreRaporGetir();
}

function ekstreHaftayaGit(tarih) {
  el('ekstreBaslangic').value = tarihKutusu(haftaBasi(tarih));
  el('ekstreBitis').value = tarihKutusu(haftaSonu(tarih));
  el('ekstreHaftaEtiket').textContent = haftaEtiketi(tarih);
  ekstreYukle();
  // Ayrıntılı ekstre artık seçimle açık geliyor; hafta değişince o da izlesin.
  if (ekstreCari.secili() && !el('ekstreRapor').classList.contains('gizli')) ekstreRaporGetir();
}

function ekstreHaftaKaydir(gun) {
  const su = el('ekstreBaslangic').value
    ? new Date(el('ekstreBaslangic').value)
    : new Date();
  su.setDate(su.getDate() + gun);
  ekstreHaftayaGit(su);
}

function ayniCari(a, b) {
  return !!(a && b && Number(a.cariInd) === Number(b.cariInd));
}

async function ekstreYukle() {
  const govde = el('ekstreGovde');
  const ozet = el('ekstreOzet');
  ozet.textContent = '';

  const cari = ekstreCari.secili();
  ekstreDurum.kasaMetni = '';
  if (!cari) {
    ekstreDurum.satirlar = [];
    el('ekstreHaftaKutusu').classList.add('gizli');
    return boslukTemizle(govde, 9, 'Müşteri seçin.');
  }

  try {
    const sonuc = await cagir('vega:ekstre', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      baslangic: el('ekstreBaslangic').value || null,
      bitis: el('ekstreBitis').value || null
    });
    if (!ayniCari(ekstreCari.secili(), cari)) return; // bu arada müşteri değişti

    ekstreDurum.devir = sonuc.devir || 0;
    ekstreDurum.satirlar = sonuc.satirlar || [];
    ekstreDurum.sonBakiye = sonuc.sonBakiye || 0;

    ekstreCiz();
    ekstreHaftalariCiz();

    try {
      const kasalar = await cagir('yardimci:kasaBakiye', { firma: firmaKodu(), cariInd: cari.cariInd });
      if (!ayniCari(ekstreCari.secili(), cari)) return;
      ekstreDurum.kasaMetni = kasalar.length
        ? 'müşteride duran kasa: ' +
          kasalar.map((k) => `${k.kasaTipiKod} ${miktarYaz(k.acikAdet)}`).join(', ')
        : 'müşteride açık kasa yok';
      ekstreCiz();
    } catch (e) { /* kasa bilgisi olmasa da ekstre gösterilir */ }
  } catch (e) {
    el('ekstreHaftaKutusu').classList.add('gizli');
    boslukTemizle(govde, 9, 'Okunamadı: ' + e.message);
  }
}

function ekstreSuzgecleriUygula(satirlar) {
  const izahat = el('ekstreIslem').value;
  const yon = el('ekstreYon').value;
  const parcalar = aramaParcalari(el('ekstreMetin').value);
  const enAz = sayiOku(el('ekstreEnAz').value);

  return satirlar.filter((s) => {
    if (izahat && String(s.izahat).trim() !== izahat) return false;
    if (yon === 'borc' && !s.borc) return false;
    if (yon === 'alacak' && !s.alacak) return false;
    if (enAz && Math.max(s.borc, s.alacak) < enAz) return false;
    if (parcalar.length) {
      const metin = `${s.aciklama} ${s.evrakNo} ${s.izahatAdi}`;
      if (aramaPuani(metin, parcalar) < 0) return false;
    }
    return true;
  });
}

function ekstreCiz() {
  const govde = el('ekstreGovde');
  const ozet = el('ekstreOzet');
  const suzulmus = ekstreSuzgecleriUygula(ekstreDurum.satirlar);

  govde.innerHTML = '';

  if (ekstreDurum.devir) {
    const tr = document.createElement('tr');
    const bos = document.createElement('td');
    bos.colSpan = 8;
    const b = document.createElement('b');
    b.textContent = 'Devir bakiyesi';
    bos.appendChild(b);
    const d = document.createElement('td');
    d.className = 'sayi';
    const db = document.createElement('b');
    db.textContent = para(ekstreDurum.devir);
    d.appendChild(db);
    tr.append(bos, d);
    govde.appendChild(tr);
  }

  if (!suzulmus.length && !ekstreDurum.devir) {
    boslukTemizle(govde, 9, 'Bu aralıkta (ve süzgeçle) hareket yok.');
  } else {
    for (const s of suzulmus) {
      const tr = document.createElement('tr');
      const hucreler = [
        [tarihYaz(s.tarih), ''],
        [s.islemTarihi ? tarihSaatYaz(s.islemTarihi) : '', 'islemZamani'],
        [s.izahatAdi, ''],
        [s.evrakNo, ''],
        [s.aciklama, ''],
        [s.kasaAdedi ? miktarYaz(s.kasaAdedi) : '', 'sayi'],
        [s.borc ? para(s.borc) : '', 'sayi'],
        [s.alacak ? para(s.alacak) : '', 'sayi'],
        [para(s.bakiye), 'sayi']
      ];
      for (const [metin, sinif] of hucreler) {
        const td = document.createElement('td');
        if (sinif) td.className = sinif;
        td.textContent = metin;
        tr.appendChild(td);
      }
      govde.appendChild(tr);
    }
  }

  const borc = suzulmus.reduce((t, s) => t + s.borc, 0);
  const alacak = suzulmus.reduce((t, s) => t + s.alacak, 0);
  const verilenKasa = suzulmus.reduce((t, s) => t + (s.kasaAdedi > 0 ? s.kasaAdedi : 0), 0);
  const gelenKasa = suzulmus.reduce((t, s) => t + (s.kasaAdedi < 0 ? -s.kasaAdedi : 0), 0);
  const suzuldu = suzulmus.length !== ekstreDurum.satirlar.length;

  ozet.textContent =
    `${suzulmus.length} hareket` +
    (suzuldu ? ` (toplam ${ekstreDurum.satirlar.length} içinden süzüldü)` : '') +
    ` · çıkış ${para(borc)} · giriş ${para(alacak)}` +
    (verilenKasa || gelenKasa
      ? ` · verilen kasa ${miktarYaz(verilenKasa)} · geri gelen kasa ${miktarYaz(gelenKasa)}`
      : '') +
    ` · son bakiye ${para(ekstreDurum.sonBakiye)} TL` +
    (ekstreDurum.kasaMetni ? ' · ' + ekstreDurum.kasaMetni : '');
}

// "Bu haftaya tıklayınca ne kadar giriş çıkış olmuş" — hareketler Pazar→Cumartesi
// haftalarına bölünüp özetleniyor. Satıra tıklamak ekstreyi o haftaya süzer.
function ekstreHaftalariCiz() {
  const kutu = el('ekstreHaftaKutusu');
  const govde = el('ekstreHaftaGovde');
  govde.innerHTML = '';

  if (!ekstreDurum.satirlar.length) {
    kutu.classList.add('gizli');
    return;
  }

  const haftalar = new Map();
  for (const s of ekstreDurum.satirlar) {
    const bas = haftaBasi(s.tarih);
    const anahtar = tarihKutusu(bas);
    if (!haftalar.has(anahtar)) {
      haftalar.set(anahtar, { bas, cikis: 0, giris: 0, sonBakiye: 0 });
    }
    const h = haftalar.get(anahtar);
    h.cikis += s.borc;
    h.giris += s.alacak;
    h.sonBakiye = s.bakiye; // satırlar tarih sırasında: haftanın son bakiyesi
  }

  const sirali = [...haftalar.values()].sort((a, b) => b.bas - a.bas);
  for (const h of sirali) {
    const tr = document.createElement('tr');
    tr.className = 'tiklanir';
    tr.style.cursor = 'pointer';
    const net = h.cikis - h.giris;
    const hucreler = [
      [haftaEtiketi(h.bas), ''],
      [para(h.cikis), 'sayi'],
      [para(h.giris), 'sayi'],
      [para(net), 'sayi'],
      [para(h.sonBakiye), 'sayi']
    ];
    for (const [metin, sinif] of hucreler) {
      const td = document.createElement('td');
      if (sinif) td.className = sinif;
      td.textContent = metin;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => ekstreHaftayaGit(h.bas));
    govde.appendChild(tr);
  }

  kutu.classList.remove('gizli');
}

// ═══════════════════════ HAFTALIK RAPOR ═══════════════════════
//
// Tek görünüm: "GENEL MÜŞTERİYE GÖRE KALAN" — çok müşterili borç dökümü.
// Kullanıcı isteği (27.08.2026): bu ekran ekstre gibi ayrıntılı OLMASIN;
// her müşteri için tek satırda "ne kadar almış (kasa + yeni borç), ne kadar
// vermiş (ödeme), son borç durumu ne" görünsün. Fiş bazlı ayrıntılı döküm
// Ekstre sekmesine taşındı (bkz. ekstreRaporGetir). Listede bir müşteriye
// tıklamak o müşteriyi Ekstre sekmesinde, aynı hafta seçili olarak açar.
// Sütun tanımları için bkz. db/rapor.js başındaki açıklama.

// secili: isaretlenen musterilerin cariInd'leri. Eski Access programinda
// listenin solunda kutucuklar vardi; birkac musteri isaretlenip tek cikti
// aliniyordu — ayni davranis (05.09.2026 kullanici istegi).
const raporDurum = {
  hafta: haftaBasi(new Date()),
  ozet: null,
  ilkAcilis: true,
  secili: new Set()
};

el('raporGetir').addEventListener('click', () => raporGetir());
el('raporBuHafta').addEventListener('click', () => raporHaftayaGit(new Date()));
el('raporOncekiHafta').addEventListener('click', () => raporHaftaKaydir(-7));
el('raporSonrakiHafta').addEventListener('click', () => raporHaftaKaydir(7));
el('raporArama').addEventListener('input', () => raporGenelCiz());
el('raporYazdir').addEventListener('click', () => {
  raporSecimiGorunurYap();
  yazdir(el('raporGenel'));
});
el('raporSecimTemizle').addEventListener('click', () => {
  raporDurum.secili.clear();
  raporGenelCiz();
});
el('raporTopluEkstre').addEventListener('click', () => topluEkstreGetir());
el('raporHepsiSec').addEventListener('change', (olay) => {
  // Yalniz ekranda gorunen (arama suzgecinden gecen) satirlar isaretlenir.
  for (const s of raporGorunenSatirlar()) {
    if (olay.target.checked) raporDurum.secili.add(s.cariInd);
    else raporDurum.secili.delete(s.cariInd);
  }
  raporGenelCiz();
});
el('topluEkstreYazdir').addEventListener('click', () => yazdir(el('topluEkstre')));
el('topluEkstreKapat').addEventListener('click', () => {
  el('topluEkstre').classList.add('gizli');
});

function raporSayfasiAcildi() {
  raporHaftaEtiketiniGuncelle();
  if (raporDurum.ilkAcilis && firmaSecildiMi()) {
    raporDurum.ilkAcilis = false;
    raporGetir();
  }
}

// Not sütununun başlığı her zaman bugünün tarihidir (03.10.2026 müşteri
// isteği): kâğıda basıldığı gün elle not tutuluyor. Önceden seçili haftanın
// Cumartesi'si yazılıyordu; geçmiş hafta seçilince geri tarih çıkıyordu.
function raporHaftaEtiketiniGuncelle() {
  el('raporHaftaEtiket').textContent = haftaEtiketi(raporDurum.hafta);
  el('raporGenelTarih').textContent = tarihYaz(new Date());
}

function raporHaftayaGit(tarih) {
  raporDurum.hafta = haftaBasi(tarih);
  raporHaftaEtiketiniGuncelle();
  raporGetir();
}

function raporHaftaKaydir(gun) {
  const d = new Date(raporDurum.hafta);
  d.setDate(d.getDate() + gun);
  raporHaftayaGit(d);
}

async function raporGetir() {
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  const dugme = el('raporGetir');
  dugme.disabled = true;
  // Liste degisiyor: eski secim yeni haftada anlamsiz.
  raporDurum.secili.clear();
  el('topluEkstre').classList.add('gizli');
  boslukTemizle(el('raporGenelGovde'), 7, 'Hazırlanıyor…');

  try {
    raporDurum.ozet = await cagir('rapor:haftalikOzet', {
      firma: firmaKodu(),
      donem: donemKodu(),
      baslangic: tarihKutusu(haftaBasi(raporDurum.hafta)),
      bitis: tarihKutusu(haftaSonu(raporDurum.hafta)),
      // Süzgeç kutuları 03.10.2026'da kaldırıldı: alıcı kartlarının hepsi.
      tip: 'alici',
      musteriTipi: null
    });
    raporHaftaEtiketiniGuncelle();
    raporGenelCiz();
  } catch (e) {
    raporDurum.ozet = null;
    boslukTemizle(el('raporGenelGovde'), 7, 'Rapor okunamadı: ' + e.message);
    el('raporGenelToplam').textContent = '0,00';
  } finally {
    dugme.disabled = false;
  }
}

// Ekranda o an duran (arama süzgecinden geçmiş) satırlar.
function raporGorunenSatirlar() {
  if (!raporDurum.ozet) return [];
  const parcalar = aramaParcalari(el('raporArama').value);
  return parcalar.length
    ? aramayaGoreSirala(raporDurum.ozet.satirlar, parcalar, (s) => s.ad + ' ' + s.kod)
    : raporDurum.ozet.satirlar;
}

// İşaretli müşteriler — arama kutusu değişince seçim kaybolmasın diye
// süzgeçten değil, tüm listeden çıkarılır.
function raporSeciliSatirlar() {
  if (!raporDurum.ozet) return [];
  return raporDurum.ozet.satirlar.filter((s) => raporDurum.secili.has(s.cariInd));
}

// Arama süzgeci yüzünden ekranda durmayan seçili müşteri varsa kâğıda da
// düşmezdi. Yazdırmadan önce süzgeç kaldırılıyor: işaretlenen herkes bassın.
function raporSecimiGorunurYap() {
  if (!raporDurum.secili.size) return;
  const gorunen = new Set(raporGorunenSatirlar().map((s) => s.cariInd));
  const eksikVar = raporSeciliSatirlar().some((s) => !gorunen.has(s.cariInd));
  if (!eksikVar) return;
  el('raporArama').value = '';
  raporGenelCiz();
}

function raporGenelCiz() {
  const govde = el('raporGenelGovde');
  if (!raporDurum.ozet) return;

  const satirlar = raporGorunenSatirlar();

  govde.innerHTML = '';
  if (!satirlar.length) {
    boslukTemizle(govde, 7, 'Bu haftada gösterilecek müşteri yok.');
    el('raporGenelToplam').textContent = '0,00';
    raporSecimBilgisi();
    return;
  }

  for (const s of satirlar) {
    const tr = document.createElement('tr');
    tr.className = 'tiklanir';
    const isaretli = raporDurum.secili.has(s.cariInd);
    if (isaretli) tr.classList.add('secili');
    tr.title = 'Ayrıntılı dökümü Ekstre ekranında aç';

    const secimHucre = document.createElement('td');
    secimHucre.className = 'secimSutun';
    const kutu = document.createElement('input');
    kutu.type = 'checkbox';
    kutu.checked = isaretli;
    kutu.title = 'Bu müşteriyi seç';
    // Kutucuk satırın kendi tıklamasını (Ekstre'ye geçiş) tetiklemesin.
    kutu.addEventListener('click', (olay) => olay.stopPropagation());
    kutu.addEventListener('change', () => {
      if (kutu.checked) raporDurum.secili.add(s.cariInd);
      else raporDurum.secili.delete(s.cariInd);
      // Tabloyu baştan çizmiyoruz: kutucuk odağı kaybolmasın ve çok
      // müşterili listede her tıklama takılmasın.
      tr.classList.toggle('secili', kutu.checked);
      raporToplamlariCiz();
    });
    secimHucre.appendChild(kutu);
    tr.appendChild(secimHucre);

    const hucreler = [
      // Tarih üst başlıkta bir kez yazılır; örnek rapordaki sol sütun satırlarda boştur.
      ['', ''],
      [s.ad, ''],
      [para(s.eskiBorc), 'sayi'],
      [s.kasa ? para(s.kasa) : '0,00', 'sayi'],
      [para(s.yeniBorc), 'sayi'],
      [para(s.topBakiye), 'sayi']
    ];
    for (const [metin, sinif] of hucreler) {
      const td = document.createElement('td');
      if (sinif) td.className = sinif;
      td.textContent = metin;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => raporMusteriyeGec(s));
    govde.appendChild(tr);
  }

  raporToplamlariCiz();
}

// Alt toplam satırı. Seçim varsa yalnız işaretli müşterilerden hesaplanır —
// kâğıda da yalnız onlar bastığı için GENEL TOPLAM tutarlı kalsın.
function raporToplamlariCiz() {
  const satirlar = raporGorunenSatirlar();
  const secimVar = raporDurum.secili.size > 0;
  let toplamBakiye = 0;

  for (const s of satirlar) {
    if (secimVar && !raporDurum.secili.has(s.cariInd)) continue;
    toplamBakiye += s.topBakiye;
  }

  el('raporGenelToplam').textContent = para(toplamBakiye);
  el('raporGenelTablo').classList.toggle('yalnizSecili', secimVar);
  raporSecimBilgisi();
}

// Seçim sayısı + "hepsini seç" kutusunun üç durumu (boş / kısmi / dolu).
function raporSecimBilgisi() {
  const gorunen = raporGorunenSatirlar();
  const sayi = raporDurum.secili.size;
  const bilgi = el('raporSecimBilgi');
  bilgi.classList.toggle('gizli', sayi === 0);
  if (sayi) {
    bilgi.textContent =
      `${sayi} müşteri seçili — Yazdır ve Seçilenlerin Ekstresi yalnız bunları alır. ` +
      'Alttaki GENEL TOPLAM da seçilenlerin toplamıdır.';
  }
  const hepsi = el('raporHepsiSec');
  const isaretliGorunen = gorunen.filter((s) => raporDurum.secili.has(s.cariInd)).length;
  hepsi.checked = gorunen.length > 0 && isaretliGorunen === gorunen.length;
  hepsi.indeterminate = isaretliGorunen > 0 && isaretliGorunen < gorunen.length;
}

// Haftalık rapordan ayrıntıya geçiş: müşteri Ekstre ekranında, aynı hafta
// seçili olarak açılır ve fiş bazlı rapor hemen hazırlanır.
function raporMusteriyeGec(s) {
  sekmeAc('ekstre');
  el('ekstreBaslangic').value = tarihKutusu(haftaBasi(raporDurum.hafta));
  el('ekstreBitis').value = tarihKutusu(haftaSonu(raporDurum.hafta));
  el('ekstreHaftaEtiket').textContent = haftaEtiketi(raporDurum.hafta);
  ekstreCari.sec(
    { cariInd: s.cariInd, kod: s.kod, ad: s.ad, bakiye: s.topBakiye },
    { haftaKoru: true, raporAc: true }
  );
  ekstreCari.yenile();
}

// ═══════════════════════ EKSTRE → AYRINTILI RAPOR ═══════════════════════
//
// Asıl ayrıntılı çıktı burada (27.08.2026'da Haftalık Rapor ekranından
// taşındı): seçili müşterinin, ekstredeki tarih aralığında, fiş fiş ürün
// dökümü. Her fişin sonunda ara toplam, en altta genel toplam, ardından
// kasa özeti / ödemeler / bakiye blokları.
//
// Tasarım daraltıldı: satır yüksekliği ve yazı boyu küçültüldü — ürünü çok
// olan müşteride çıktı sayfalarca sürüyordu.
//
// 05.09.2026 kullanıcı isteği: satılan ürünün SAFİ KG'ı (dara düşülmüş kilo)
// FİYAT'ın hemen önüne sütun olarak eklendi. Fiş satırlarındaki
// K.ADET / K.TÜRÜ / K.TUTAR yerinde duruyor — kaldırılan, alttaki ayrı
// "Verilen Kasalar" bloğuydu (kullanıcı çıktı üzerinde "iptal" diye işaretledi):
// aynı kasa bilgisi hem satırda hem o blokta iki kez veriliyordu.

el('ekstreRaporGetir').addEventListener('click', () => ekstreRaporGetir());
el('ekstreRaporYazdir').addEventListener('click', () => yazdir(el('ekstreRapor')));
el('ekstreRaporKapat').addEventListener('click', () => {
  el('ekstreRapor').classList.add('gizli');
});

let ekstreRaporSirasi = 0;

async function ekstreRaporGetir() {
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  const cari = ekstreCari.secili();
  if (!cari) return bildir('Önce müşteri seçin.', 'hata');

  // Aralık boşsa ("Tümü") ayrıntılı rapor için bu hafta varsayılır — tüm
  // zamanların fiş dökümü yüzlerce sayfa olurdu.
  if (!el('ekstreBaslangic').value || !el('ekstreBitis').value) {
    el('ekstreBaslangic').value = tarihKutusu(haftaBasi(new Date()));
    el('ekstreBitis').value = tarihKutusu(haftaSonu(new Date()));
    el('ekstreHaftaEtiket').textContent = haftaEtiketi(new Date());
  }

  el('ekstreRapor').classList.remove('gizli');
  el('ekstreRaporUst').textContent = '';
  el('ekstreRaporAlt').textContent = '';
  boslukTemizle(el('ekstreRaporGovde'), 9, 'Hazırlanıyor…');

  // Müşteri seçimiyle rapor kendiliğinden açıldığı için arka arkaya seçimde
  // geç dönen eski müşterinin dökümü yenisinin üstüne yazılmasın.
  const sira = ++ekstreRaporSirasi;
  try {
    const d = await cagir('rapor:haftalikDetay', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      baslangic: el('ekstreBaslangic').value,
      bitis: el('ekstreBitis').value
    });
    if (sira !== ekstreRaporSirasi) return;
    ekstreRaporCiz(d);
  } catch (e) {
    if (sira !== ekstreRaporSirasi) return;
    boslukTemizle(el('ekstreRaporGovde'), 9, 'Döküm okunamadı: ' + e.message);
  }
}

function bilgiKutusu(baslik, deger, buyuk) {
  const k = document.createElement('div');
  k.className = 'bilgi';
  const s = document.createElement('span');
  s.textContent = baslik;
  const b = document.createElement('b');
  if (buyuk) b.className = 'buyukAd';
  b.textContent = deger || '—';
  k.append(s, b);
  return k;
}

function raporSatiriEkle(govde, hucreler, sinif) {
  const tr = document.createElement('tr');
  if (sinif) tr.className = sinif;
  for (const [metin, kolonSinif, genislik] of hucreler) {
    const td = document.createElement('td');
    if (kolonSinif) td.className = kolonSinif;
    if (genislik) td.colSpan = genislik;
    td.textContent = metin;
    tr.appendChild(td);
  }
  govde.appendChild(tr);
  return tr;
}

function ekstreRaporCiz(d) {
  ekstreIcerigiCiz(d, el('ekstreRaporUst'), el('ekstreRaporGovde'), el('ekstreRaporAlt'));
}

// Bir müşterinin ayrıntılı dökümünü verilen kaplara çizer. Kaplar dışarıdan
// geliyor: aynı çizim hem tek müşterilik Ekstre ekranında, hem de haftalık
// rapordan seçilen müşterilerin toplu ekstresinde kullanılıyor.
function ekstreIcerigiCiz(d, ust, govde, alt) {
  // Kullanıcı isteği: hesap ekstresi başlığında yalnız firma/müşteri adı.
  // Adres, telefon, dönem ve devir üst bilgide tekrar edilmez.
  ust.innerHTML = '';
  ust.append(bilgiKutusu('FİRMA', d.cari.ad, true));

  // Satırlar — fiş fiş. Her fişin sonunda ara toplam, sonra ince bir ayraç
  // (kullanıcı isteği: "fiş sırası bitince sonunda boşluk bıraksın, o seriyi
  // toplasın, sonra öyle öyle devam etsin"). SAFİ KG sütunu FİYAT'tan önce.
  govde.innerHTML = '';

  if (!d.gruplar.length) {
    boslukTemizle(govde, 9, 'Bu aralıkta bu müşteriye belge girilmemiş.');
  } else {
    const genel = { kasaAdedi: 0, kasaTutari: 0, netKg: 0, tutar: 0 };

    d.gruplar.forEach((g, sira) => {
      // 17.09.2026 kullanıcı raporu: aynı fişte aynı kasa türü ilk satırda
      // toplanıyordu (ÇAM ÜZÜM 6 UP + ÇEKİRDEKSİZ 30 UP → ÇAM ÜZÜM'de "36"),
      // belgeyle çelişiyor sanıldı. Her satır artık kendi kasasını gösterir;
      // türe göre toplam fiş ara toplamının K.TÜRÜ hücresinde durur.
      for (const s of g.satirlar) {
        const kasaVar = !!(s.kasaAdedi || s.kasaTutari);
        raporSatiriEkle(govde, [
          [s.cinsi, ''],
          [kasaVar ? miktarYaz(s.kasaAdedi) : '', 'sayi'],
          [kasaVar ? s.kasaTipiKod : '', ''],
          [kasaVar ? para(s.kasaTutari) : '', 'sayi'],
          [s.netKg ? miktarYaz(s.netKg) : '', 'sayi'],
          [para(s.fiyat), 'sayi'],
          [para(s.tutar), 'sayi'],
          [s.aciklama, ''],
          [s.fisNo, 'sayi']
        ]);
      }

      raporSatiriEkle(govde, [
        [`FİŞ ${g.fisNo} TOPLAMI`, ''],
        [miktarYaz(g.araToplam.kasaAdedi), 'sayi'],
        [(g.kasaTurleri || []).length
          ? g.kasaTurleri.map((k) => `${miktarYaz(k.adet)} ${k.tur}`).join(' · ')
          : '', 'kasaTurDagilimi'],
        [para(g.araToplam.kasaTutari), 'sayi'],
        [miktarYaz(g.araToplam.netKg), 'sayi'],
        ['', 'sayi'],
        [para(g.araToplam.tutar), 'sayi'],
        ['', ''],
        [g.fisNo, 'sayi']
      ], 'fisAra');

      genel.kasaAdedi += g.araToplam.kasaAdedi;
      genel.kasaTutari += g.araToplam.kasaTutari;
      genel.netKg += g.araToplam.netKg;
      genel.tutar += g.araToplam.tutar;

      // Son fişten sonra ayraç yok; genel toplam hemen altında dursun.
      // 05.09.2026 kullanıcı isteği: iki fiş arası boşluk yerine belirgin çizgi.
      if (sira < d.gruplar.length - 1) {
        raporSatiriEkle(govde, [['', '', 9]], 'fisAyrac');
      }
    });

    raporSatiriEkle(govde, [
      ['GENEL TOPLAM', ''],
      [miktarYaz(genel.kasaAdedi), 'sayi'],
      ['', ''],
      [para(genel.kasaTutari), 'sayi'],
      [miktarYaz(genel.netKg), 'sayi'],
      ['', 'sayi'],
      [para(genel.tutar), 'sayi'],
      ['', ''],
      ['', 'sayi']
    ], 'genelToplam');
  }

  // Alt blok: ödemeler, bakiye. Verilen kasalar için ayrı blok yok
  // (05.09.2026 kullanıcı isteği) — tek yerde, aşağıdaki KASA ADEDİ / KASA
  // TUTARI özet kalemlerinde veriliyor. "Geri Gelen Kasalar" kutusu da
  // 30.09.2026 müşteri isteğiyle kaldırıldı; iade parası ÖDEME bloğunda durur.
  alt.innerHTML = '';

  alt.appendChild(kucukTablo(
    'ÖDEME',
    ['ÖD. TARİHİ', 'ALINAN', 'AÇIKLAMA'],
    d.odemeler.length
      ? d.odemeler.map((o) => [
          [tarihYaz(o.tarih), ''], [para(o.alinan), 'sayi'], [o.aciklama, '']
        ])
      : [[['Bu aralıkta ödeme alınmamış.', '', 3]]]
  ));

  const ozet = document.createElement('div');
  ozet.className = 'raporOzet';
  ozet.append(
    ozetKalemi('DEVİR', para(d.devir)),
    ozetKalemi('SAFİ KG', miktarYaz(d.safiKg)),
    ozetKalemi('KASA ADEDİ', miktarYaz(d.kasaAdedi)),
    ozetKalemi('KASA TUTARI', para(d.kasaTutari)),
    ozetKalemi('S.TUTARI', para(d.urunTutari)),
    ozetKalemi('TOPLAM TUTAR', para(d.toplam)),
    ozetKalemi('ÖDEME', para(d.odemeToplam)),
    ozetKalemi('BAKİYE', para(d.bakiye), true)
  );
  alt.appendChild(ozet);
}

function ozetKalemi(baslik, deger, vurgu) {
  const k = document.createElement('div');
  k.className = 'kalem' + (vurgu ? ' vurgu' : '');
  const s = document.createElement('span');
  s.textContent = baslik;
  const b = document.createElement('b');
  b.textContent = deger;
  k.append(s, b);
  return k;
}

function kucukTablo(baslik, basliklar, satirlar) {
  const sarma = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = baslik;
  sarma.appendChild(h);

  const t = document.createElement('table');
  t.className = 'veri rapor dar';
  const thead = document.createElement('thead');
  const btr = document.createElement('tr');
  for (const b of basliklar) {
    const th = document.createElement('th');
    th.textContent = b;
    btr.appendChild(th);
  }
  thead.appendChild(btr);
  const tbody = document.createElement('tbody');
  for (const satir of satirlar) raporSatiriEkle(tbody, satir);
  t.append(thead, tbody);
  sarma.appendChild(t);
  return sarma;
}

// ═══════════════════ SEÇİLENLERİN TOPLU EKSTRESİ ═══════════════════
//
// 05.09.2026 kullanıcı isteği: eski Access programındaki gibi listeden
// birden çok müşteri işaretlenip hepsinin ekstresi tek seferde alınabilsin.
// Sunucuda yeni bir uç yok — her müşteri için mevcut `rapor:haftalikDetay`
// sırayla çağrılıyor; tek sorguda birleştirmek fiş gruplama mantığını
// baştan yazmayı gerektirirdi.

function ekstreBloguOlustur() {
  const sarma = document.createElement('div');
  sarma.className = 'ekstreBlok';

  const ust = document.createElement('div');
  ust.className = 'raporUst';

  // Sütun başlıkları tek yerde dursun diye tekil ekstre tablosu kopyalanıyor.
  const tablo = el('ekstreRaporTablo').cloneNode(true);
  tablo.removeAttribute('id');
  const govde = tablo.querySelector('tbody');
  govde.removeAttribute('id');
  govde.innerHTML = '';

  const alt = document.createElement('div');
  alt.className = 'raporAlt';

  sarma.append(ust, tablo, alt);
  return { sarma, ust, govde, alt };
}

async function topluEkstreGetir() {
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  const secilenler = raporSeciliSatirlar();
  if (!secilenler.length) {
    return bildir('Önce listeden en az bir müşteri işaretleyin.', 'hata');
  }

  const kutu = el('topluEkstre');
  const kap = el('topluEkstreGovde');
  const dugme = el('raporTopluEkstre');

  kutu.classList.remove('gizli');
  kap.innerHTML = '';
  const durumSatiri = document.createElement('p');
  durumSatiri.className = 'ipucu topluEkstreDurum';
  kap.appendChild(durumSatiri);
  el('topluEkstreBaslik').textContent =
    `Seçilenlerin Ekstresi (${secilenler.length} müşteri) · ${haftaEtiketi(raporDurum.hafta)}`;

  const baslangic = tarihKutusu(haftaBasi(raporDurum.hafta));
  const bitis = tarihKutusu(haftaSonu(raporDurum.hafta));

  dugme.disabled = true;
  let okunamayan = 0;
  try {
    for (let i = 0; i < secilenler.length; i++) {
      const s = secilenler[i];
      durumSatiri.textContent = `${i + 1} / ${secilenler.length} hazırlanıyor — ${s.ad}`;
      const blok = ekstreBloguOlustur();
      try {
        const d = await cagir('rapor:haftalikDetay', {
          firma: firmaKodu(),
          donem: donemKodu(),
          cariInd: s.cariInd,
          baslangic,
          bitis
        });
        ekstreIcerigiCiz(d, blok.ust, blok.govde, blok.alt);
      } catch (e) {
        // Bir müşteri okunamazsa kalanlar yine hazırlansın.
        okunamayan++;
        blok.ust.appendChild(bilgiKutusu('ADI_SOYADI', s.ad, true));
        boslukTemizle(blok.govde, 9, 'Döküm okunamadı: ' + e.message);
      }
      kap.appendChild(blok.sarma);
    }
    durumSatiri.textContent = okunamayan
      ? `${secilenler.length} müşteri hazırlandı, ${okunamayan} tanesi okunamadı.`
      : `${secilenler.length} müşterinin ekstresi hazır — Yazdır'da her biri ayrı sayfaya basılır.`;
  } finally {
    dugme.disabled = false;
  }

  kutu.scrollIntoView({ block: 'start' });
}

// Yazdırma — yalnızca "yazdirilir" işaretli kutu basılır. Sayfada birden çok
// böyle kutu varsa (haftalık rapor + seçilenlerin ekstresi) hedef verilir ve
// yalnız o basılır. Gövdeye geçici sınıflar eklenip bitince kaldırılıyor.
async function yazdir(hedef) {
  document.body.classList.add('yazdirmaModu');
  if (hedef) {
    hedef.classList.add('yazdirmaHedefi');
    document.body.classList.add('hedefliYazdirma');
  }
  try {
    window.print();
  } catch (e) {
    try {
      await cagir('yazdir', {});
    } catch (e2) {
      bildir('Yazdırılamadı: ' + e2.message, 'hata');
    }
  } finally {
    setTimeout(() => {
      document.body.classList.remove('yazdirmaModu');
      document.body.classList.remove('hedefliYazdirma');
      if (hedef) hedef.classList.remove('yazdirmaHedefi');
    }, 500);
  }
}

// ═══════════════════════ ÖDEMELER ═══════════════════════
//
// 17.09.2026 kullanıcı isteği: müşterinin ödeme geçmişi ayrı sayfada,
// raporlu ve yazdırılabilir; ödeme yöntemi (nakit/kasa, havale, EFT) ve
// açıklamasıyla ödeme girişi. Yazma: yazma:odeme (db/yazma.js → odemeYaz),
// okuma: rapor:odemeGecmisi — Vega'nın kendi defterinden, programdan
// girilmemiş tahsilatlar da gelir.

//
// 30.09.2026 müşteri isteği: ödeme yöntemi seçimi kalktı (ödeme hep nakit,
// Belge Gir'deki tahsilat gibi), yerine Fiş No geldi. Yanlış girilen ödeme
// artık yalnız geri alınmıyor, ✎ ile formda düzeltilebiliyor.

const odemeDurum = { veri: null, ilkAcilis: true, sira: 0 };
let odemeDuzenleme = null;   // { islemId } — düzeltilen ödeme

el('odemeKaydet').addEventListener('click', () => odemeKaydet());
el('odemeGetir').addEventListener('click', () => odemeGecmisiGetir());
el('odemeYazdir').addEventListener('click', () => yazdir(el('odemeRapor')));
el('odemeArama').addEventListener('input', () => odemeGecmisiCiz());
tutarGirdisiBagla(el('odemeTutar'));
for (const id of ['odemeTutar', 'odemeFisNo', 'odemeAciklama']) {
  el(id).addEventListener('keydown', (olay) => {
    if (olay.key === 'Enter') odemeKaydet();
  });
}
el('odemeDuzenlemeIptal').addEventListener('click', () => {
  odemeDuzenlemesiniKapat(true);
  uyariKapat();
});

function odemeDuzenlemesiniKapat(formuBosalt) {
  odemeDuzenleme = null;
  el('odemeDuzenlemeBilgi').classList.add('gizli');
  el('odemeDuzenlemeBilgi').textContent = '';
  el('odemeKaydet').textContent = 'Ödemeyi Kaydet';
  el('odemeDuzenlemeIptal').classList.add('gizli');
  if (formuBosalt) {
    el('odemeTutar').value = '';
    el('odemeFisNo').value = '';
    el('odemeAciklama').value = '';
    el('odemeTarih').value = bugun();
  }
}

function odemeDuzenlemeyiAc(d) {
  sekmeAc('odeme');
  odemeCari.sec(d.cari);   // seçim geri çağrısı geçmişi o müşteriye süzer
  el('odemeTarih').value = tarihKutusu(d.tarih);
  sayiGirdisineYaz(el('odemeTutar'), d.tutar);
  el('odemeFisNo').value = d.fisNo || '';
  el('odemeAciklama').value = d.aciklama || '';

  odemeDuzenleme = { islemId: Number(d.islemId) };
  const bilgi = el('odemeDuzenlemeBilgi');
  bilgi.textContent = `${d.cari.ad} · ${para(d.tutar)} TL ödeme düzenleniyor. ` +
    'Kaydetme tamamlanmazsa eski ödeme aynen korunur.';
  bilgi.classList.remove('gizli');
  el('odemeKaydet').textContent = 'Değişiklikleri Kaydet';
  el('odemeDuzenlemeIptal').classList.remove('gizli');
  el('odemeTutar').focus();
  bildir('Ödeme düzenlemeye açıldı. Düzeltip Değişiklikleri Kaydet’e basın.', '');
}

function odemeAraligi(bas, bit) {
  el('odemeBaslangic').value = bas ? tarihKutusu(bas) : '';
  el('odemeBitis').value = bit ? tarihKutusu(bit) : '';
  odemeGecmisiGetir();
}

el('odemeBuHafta').addEventListener('click', () =>
  odemeAraligi(haftaBasi(new Date()), haftaSonu(new Date())));
el('odemeBuAy').addEventListener('click', () => {
  const d = new Date();
  odemeAraligi(new Date(d.getFullYear(), d.getMonth(), 1), d);
});
el('odemeUcAy').addEventListener('click', () => {
  const d = new Date();
  odemeAraligi(new Date(d.getFullYear(), d.getMonth() - 3, d.getDate()), d);
});
el('odemeTumu').addEventListener('click', () => odemeAraligi(null, null));

function odemeSayfasiAcildi() {
  if (odemeDurum.ilkAcilis && firmaSecildiMi()) {
    odemeDurum.ilkAcilis = false;
    odemeGecmisiGetir();
  }
}

async function odemeKaydet() {
  uyariKapat();
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  const cari = odemeCari.secili();
  if (!cari) return bildir('Müşteri seçilmedi.', 'hata');
  const tutar = tutarOku(el('odemeTutar').value);
  if (!(tutar > 0)) return bildir('Ödeme tutarı girilmedi.', 'hata');

  const dugme = el('odemeKaydet');
  dugme.disabled = true;
  try {
    const sonuc = await cagir('yazma:odeme', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      cariAd: cari.ad,
      tarih: el('odemeTarih').value || bugun(),
      tutar,
      fisNo: el('odemeFisNo').value.trim(),
      aciklama: el('odemeAciklama').value.trim(),
      duzenlenenIslemId: odemeDuzenleme ? odemeDuzenleme.islemId : null
    });
    bildir(
      (sonuc.duzenlendi ? "Ödeme Vega'da düzeltildi: " : "Ödeme Vega'ya yazıldı: ") +
      `${cari.ad} · ${para(sonuc.tutar)} TL` +
      (sonuc.fisNo ? ` · Fiş no: ${sonuc.fisNo}` : '') +
      ` · Belge no: ${sonuc.belgeNo}`,
      'basarili'
    );
    odemeDuzenlemesiniKapat(false);
    el('odemeTutar').value = '';
    el('odemeFisNo').value = '';
    el('odemeAciklama').value = '';
    await odemeCari.yenile();
    odemeGecmisiGetir();
    el('odemeTutar').focus();
  } catch (e) {
    bildir("Ödeme Vega'ya yazılamadı: " + e.message, 'hata');
  } finally {
    dugme.disabled = false;
  }
}

async function odemeGecmisiGetir() {
  if (!firmaSecildiMi()) return;
  const sira = ++odemeDurum.sira;
  const cari = odemeCari.secili();
  el('odemeRaporUst').innerHTML = '';
  el('odemeRaporAlt').innerHTML = '';
  boslukTemizle(el('odemeRaporGovde'), 8, 'Hazırlanıyor…');
  try {
    const veri = await cagir('rapor:odemeGecmisi', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari ? cari.cariInd : null,
      baslangic: el('odemeBaslangic').value || null,
      bitis: el('odemeBitis').value || null
    });
    if (sira !== odemeDurum.sira) return; // arkadan istenen liste daha yeni
    odemeDurum.veri = veri;
    odemeGecmisiCiz();
  } catch (e) {
    if (sira !== odemeDurum.sira) return;
    odemeDurum.veri = null;
    boslukTemizle(el('odemeRaporGovde'), 8, 'Ödemeler okunamadı: ' + e.message);
  }
}

function odemeGecmisiCiz() {
  const d = odemeDurum.veri;
  if (!d) return;
  const govde = el('odemeRaporGovde');
  const ust = el('odemeRaporUst');
  const alt = el('odemeRaporAlt');
  const parcalar = aramaParcalari(el('odemeArama').value);

  const satirlar = d.satirlar.filter((s) => !parcalar.length ||
    aramaPuani(`${s.cariAd} ${s.fisNo} ${s.belgeNo} ${s.aciklama}`, parcalar) >= 0);

  // Başlık: müşteri (ya da tüm müşteriler), tarih aralığı, varsa süzgeç.
  ust.innerHTML = '';
  ust.append(
    bilgiKutusu('MÜŞTERİ', d.cari ? d.cari.ad : 'Tüm müşteriler', true),
    bilgiKutusu('TARİH ARALIĞI', d.baslangic || d.bitis
      ? `${d.baslangic ? tarihYaz(d.baslangic) : '…'} — ${d.bitis ? tarihYaz(d.bitis) : '…'}`
      : 'Tüm dönem')
  );
  el('odemeRaporTablo').classList.toggle('tekCari', !!d.cari);

  govde.innerHTML = '';
  if (!satirlar.length) {
    boslukTemizle(govde, 8, d.satirlar.length
      ? 'Süzgece uyan ödeme yok.'
      : 'Bu aralıkta ödeme alınmamış.');
  } else {
    for (const s of satirlar) {
      const tr = raporSatiriEkle(govde, [
        [tarihYaz(s.tarih), ''],
        [s.kayitZamani ? tarihSaatYaz(s.kayitZamani) : '', 'islemZamani'],
        [s.cariAd, 'cariSutun'],
        [s.fisNo || '', ''],
        [s.belgeNo, ''],
        [s.aciklama, ''],
        [para(s.tutar), 'sayi']
      ]);
      // ✎ yalnız programın yazdığı ödemede (Vega'dan elle girilen ödeme
      // Vega'dan düzeltilir). Belge Gir'deki tahsilat belgesiyle açılır.
      const eylem = document.createElement('td');
      eylem.className = 'yazdirilmaz odemeEylem';
      if (durum.yazmaAcik && s.islemId && DUZENLENEBILIR_KONULAR.includes(s.islemKonu)) {
        eylem.appendChild(kalemDugmesi(s.islemId));
      }
      tr.appendChild(eylem);
    }
  }

  const toplam = satirlar.reduce((t, s) => t + s.tutar, 0);

  alt.innerHTML = '';
  const ozet = document.createElement('div');
  ozet.className = 'raporOzet';
  ozet.append(
    ozetKalemi('ÖDEME SAYISI', miktarYaz(satirlar.length)),
    ozetKalemi('TOPLAM ÖDEME', para(toplam), true)
  );
  const cari = odemeCari.secili();
  if (d.cari && cari && Number(cari.cariInd) === Number(d.cari.cariInd)) {
    ozet.insertBefore(ozetKalemi('GÜNCEL BAKİYE', para(cari.bakiye)), ozet.lastChild);
  }
  alt.appendChild(ozet);
  if (d.sinirda) {
    const not = document.createElement('p');
    not.className = 'ipucu yazdirilmaz';
    not.textContent = 'Liste 5000 satırda kesildi — tarih aralığını daraltın.';
    alt.appendChild(not);
  }
}

// ═══════════════════════ MÜŞTERİ LİSTESİ + YENİ CARİ KARTI ═══════════════════════

const cariKutulari = {
  belge: () => belgeCari,
  iade: () => iadeCari,
  ekstre: () => ekstreCari,
  odeme: () => odemeCari,
  alis: () => alisCari
};

let cariHedefi = 'belge';
let cariListesi = [];

document.querySelectorAll('[data-cari-liste]').forEach((d) => {
  d.addEventListener('click', () => cariListesiniAc(d.dataset.cariListe));
});

el('cariListeKapat').addEventListener('click', () => el('cariListePerde').classList.add('gizli'));
el('cariListeYenile').addEventListener('click', () => cariListesiniYukle());
el('cariListeTip').addEventListener('change', () => cariListesiniYukle());
el('cariListeBakiyeli').addEventListener('change', () => cariListesiniYukle());
el('cariListeArama').addEventListener('input', () => cariListesiniCiz());
// Perdeye (dışına) tıklayınca kapat.
for (const id of ['cariListePerde']) {
  el(id).addEventListener('click', (olay) => {
    if (olay.target === el(id)) el(id).classList.add('gizli');
  });
}

document.addEventListener('keydown', (olay) => {
  if (olay.key !== 'Escape') return;
  el('cariListePerde').classList.add('gizli');
  el('cariYeniPerde').classList.add('gizli');
});

async function cariListesiniAc(hedef) {
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  cariHedefi = hedef || 'belge';
  // Alış faturasında yalnız tedarikçiler (satıcı, perakende hariç).
  if (cariHedefi === 'alis') el('cariListeTip').value = 'tedarikci';
  else if (el('cariListeTip').value === 'tedarikci') el('cariListeTip').value = 'alici';
  el('cariListePerde').classList.remove('gizli');
  el('cariListeArama').value = '';
  el('cariListeArama').focus();
  await cariListesiniYukle();
}

async function cariListesiniYukle() {
  const govde = el('cariListeGovde');
  boslukTemizle(govde, 6, 'Yükleniyor…');
  try {
    cariListesi = await cagir('cari:liste', {
      firma: firmaKodu(),
      donem: donemKodu(),
      tip: el('cariListeTip').value || null,
      sadeceBakiyeli: el('cariListeBakiyeli').checked,
      // Belge ekranından açıldıysa oradaki toptan/perakende seçimi geçerli.
      musteriTipi: cariHedefi === 'belge' ? musteriTipi() : ''
    });
    cariListesiniCiz();
  } catch (e) {
    cariListesi = [];
    boslukTemizle(govde, 6, 'Liste okunamadı: ' + e.message);
  }
}

function cariListesiniCiz() {
  const govde = el('cariListeGovde');
  const parcalar = aramaParcalari(el('cariListeArama').value);
  const liste = parcalar.length
    ? aramayaGoreSirala(cariListesi, parcalar, (c) => `${c.ad} ${c.kod} ${c.adres} ${c.telefon}`)
    : cariListesi;

  govde.innerHTML = '';
  if (!liste.length) {
    boslukTemizle(govde, 6, 'Eşleşen müşteri yok.');
    el('cariListeBilgi').textContent = '';
    return;
  }

  for (const c of liste.slice(0, 500)) {
    const tr = document.createElement('tr');
    const hucreler = [
      [c.kod, ''], [c.ad, ''], [c.adres, ''], [c.telefon, ''], [c.tip, ''],
      [para(c.bakiye), 'sayi']
    ];
    for (const [metin, sinif] of hucreler) {
      const td = document.createElement('td');
      if (sinif) td.className = sinif;
      td.textContent = metin;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => cariSecildi(c));
    govde.appendChild(tr);
  }

  el('cariListeBilgi').textContent =
    `${liste.length} müşteri` + (liste.length > 500 ? ' (ilk 500 gösteriliyor, aramayı daraltın)' : '');
}

function cariSecildi(c) {
  el('cariListePerde').classList.add('gizli');

  if (cariHedefi === 'rapor') {
    // Ayrıntılı döküm artık Ekstre ekranında (27.08.2026).
    sekmeAc('ekstre');
    ekstreCari.sec(
      { cariInd: c.cariInd, kod: c.kod, ad: c.ad, adres: c.adres, bakiye: c.bakiye },
      { raporAc: true }
    );
    return;
  }

  const kutu = cariKutulari[cariHedefi] && cariKutulari[cariHedefi]();
  if (!kutu) return;
  // Ekstre ve Ödemeler kendi seçim geri çağrısında listeyi yeniden okur.
  kutu.sec({ cariInd: c.cariInd, kod: c.kod, ad: c.ad, adres: c.adres, bakiye: c.bakiye });
}

// ═══════════════════════ YENİ CARİ KARTI ═══════════════════════
//
// 07.09.2026'da kaldırılmıştı; 17.09.2026'da geri geldi. Alanlar Vega'nın
// kendi ekranından açılmış kartlarla sütun sütun karşılaştırılarak belirlendi
// (bkz. db/cari.js). Açılan kart, düğmenin bulunduğu ekrandaki müşteri
// kutusuna seçili gelir.

document.querySelectorAll('[data-cari-yeni]').forEach((d) => {
  d.addEventListener('click', () => cariYenisiniAc(d.dataset.cariYeni));
});
el('cariListeYeni').addEventListener('click', () => {
  el('cariListePerde').classList.add('gizli');
  cariYenisiniAc(cariHedefi);
});
el('cariYeniKapat').addEventListener('click', () => el('cariYeniPerde').classList.add('gizli'));
el('cariYeniKaydet').addEventListener('click', () => cariKartiniAc());
el('cariYeniTur').addEventListener('change', () => cariYeniTuruGoster());
el('cariYeniPerde').addEventListener('keydown', (olay) => {
  if (olay.key === 'Enter' && olay.target.tagName === 'INPUT') cariKartiniAc();
});

const CARI_YENI_GIRDILER = [
  'cariYeniKod', 'cariYeniAdi', 'cariYeniSoyadi', 'cariYeniUnvan', 'cariYeniTelefon',
  'cariYeniTelefon2', 'cariYeniSehir', 'cariYeniAdres', 'cariYeniVergiDairesi', 'cariYeniVergiNo'
];

function cariYeniTuruGoster() {
  const firma = el('cariYeniTur').value === 'firma';
  document.querySelectorAll('#cariYeniPerde .sahisAlani').forEach((a) => a.classList.toggle('gizli', firma));
  document.querySelectorAll('#cariYeniPerde .firmaAlani').forEach((a) => a.classList.toggle('gizli', !firma));
  el('cariYeniVergiNoEtiket').textContent = firma ? 'Vergi No' : 'TC Kimlik No';
  el('cariYeniVergiNo').maxLength = firma ? 10 : 11;
}

async function cariYenisiniAc(hedef) {
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  if (!durum.yazmaAcik) {
    bildir("Cari kartı açmak için Ayarlar ekranından \"Vega'ya yazmayı aç\" işaretlenmeli.", 'hata');
    return sekmeAc('ayar');
  }

  cariHedefi = hedef || 'belge';
  for (const id of CARI_YENI_GIRDILER) el(id).value = '';
  el('cariYeniTur').value = 'sahis';
  el('cariYeniTip').value = cariHedefi === 'alis' ? 'satici' : 'alici';
  cariYeniTuruGoster();
  el('cariYeniBilgi').textContent = 'Hazırlanıyor…';
  el('cariYeniKaydet').disabled = true;
  el('cariYeniPerde').classList.remove('gizli');

  // Arama kutusuna yazılmış ad varsa forma taşı: "müşteri yok, açayım" akışı.
  const aramaKutusu = { belge: 'cariArama', ekstre: 'ekstreCariArama', odeme: 'odemeCariArama', alis: 'alisCariArama' }[cariHedefi];
  const yazilan = aramaKutusu ? el(aramaKutusu).value.trim() : '';
  if (yazilan) {
    const parcalar = yazilan.split(/\s+/);
    el('cariYeniSoyadi').value = parcalar.length > 1 ? parcalar.pop() : '';
    el('cariYeniAdi').value = parcalar.join(' ');
  }

  try {
    const bilgi = await cagir('cari:formBilgisi', { firma: firmaKodu(), donem: donemKodu() });
    el('cariYeniKod').value = bilgi.onerilenKod || '';
    const secim = el('cariYeniOzelKod1');
    secim.innerHTML = '<option value="">(boş)</option>';
    for (const deger of bilgi.ozelKod1) {
      const o = document.createElement('option');
      o.value = deger;
      o.textContent = deger;
      secim.appendChild(o);
    }
    // Belge ekranında Özel Kod 1 süzgeci seçiliyse yeni kart da o tipten açılır.
    const varsayilan = cariHedefi === 'belge' ? musteriTipi() : '';
    secim.value = bilgi.ozelKod1.includes(varsayilan) ? varsayilan : '';
    el('cariYeniBilgi').textContent = '';
    el('cariYeniKaydet').disabled = false;
  } catch (e) {
    el('cariYeniBilgi').textContent = 'Form bilgisi okunamadı: ' + e.message;
    return;
  }
  (yazilan ? el('cariYeniKod') : el('cariYeniAdi')).focus();
}

async function cariKartiniAc() {
  const dugme = el('cariYeniKaydet');
  if (dugme.disabled) return;
  const bilgi = el('cariYeniBilgi');
  const firma = el('cariYeniTur').value === 'firma';

  if (!el('cariYeniKod').value.trim()) {
    bilgi.textContent = 'Cari kodu boş bırakılamaz.';
    return el('cariYeniKod').focus();
  }
  const adKutusu = firma ? el('cariYeniUnvan') : el('cariYeniAdi');
  if (!adKutusu.value.trim()) {
    bilgi.textContent = firma ? 'Firma ünvanı boş bırakılamaz.' : 'Adı boş bırakılamaz.';
    return adKutusu.focus();
  }

  dugme.disabled = true;
  bilgi.textContent = 'Kart açılıyor…';
  try {
    const sonuc = await cagir('cari:ac', {
      firma: firmaKodu(),
      donem: donemKodu(),
      tarih: bugun(),
      tur: el('cariYeniTur').value,
      kod: el('cariYeniKod').value.trim(),
      adi: el('cariYeniAdi').value.trim(),
      soyadi: el('cariYeniSoyadi').value.trim(),
      unvan: el('cariYeniUnvan').value.trim(),
      telefon: el('cariYeniTelefon').value.trim(),
      telefon2: el('cariYeniTelefon2').value.trim(),
      sehir: el('cariYeniSehir').value.trim(),
      adres: el('cariYeniAdres').value.trim(),
      vergiDairesi: el('cariYeniVergiDairesi').value.trim(),
      vergiNo: el('cariYeniVergiNo').value.trim(),
      ozelKod1: el('cariYeniOzelKod1').value,
      tip: el('cariYeniTip').value
    });
    el('cariYeniPerde').classList.add('gizli');
    bildir(`Cari kartı açıldı: ${sonuc.ad} (kod ${sonuc.kod}) · ${sonuc.tip}`, 'basarili');
    cariSecildi({
      cariInd: sonuc.cariInd,
      kod: sonuc.kod,
      ad: sonuc.ad,
      adres: sonuc.adres,
      bakiye: 0
    });
  } catch (e) {
    bilgi.textContent = 'Açılamadı: ' + e.message;
  } finally {
    dugme.disabled = false;
  }
}

// ═══════════════════════ AYARLAR ═══════════════════════

function ayarSayfasiniDoldur() {
  const a = durum.ayar;
  if (!a) return;
  el('aySunucu').value = a.sunucu || '';
  el('ayPort').value = a.port || 1433;
  el('ayKullanici').value = a.kullanici || '';
  el('aySifre').value = '';
  el('aySifre').placeholder = a.sifreGirildi ? '(kayıtlı — değiştirmek için yazın)' : '';
  el('ayVegaDb').value = a.vegaVeritabani || '';
  el('ayKdv').value = a.varsayilanKdv != null ? a.varsayilanKdv : 0;
  el('ayOnek').value = a.belgeOneki || 'H';
  el('ayYazmaAktif').checked = !!a.vegayaYazmaAktif;
  el('surumBilgi').textContent = a.surum ? `Kurulu sürüm: ${a.surum}` : '';
  firmaSecimDoldur();
  depoSecimDoldur();
  kasaKartlariTablosunuDoldur();
}

function firmaSecimDoldur() {
  const fs = el('ayFirma');
  fs.innerHTML = '';
  const bos = document.createElement('option');
  bos.value = '';
  bos.textContent = '— seçin —';
  fs.appendChild(bos);

  for (const f of durum.firmalar) {
    const o = document.createElement('option');
    o.value = f.kod;
    o.textContent = `${f.kisaAd} (${f.kod})`;
    if (f.kod === firmaKodu()) o.selected = true;
    fs.appendChild(o);
  }
  donemSecimDoldur();
}

function donemSecimDoldur() {
  const ds = el('ayDonem');
  ds.innerHTML = '';
  const firma = durum.firmalar.find((f) => f.kod === el('ayFirma').value);
  if (!firma) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '— firma seçin —';
    ds.appendChild(o);
    return;
  }
  for (const d of firma.donemler) {
    const bilgi = (firma.donemBilgi || []).find((b) => b.donem === d) || {};
    const o = document.createElement('option');
    o.value = d;
    const parcalar = [d];
    if (bilgi.hareket) parcalar.push(`${bilgi.hareket.toLocaleString('tr-TR')} hareket`);
    if (bilgi.sonTarih) parcalar.push('son ' + tarihYaz(bilgi.sonTarih));
    o.textContent = parcalar.join(' · ');
    if (d === donemKodu() || (!donemKodu() && d === firma.varsayilanDonem)) o.selected = true;
    ds.appendChild(o);
  }
}

el('ayFirma').addEventListener('change', donemSecimDoldur);

function depoSecimDoldur() {
  const ds = el('ayDepo');
  ds.innerHTML = '';
  const secili = durum.ayar ? Number(durum.ayar.varsayilanDepo) : 1;
  if (!durum.depolar.length) {
    const o = document.createElement('option');
    o.value = String(secili || 1);
    o.textContent = 'Depo ' + (secili || 1);
    ds.appendChild(o);
    return;
  }
  for (const d of durum.depolar) {
    const o = document.createElement('option');
    o.value = String(d.no);
    o.textContent = `${d.no} — ${d.ad || d.kod || ''}`.trim();
    if (Number(d.no) === secili) o.selected = true;
    ds.appendChild(o);
  }
}

el('ayFirmaYenile').addEventListener('click', async () => {
  el('ayFirmaYenile').disabled = true;
  try {
    durum.firmalar = await cagir('firma:liste', { yenile: true });
    durum.depolar = await cagir('firma:depolar', {});
    firmaSecimDoldur();
    depoSecimDoldur();
    bildir('Firma listesi yenilendi.', 'basarili');
  } catch (e) {
    bildir('Firma listesi okunamadı: ' + e.message, 'hata');
  } finally {
    el('ayFirmaYenile').disabled = false;
  }
});

el('ayBaglantiTest').addEventListener('click', async () => {
  const sonuc = el('ayBaglantiSonuc');
  sonuc.textContent = 'Deneniyor…';
  try {
    // Test, ekranda yazılı ayarla yapılsın — kaydetmeden denenebilmeli.
    await ayarlariKaydet(true);
    const t = await cagir('baglanti:test', {});
    sonuc.textContent = `Bağlandı: ${t.sunucu} / ${t.veritabani} · ${t.surum}`;
  } catch (e) {
    sonuc.textContent = 'Bağlanamadı: ' + e.message;
  }
});

el('ayKaydet').addEventListener('click', async () => {
  try {
    await ayarlariKaydet(false);
    await baslangicVerisiniYukle();
    el('ayBilgi').textContent = 'Ayarlar kaydedildi.';
    bildir('Ayarlar kaydedildi.', 'basarili');
  } catch (e) {
    el('ayBilgi').textContent = 'Kaydedilemedi: ' + e.message;
    bildir('Ayarlar kaydedilemedi: ' + e.message, 'hata');
  }
});

async function ayarlariKaydet(sessiz) {
  const yeni = {
    sunucu: el('aySunucu').value.trim(),
    port: Number(el('ayPort').value) || 1433,
    kullanici: el('ayKullanici').value.trim(),
    vegaVeritabani: el('ayVegaDb').value.trim() || 'VEGADB',
    // windowsGirisi arayüzde yok: msnodesqlv8 sürücüsü kurulum dosyasına
    // paketlenmiyor, o yüzden kurulu programda çalışamaz. Ayar dosyasında
    // duruyor; sürücüyü kurup yeniden derleyen biri elle açabilir.
    varsayilanFirma: el('ayFirma').value,
    varsayilanDonem: el('ayDonem').value,
    varsayilanDepo: Number(el('ayDepo').value) || 1,
    varsayilanKdv: sayiOku(el('ayKdv').value),
    belgeOneki: el('ayOnek').value.trim().toUpperCase() || 'H',
    vegayaYazmaAktif: el('ayYazmaAktif').checked
  };
  const sifre = el('aySifre').value;
  if (sifre) yeni.sifre = sifre;

  durum.ayar = await cagir('ayar:yaz', yeni);
  el('aySifre').value = '';
  el('aySifre').placeholder = durum.ayar.sifreGirildi
    ? '(kayıtlı — değiştirmek için yazın)'
    : '';
  ustCubugunuGuncelle();
  if (!sessiz) durum.stoklar = [];
  return durum.ayar;
}

// --- Sürüm ve otomatik güncelleme -------------------------------------------
//
// db/guncelleme.js açılışta (ve sonra 4 saatte bir) GitHub Releases'i
// kontrol edip arka planda indiriyor; durum değiştikçe 'guncelleme:durum'
// kanalından ana süreçten buraya PUSH ediliyor (preload.js → dinle()).
// Üst çubukta yalnızca kullanıcının bilmesi/bekleyebileceği durumlar
// gösteriliyor (iniyor/hazır/hata) — "güncel" ya da "kontrol ediliyor" sessiz
// kalıyor, arayüz gereksiz yere kirlenmesin. Ayarlar sayfasındaki ipucu
// her durumu (kısaltmadan) gösteriyor.
function guncellemeDurumunuGoster(bilgi) {
  if (!bilgi) return;
  // Ayarlar sayfasındaki ipucu ayrıntılı, üst çubuktaki etiket kısa —
  // `.etiket` nowrap olduğu için uzun metin üst çubuğu taşırır.
  const ayrintiliMetinler = {
    bakiliyor: 'Güncelleme kontrol ediliyor…',
    guncel: 'Program güncel.',
    bulundu: bilgi.surum ? `Yeni sürüm bulundu: ${bilgi.surum}` : 'Yeni sürüm bulundu.',
    iniyor: bilgi.mesaj || 'Yeni sürüm iniyor…',
    hazir: bilgi.surum
      ? `Yeni sürüm hazır: ${bilgi.surum} — program kapanıp yeniden açılınca kurulacak.`
      : 'Yeni sürüm hazır — program kapanıp yeniden açılınca kurulacak.',
    hata: bilgi.mesaj || 'Güncelleme kontrol edilemedi.',
    kapali: 'Otomatik güncelleme bu sürümde kapalı.'
  };
  const kisaMetinler = {
    iniyor: bilgi.mesaj && /%\d/.test(bilgi.mesaj) ? 'Güncelleme ' + bilgi.mesaj.match(/%\d+/)[0] + ' iniyor' : 'Güncelleme iniyor…',
    hazir: 'Güncelleme hazır — yeniden başlatınca kurulacak',
    hata: 'Güncelleme kontrol edilemedi'
  };

  const sonucKutusu = el('guncellemeSonuc');
  if (sonucKutusu) {
    sonucKutusu.textContent = ayrintiliMetinler[bilgi.durum] != null
      ? ayrintiliMetinler[bilgi.durum]
      : (bilgi.mesaj || '');
  }

  const ustEtiket = el('guncellemeEtiketi');
  if (kisaMetinler[bilgi.durum]) {
    ustEtiket.textContent = kisaMetinler[bilgi.durum];
    ustEtiket.className = 'etiket ' + (bilgi.durum === 'hata' ? 'kapali' : 'acik');
    ustEtiket.classList.remove('gizli');
  } else {
    ustEtiket.classList.add('gizli');
  }
}

if (window.api.dinle) {
  // Açılışta (baslat() bitmeden) gelebilecek bir push kaçmasın diye üst
  // seviyede, en baştan dinleniyor.
  window.api.dinle('guncelleme:durum', guncellemeDurumunuGoster);
  // Güncelleme sonrası bakım eksik Vega kasa kartlarını açınca seçim listeleri tazelenir.
  window.api.dinle('kasaKartlari:degisti', () => { if (firmaSecildiMi()) kasaKartlariniYukle(); });
}

el('guncellemeKontrol').addEventListener('click', async () => {
  const dugme = el('guncellemeKontrol');
  dugme.disabled = true;
  try {
    const bilgi = await cagir('guncelleme:kontrol', {});
    guncellemeDurumunuGoster(bilgi);
  } catch (e) {
    el('guncellemeSonuc').textContent = 'Kontrol edilemedi: ' + e.message;
  } finally {
    dugme.disabled = false;
  }
});

// --- Kasa tipleri (seçili firmadaki Vega KASA kartları) ----------------------
//
// Liste yalnız seçili firmada KOD1 = 'KASA' Vega kartı olan tiplerden oluşur.
// Eklenen ya da kaydedilen tip aynı işlemde Vega kartına yazılır; kartı yoksa
// açılır (db/yardimci.js → kasaTipiKaydet). Kod, geçmiş belgeler ve Vega kartı
// ona bağlı olduğu için kayıtlı satırda değiştirilemez. İlk satır her zaman
// yeni kasa tipi eklemek için boş kalır.

function kasaKartlariTablosunuDoldur() {
  const govde = el('kasaTipiGovde');
  govde.innerHTML = '';
  govde.appendChild(kasaTipiEkleSatiri());
  if (!durum.kasaKartlari.length) {
    const bosTr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'ipucu';
    td.textContent = 'Henüz kasa tipi eklenmedi — yukarıdan ekleyin.';
    bosTr.appendChild(td);
    govde.appendChild(bosTr);
    return;
  }
  for (const k of durum.kasaKartlari) govde.appendChild(kasaKartiSatiri(k));
}

function sayiGirdisi(deger, yerTutucu) {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'sayi';
  i.inputMode = 'decimal';
  if (yerTutucu) i.placeholder = yerTutucu;
  if (deger != null) i.value = String(deger).replace('.', ',');
  return i;
}

function kasaTipiEkleSatiri() {
  const tr = document.createElement('tr');

  const kodHucre = document.createElement('td');
  const kodGirdi = document.createElement('input');
  kodGirdi.type = 'text';
  kodGirdi.placeholder = 'ör. PK';
  kodHucre.appendChild(kodGirdi);

  const adHucre = document.createElement('td');
  const adGirdi = document.createElement('input');
  adGirdi.type = 'text';
  adGirdi.placeholder = 'ör. Paket Kasa';
  adHucre.appendChild(adGirdi);

  const depozitoHucre = document.createElement('td');
  const depozitoGirdi = sayiGirdisi(null, 'TL');
  depozitoHucre.appendChild(depozitoGirdi);

  const daraHucre = document.createElement('td');
  const daraGirdi = sayiGirdisi(null, 'kg');
  daraHucre.appendChild(daraGirdi);

  const eylemHucre = document.createElement('td');
  const ekle = document.createElement('button');
  ekle.type = 'button';
  ekle.className = 'dugme mini birincil';
  ekle.textContent = 'Ekle';
  ekle.addEventListener('click', async () => {
    const kod = kodGirdi.value.trim();
    if (!kod) return bildir('Kasa tipi kodu boş olamaz.', 'hata');
    ekle.disabled = true;
    try {
      const sonuc = await cagir('yardimci:kasaTipiKaydet', {
        firma: firmaKodu(), donem: donemKodu(),
        kod, ad: adGirdi.value.trim(),
        dara: sayiOku(daraGirdi.value),
        depozito: sayiOku(depozitoGirdi.value)
      });
      bildir(sonuc.kartAcildi
        ? `"${kod}" kasa tipi eklendi ve Vega'da KASA stok kartı açıldı.`
        : `"${kod}" kasa tipi Vega'daki kasa kartına bağlandı.`, 'basarili');
      await kasaKartlariniYukle();
    } catch (e) {
      bildir('Eklenemedi: ' + e.message, 'hata');
    } finally {
      ekle.disabled = false;
    }
  });
  eylemHucre.appendChild(ekle);

  tr.append(kodHucre, adHucre, depozitoHucre, daraHucre, eylemHucre);
  return tr;
}

function kasaKartiSatiri(kasa) {
  const tr = document.createElement('tr');

  const kodHucre = document.createElement('td');
  const kodGirdi = document.createElement('input');
  kodGirdi.type = 'text';
  kodGirdi.value = kasa.kod;
  kodGirdi.readOnly = true;
  kodGirdi.title = 'Kod değiştirilemez; geçmiş belgeler ve Vega kartı bu koda bağlı.';
  kodHucre.appendChild(kodGirdi);

  const adHucre = document.createElement('td');
  const adGirdi = document.createElement('input');
  adGirdi.type = 'text';
  adGirdi.value = kasa.ad;
  adHucre.appendChild(adGirdi);

  const depozitoHucre = document.createElement('td');
  const depozitoGirdi = sayiGirdisi(kasa.depozito);
  depozitoHucre.appendChild(depozitoGirdi);

  const daraHucre = document.createElement('td');
  const daraGirdi = sayiGirdisi(kasa.dara);
  daraHucre.appendChild(daraGirdi);

  const eylemHucre = document.createElement('td');

  const kaydet = document.createElement('button');
  kaydet.type = 'button';
  kaydet.className = 'dugme mini birincil';
  kaydet.textContent = 'Kaydet';
  kaydet.addEventListener('click', async () => {
    kaydet.disabled = true;
    try {
      await cagir('yardimci:kasaTipiKaydet', {
        firma: firmaKodu(), donem: donemKodu(),
        id: kasa.id, kod: kasa.kod, ad: adGirdi.value.trim(),
        dara: sayiOku(daraGirdi.value),
        depozito: sayiOku(depozitoGirdi.value)
      });
      bildir("Kaydedildi; Vega kasa kartı da güncellendi.", 'basarili');
      await kasaKartlariniYukle();
    } catch (e) {
      bildir('Kaydedilemedi: ' + e.message, 'hata');
    } finally {
      kaydet.disabled = false;
    }
  });

  const sil = document.createElement('button');
  sil.type = 'button';
  sil.className = 'dugme mini ucuncul';
  sil.textContent = 'Sil';
  sil.addEventListener('click', async () => {
    const onay = await cagir('onay', {
      baslik: 'Kasa tipini sil',
      mesaj: `"${kasa.kod}" kasa tipi silinsin mi?`,
      ayrinti: 'Bu tip artık seçilemez. Vega stok kartı ve geçmiş kasa hareketleri silinmez.',
      tamamBaslik: 'Sil'
    });
    if (!onay.onaylandi) return;
    sil.disabled = true;
    try {
      await cagir('yardimci:kasaTipiSil', { id: kasa.id });
      bildir('Silindi.', 'basarili');
      await kasaKartlariniYukle();
    } catch (e) {
      bildir('Silinemedi: ' + e.message, 'hata');
      sil.disabled = false;
    }
  });

  eylemHucre.append(kaydet, sil);
  tr.append(kodHucre, adHucre, depozitoHucre, daraHucre, eylemHucre);
  return tr;
}

// ═══════════════════════ Açılış ═══════════════════════

function ustCubugunuGuncelle() {
  const a = durum.ayar;
  const firmaEt = el('firmaEtiketi');
  const firma = durum.firmalar.find((f) => f.kod === (a ? a.varsayilanFirma : ''));
  firmaEt.textContent = firma
    ? `${firma.kisaAd} · ${a.varsayilanDonem}`
    : 'Firma seçilmedi';

  durum.yazmaAcik = !!(a && a.vegayaYazmaAktif);
  const yazmaEt = el('yazmaEtiketi');
  yazmaEt.textContent = durum.yazmaAcik
    ? "Vega'ya yazma: AÇIK"
    : "Vega'ya yazma: kapalı";
  yazmaEt.className = 'etiket ' + (durum.yazmaAcik ? 'acik' : 'kapali');
}

// Süzgeç kutularını cari kartlarındaki gerçek Özel Kod 1 değerleriyle doldurur.
// Hiç değer yoksa (ya da kurulumda KOD1 sütunu yoksa) süzgeç alanı gizlenir.
let ozelKodIlkYukleme = true;

async function ozelKodlariYukle() {
  try {
    durum.ozelKod1 = await cagir('vega:ozelKod1', {
      firma: firmaKodu(), donem: donemKodu()
    });
  } catch (e) {
    durum.ozelKod1 = [];
  }
  ozelKodSecimiDoldur(el('musteriTipi'), el('musteriTipiAlani'),
    ozelKodIlkYukleme ? 'TOPTAN' : null);
  ozelKodIlkYukleme = false;
}

function ozelKodSecimiDoldur(secim, alan, varsayilan) {
  const eski = secim.value;
  secim.innerHTML = '';
  const hepsi = document.createElement('option');
  hepsi.value = '';
  hepsi.textContent = 'Hepsi';
  secim.appendChild(hepsi);

  for (const k of durum.ozelKod1) {
    const o = document.createElement('option');
    o.value = k.deger;
    o.textContent = `${k.deger} (${k.adet})`;
    secim.appendChild(o);
  }

  // İlk yüklemede varsayılan denenir, sonrakilerde kullanıcının seçimi korunur.
  // Firma değişip değer listede kalmadıysa "Hepsi"ye düşülür.
  const aday = String(varsayilan == null ? eski : varsayilan);
  const bulunan = durum.ozelKod1.find(
    (k) => k.deger.toLocaleLowerCase('tr') === aday.toLocaleLowerCase('tr')
  );
  secim.value = bulunan ? bulunan.deger : '';
  if (alan) alan.classList.toggle('gizli', durum.ozelKod1.length === 0);
}

async function kasaKartlariniYukle() {
  try {
    durum.kasaKartlari = await cagir('yardimci:kasaTipleri', {
      sadeceAktif: true, firma: firmaKodu(), donem: donemKodu()
    });
  } catch (e) {
    durum.kasaKartlari = [];
    bildir('Kasa tipleri okunamadı: ' + e.message, 'hata');
  }
  iadeSatirSecimleriniTazele();
  kasaSatirSecimleriniTazele();
  kasaKartlariTablosunuDoldur();
  await kasaTipiSorunlariniGoster();
}

// Programda aktif olduğu halde Vega kartı kullanılamadığı için listeye
// gelmeyen tipler (ör. kodu KASA işaretsiz bir ürün kartında duran tip).
async function kasaTipiSorunlariniGoster() {
  const kutu = el('kasaTipiSorunlari');
  let sorunlar = [];
  try {
    sorunlar = await cagir('yardimci:kasaTipiSorunlari', { firma: firmaKodu(), donem: donemKodu() });
  } catch (e) {
    sorunlar = [];
  }
  kutu.textContent = sorunlar.length
    ? 'Listelenmeyen kasa tipleri: ' + sorunlar.map((s) => s.neden).join(' · ')
    : '';
  kutu.classList.toggle('gizli', !sorunlar.length);
}

// Açılışta ilk ürün satırı, kasa kartları Vega'dan gelmeden ÖNCE kuruluyor
// (baslat() önce satirEkle() çağırıyor, kasaKartlariniYukle() sonra bitiyor).
// O satırın kasa tipi kutusu, kartlar oluşturulduğu andaki (boş) listeyle
// dolduğu için kalıcı olarak boş kalırdı — burada var olan tüm satırların
// kutusu, kartlar geldikten sonra yeniden kuruluyor. Seçili değer varsa korunur.
function kasaSatirSecimleriniTazele() {
  for (const tr of el('satirGovde').children) {
    const s = tr._satir;
    if (!s || !s.tipSecim) continue;
    const eskiDeger = s.tipSecim.value;
    const yeni = kasaKartiSecenekleri(eskiDeger);
    yeni.addEventListener('change', toplamlariGuncelle);
    s.tipSecim.replaceWith(yeni);
    s.tipSecim = yeni;
  }
}

async function baslangicVerisiniYukle() {
  durum.ayar = await cagir('ayar:oku', {});

  try {
    durum.firmalar = await cagir('firma:liste', {});
  } catch (e) {
    durum.firmalar = [];
    bildir(
      'Veritabanına bağlanılamadı: ' + e.message +
      ' — Ayarlar ekranından sunucu ve şifreyi kontrol edin.',
      'hata'
    );
    ustCubugunuGuncelle();
    sekmeAc('ayar');
    return;
  }

  try {
    durum.depolar = await cagir('firma:depolar', {});
  } catch (e) {
    durum.depolar = [];
  }

  ustCubugunuGuncelle();

  if (!firmaSecildiMi()) {
    bildir('Firma ve dönem seçilmemiş. Ayarlar ekranından seçip kaydedin.', '');
    sekmeAc('ayar');
    return;
  }

  await kasaKartlariniYukle();
  await ozelKodlariYukle();

  try {
    durum.stoklar = await cagir('vega:stoklar', {
      firma: firmaKodu(),
      donem: donemKodu(),
      limit: 2000
    });
    stokListesiniDoldur();
  } catch (e) {
    durum.stoklar = [];
    bildir('Stok kartları okunamadı: ' + e.message, 'hata');
  }
}

async function baslat() {
  const bugunMetni = bugun();
  el('belgeTarih').value = bugunMetni;
  el('iadeTarih').value = bugunMetni;
  el('odemeTarih').value = bugunMetni;
  el('alisTarih').value = bugunMetni;
  const buAy = new Date();
  el('odemeBaslangic').value = tarihKutusu(new Date(buAy.getFullYear(), buAy.getMonth(), 1));
  el('odemeBitis').value = bugunMetni;

  satirEkle();
  toplamlariGuncelle();
  alisSatirEkle(false);

  await baslangicVerisiniYukle();
  alisKdvVarsayilani();

  // Ana süreçteki guncelleme.baslat() pencere açılır açılmaz (bu betik
  // yüklenmeden önce) tetiklenebiliyor; ilk push kaçmış olabilir diye
  // mevcut durum bir kere de burada çekiliyor (yeni kontrol başlatmaz,
  // yalnızca son bilineni okur — ucuz ve zararsız).
  try {
    guncellemeDurumunuGoster(await cagir('guncelleme:durum', {}));
  } catch (e) { /* güncelleme bilgisi olmasa da program çalışır */ }
}

baslat();
