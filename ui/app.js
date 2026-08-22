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
  depolar: [],
  kasaKartlari: [],   // canlı Vega'dan: {id(=stokNo), kod, ad, depozito, dara}
  stoklar: [],
  stokHaritasi: new Map(),
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

function sekmeAc(ad) {
  document.querySelectorAll('.sekme').forEach((d) => {
    d.classList.toggle('etkin', d.dataset.sekme === ad);
  });
  document.querySelectorAll('.sayfa').forEach((s) => {
    s.classList.toggle('etkin', s.id === 'sayfa-' + ad);
  });
  if (ad === 'kasa') kasaBakiyesiniYukle();
  if (ad === 'belgeler') belgelerYukle();
  if (ad === 'ayar') ayarSayfasiniDoldur();
}

// ═══════════════════════ Müşteri arama kutusu ═══════════════════════
//
// Üç yerde kullanılıyor (belge, kasa iadesi, ekstre). Arama sunucuda yapılıyor:
// cari sayısı binleri geçtiğinde hepsini indirip tarayan yaklaşım açılışı
// yavaşlatıyor.

function cariKutusuKur(aramaId, sonucId, seciliId, secildiginde) {
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

    const ad = document.createElement('b');
    ad.textContent = cari.ad + (cari.kod ? ' (' + cari.kod + ')' : '');
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
      const liste = await cagir('vega:cariler', {
        firma: firmaKodu(),
        donem: donemKodu(),
        arama: metin,
        limit: 40
      });
      sonuc.innerHTML = '';
      if (!liste.length) {
        sonuc.innerHTML = '<div class="bos">Eşleşen müşteri yok.</div>';
      } else {
        for (const c of liste) {
          const d = document.createElement('button');
          d.type = 'button';
          const sol = document.createElement('span');
          sol.textContent = c.ad;
          const sag = document.createElement('span');
          sag.className = 'kod';
          sag.textContent = (c.kod ? c.kod + ' · ' : '') + para(c.bakiye) + ' TL';
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
    temizle: () => { secimiGoster(null); arama.value = ''; },
    yenile: async () => {
      if (!seciliCari) return;
      try {
        const b = await cagir('vega:bakiye', {
          firma: firmaKodu(),
          donem: donemKodu(),
          cariInd: seciliCari.cariInd
        });
        secimiGoster(Object.assign({}, seciliCari, { bakiye: b }));
      } catch (e) { /* bakiye tazelenemezse eskisi kalsın */ }
    }
  };
}

const belgeCari = cariKutusuKur('cariArama', 'cariSonuc', 'cariSecili', null);
const iadeCari = cariKutusuKur('iadeCariArama', 'iadeCariSonuc', 'iadeCariSecili', () =>
  iadeBilgisiniGuncelle()
);
const ekstreCari = cariKutusuKur('ekstreCariArama', 'ekstreCariSonuc', 'ekstreCariSecili', null);

// ═══════════════════════ BELGE GİR ═══════════════════════

function stokListesiniDoldur() {
  const liste = el('stokListesi');
  liste.innerHTML = '';
  durum.stokHaritasi = new Map();
  for (const s of durum.stoklar) {
    // Aynı isimde iki kart olabiliyor; ayırt etmek için koda düşüyoruz.
    const etiket = durum.stokHaritasi.has(s.ad) && s.kod ? `${s.ad} [${s.kod}]` : s.ad;
    durum.stokHaritasi.set(etiket, s);
    const o = document.createElement('option');
    o.value = etiket;
    liste.appendChild(o);
  }
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
  stok.setAttribute('list', 'stokListesi');
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

  const tutarHucre = document.createElement('td');
  tutarHucre.className = 'hesaplanan';
  tutarHucre.textContent = '0,00';

  const kasaTutarHucre = document.createElement('td');
  kasaTutarHucre.className = 'hesaplanan';
  kasaTutarHucre.textContent = '0,00';

  const silHucre = document.createElement('td');
  silHucre.className = 'sayi';
  const sil = document.createElement('button');
  sil.type = 'button';
  sil.className = 'dugme mini ucuncul';
  sil.textContent = 'Sil';
  sil.addEventListener('click', () => {
    tr.remove();
    if (!govde.children.length) satirEkle();
    toplamlariGuncelle();
  });
  silHucre.appendChild(sil);

  tr.append(
    stokHucre, kasaAdedi.td, tipHucre, brutMiktar.td, daraHucre,
    daraliMiktarHucre, fiyat.td, tutarHucre, kasaTutarHucre, silHucre
  );
  govde.appendChild(tr);

  // Satır verisini DOM'da değil burada tutuyoruz; hesaplama tek yerden geçiyor.
  tr._satir = {
    stokGirdi: stok,
    brutMiktarGirdi: brutMiktar.girdi,
    kasaAdediGirdi: kasaAdedi.girdi,
    tipSecim: tip,
    fiyatGirdi: fiyat.girdi,
    daraHucre,
    daraliMiktarHucre,
    tutarHucre,
    kasaTutarHucre
  };

  stok.addEventListener('change', () => {
    const kart = durum.stokHaritasi.get(stok.value.trim());
    if (kart && kart.fiyat) {
      fiyat.girdi.value = String(kart.fiyat).replace('.', ',');
    }
    toplamlariGuncelle();
  });

  [stok, brutMiktar.girdi, kasaAdedi.girdi, fiyat.girdi].forEach((i) => {
    i.addEventListener('input', toplamlariGuncelle);
  });
  tip.addEventListener('change', toplamlariGuncelle);

  // Hızlı giriş: son alanda Enter yeni satır açar.
  fiyat.girdi.addEventListener('keydown', (olay) => {
    if (olay.key === 'Enter') {
      olay.preventDefault();
      const sonuncu = govde.lastElementChild === tr;
      if (sonuncu) satirEkle();
      const sonraki = tr.nextElementSibling;
      if (sonraki && sonraki._satir) sonraki._satir.stokGirdi.focus();
    }
  });

  stok.focus();
  return tr;
}

function satirOku(tr) {
  const s = tr._satir;
  if (!s) return null;

  const etiket = s.stokGirdi.value.trim();
  const stok = durum.stokHaritasi.get(etiket) || null;
  const brutMiktar = sayiOku(s.brutMiktarGirdi.value);
  const kasaAdedi = sayiOku(s.kasaAdediGirdi.value);
  const fiyat = sayiOku(s.fiyatGirdi.value);
  const kasaStokNo = s.tipSecim.value ? Number(s.tipSecim.value) : null;
  const kasa = kasaStokNo ? durum.kasaKartlari.find((k) => k.id === kasaStokNo) : null;

  const kasaDarasi = kasa ? (kasa.dara || 0) : 0;
  const dara = Math.round(kasaAdedi * kasaDarasi * 1000) / 1000;
  const daraliMiktar = Math.round(Math.max(brutMiktar - dara, 0) * 1000) / 1000;
  const tutar = Math.round(daraliMiktar * fiyat * 100) / 100;
  const kasaDepozito = kasa ? kasa.depozito : 0;
  const kasaTutari = Math.round(kasaAdedi * kasaDepozito * 100) / 100;

  return {
    etiket, stok, brutMiktar, dara, daraliMiktar, kasaAdedi, fiyat, tutar,
    kasaStokNo,
    kasaTipiKod: kasa ? kasa.kod : null,
    kasaTipiAdi: kasa ? kasa.ad : null,
    kasaDarasi,
    kasaDepozito,
    kasaTutari,
    bos: !etiket && !brutMiktar && !kasaAdedi && !fiyat
  };
}

function toplamlariGuncelle() {
  let urun = 0;
  let kasa = 0;
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
  }
  const tahsilat = sayiOku(el('tahsilat').value);
  el('urunToplam').textContent = para(urun);
  el('kasaToplam').textContent = para(kasa);
  el('genelToplam').textContent = para(urun + kasa);
  el('kalanToplam').textContent = para(urun + kasa - tahsilat);
}

el('satirEkle').addEventListener('click', () => satirEkle());
el('tahsilat').addEventListener('input', () => toplamlariGuncelle());

el('formTemizle').addEventListener('click', () => {
  el('satirGovde').innerHTML = '';
  satirEkle();
  el('fisNo').value = '';
  el('tahsilat').value = '';
  belgeCari.temizle();
  el('sonKayit').classList.add('gizli');
  toplamlariGuncelle();
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

  const satirlar = [];
  for (const tr of el('satirGovde').children) {
    const s = satirOku(tr);
    if (!s || s.bos) continue;
    if (!s.stok) {
      return bildir(`"${s.etiket}" listede yok. Ürünü açılan listeden seçin.`, 'hata');
    }
    if (!(s.brutMiktar > 0)) {
      return bildir(`"${s.stok.ad}" için brüt miktar girilmedi.`, 'hata');
    }
    if (s.kasaAdedi > 0 && !s.kasaStokNo) {
      return bildir(`"${s.stok.ad}" için kasa adedi var ama kasa tipi seçilmedi.`, 'hata');
    }
    satirlar.push({
      stokNo: s.stok.stokNo,
      stokKodu: s.stok.kod,
      stokAdi: s.stok.ad,
      birim: s.stok.birim,
      birimEx: s.stok.birimEx,
      daraliMiktar: s.daraliMiktar,
      kasaAdedi: s.kasaAdedi,
      kasaStokNo: s.kasaStokNo,
      kasaTipiKod: s.kasaTipiKod,
      kasaTipiAdi: s.kasaTipiAdi,
      kasaDepozito: s.kasaDepozito,
      kasaTutari: s.kasaTutari,
      fiyat: s.fiyat,
      tutar: s.tutar
    });
  }

  if (!satirlar.length) return bildir('Belgeye en az bir satır girilmeli.', 'hata');

  const tahsilat = sayiOku(el('tahsilat').value);

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
      tahsilat
    });

    bildir(
      `Vega'ya yazıldı. Belge no: ${sonuc.belgeNo}` +
      (sonuc.kasaBelgeNo ? ` · Kasa: ${sonuc.kasaBelgeNo}` : '') +
      (sonuc.tahsilatBelgeNo ? ` · Tahsilat: ${sonuc.tahsilatBelgeNo}` : ''),
      'basarili'
    );
    sonKaydiGoster(sonuc, belgeTuru);
    await belgeCari.yenile();
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
  baslik.textContent = 'Kaydedilen Belge';
  const bilgi = document.createElement('p');
  bilgi.className = 'ipucu';
  bilgi.textContent =
    (belgeTuru === 'satisFaturasi' ? 'Satış Faturası' : 'Cari Çıkış') +
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

// ═══════════════════════ KASA ═══════════════════════

function kasaKartiSecimDoldur(secim) {
  secim.innerHTML = '';
  const bos = document.createElement('option');
  bos.value = '';
  bos.textContent = '— seçin —';
  secim.appendChild(bos);
  for (const k of durum.kasaKartlari) {
    const o = document.createElement('option');
    o.value = String(k.id);
    o.textContent = `${k.kod} (${para(k.depozito)} TL)`;
    secim.appendChild(o);
  }
}

async function iadeBilgisiniGuncelle() {
  const bilgi = el('iadeBilgi');
  const cari = iadeCari.secili();
  if (!cari) { bilgi.textContent = ''; return; }
  try {
    const liste = await cagir('yardimci:kasaBakiye', { firma: firmaKodu(), cariInd: cari.cariInd });
    if (!liste.length) {
      bilgi.textContent = 'Bu müşteride açık kasa görünmüyor.';
      return;
    }
    bilgi.textContent =
      'Açık kasalar: ' +
      liste.map((k) => `${k.kasaTipiKod} ${miktarYaz(k.acikAdet)} adet (${para(k.acikTutar)} TL)`)
        .join(' · ');
  } catch (e) {
    bilgi.textContent = 'Kasa bakiyesi okunamadı: ' + e.message;
  }
}

el('iadeKaydet').addEventListener('click', async () => {
  uyariKapat();
  if (!firmaSecildiMi()) {
    bildir('Önce Ayarlar ekranından firma ve dönem seçin.', 'hata');
    return sekmeAc('ayar');
  }
  const cari = iadeCari.secili();
  if (!cari) return bildir('Müşteri seçilmedi.', 'hata');
  const stokNo = el('iadeKasaTipi').value;
  if (!stokNo) return bildir('Kasa tipi seçilmedi.', 'hata');
  const adet = sayiOku(el('iadeAdet').value);
  if (!(adet > 0)) return bildir('İade adedi sıfırdan büyük olmalı.', 'hata');
  const kasa = durum.kasaKartlari.find((k) => k.id === Number(stokNo));

  const dugme = el('iadeKaydet');
  dugme.disabled = true;
  try {
    const sonuc = await cagir('yazma:kasaIade', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      cariAd: cari.ad,
      stokNo: Number(stokNo),
      stokKodu: kasa ? kasa.kod : null,
      stokAdi: kasa ? kasa.ad : null,
      depozito: kasa ? kasa.depozito : 0,
      adet,
      tarih: el('iadeTarih').value || bugun()
    });

    let mesaj =
      `İade kaydedildi: ${miktarYaz(sonuc.adet)} adet, ${para(sonuc.tutar)} TL. ` +
      `Müşteride kalan: ${miktarYaz(sonuc.kalanAdet)} adet.`;
    if (sonuc.belgeNo) mesaj += ` Vega belge no: ${sonuc.belgeNo}.`;

    bildir(mesaj, 'basarili');
    el('iadeAdet').value = '';
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

async function belgelerYukle() {
  const govde = el('belgelerGovde');
  if (!firmaSecildiMi()) {
    return boslukTemizle(govde, 7, 'Önce Ayarlar ekranından firma ve dönem seçin.');
  }
  try {
    const liste = await cagir('yardimci:sonIslemler', { firma: firmaKodu(), limit: 200 });
    if (!liste.length) {
      return boslukTemizle(govde, 7, 'Henüz belge yazılmamış.');
    }
    govde.innerHTML = '';
    for (const k of liste) {
      const tr = document.createElement('tr');
      const hucreler = [
        [tarihSaatYaz(k.Tarih), ''],
        [k.Konu === 'satisFaturasi' ? 'Satış Faturası' : k.Konu === 'cariCikis' ? 'Cari Çıkış' : k.Konu, ''],
        [k.CariAd || '', ''],
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
      if (k.GeriAlindi) {
        const isaret = document.createElement('span');
        isaret.className = 'ipucu';
        isaret.textContent = 'geri alındı';
        eylemHucre.appendChild(isaret);
      } else if (durum.yazmaAcik) {
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
  } catch (e) {
    boslukTemizle(govde, 7, 'Okunamadı: ' + e.message);
  }
}

// ═══════════════════════ EKSTRE ═══════════════════════

el('ekstreGetir').addEventListener('click', () => ekstreYukle());

async function ekstreYukle() {
  const govde = el('ekstreGovde');
  const ozet = el('ekstreOzet');
  ozet.textContent = '';

  const cari = ekstreCari.secili();
  if (!cari) return boslukTemizle(govde, 7, 'Müşteri seçin.');

  try {
    const sonuc = await cagir('vega:ekstre', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      baslangic: el('ekstreBaslangic').value || null,
      bitis: el('ekstreBitis').value || null
    });

    govde.innerHTML = '';

    if (sonuc.devir) {
      const tr = document.createElement('tr');
      const bos = document.createElement('td');
      bos.colSpan = 6;
      const b = document.createElement('b');
      b.textContent = 'Devir bakiyesi';
      bos.appendChild(b);
      const d = document.createElement('td');
      d.className = 'sayi';
      const db = document.createElement('b');
      db.textContent = para(sonuc.devir);
      d.appendChild(db);
      tr.append(bos, d);
      govde.appendChild(tr);
    }

    if (!sonuc.satirlar.length && !sonuc.devir) {
      return boslukTemizle(govde, 7, 'Bu aralıkta hareket yok.');
    }

    for (const s of sonuc.satirlar) {
      const tr = document.createElement('tr');
      const hucreler = [
        [tarihYaz(s.tarih), ''],
        [s.izahatAdi, ''],
        [s.evrakNo, ''],
        [s.aciklama, ''],
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

    let metin = `${sonuc.satirlar.length} hareket · son bakiye ${para(sonuc.sonBakiye)} TL`;

    try {
      const kasalar = await cagir('yardimci:kasaBakiye', { firma: firmaKodu(), cariInd: cari.cariInd });
      if (kasalar.length) {
        metin +=
          ' · müşteride duran kasa: ' +
          kasalar.map((k) => `${k.kasaTipiKod} ${miktarYaz(k.acikAdet)}`).join(', ');
      }
    } catch (e) { /* kasa bilgisi olmasa da ekstre gösterilir */ }

    ozet.textContent = metin;
  } catch (e) {
    boslukTemizle(govde, 7, 'Okunamadı: ' + e.message);
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

// --- Kasa tipleri (Vega'dan otomatik + elle eklenen) ------------------------
//
// Vega'da stok kartında KOD1 = 'KASA' işaretli olanlar her açılışta
// otomatik BD_KasaTipi'ye eklenir (db/yardimci.js → vegaKasaKartlariniSenkronizeEt).
// Eski Access programının kendi kısa kodları (PK, SBÜYÜK, SMUZ, UP gibi —
// Vega'da hiç karşılığı yok) ve Vega'da işaretli olmayan kasa tipleri elle
// eklenir. Kaynağı ne olursa olsun hepsi aynı listede, aynı şekilde
// düzenlenebilir/silinebilir. İlk satır her zaman yeni kasa tipi eklemek
// için boş kalır.

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
      await cagir('yardimci:kasaTipiKaydet', {
        kod, ad: adGirdi.value.trim(),
        dara: sayiOku(daraGirdi.value),
        depozito: sayiOku(depozitoGirdi.value)
      });
      bildir(`"${kod}" kasa tipi eklendi.`, 'basarili');
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
    const kod = kodGirdi.value.trim();
    if (!kod) return bildir('Kasa tipi kodu boş olamaz.', 'hata');
    kaydet.disabled = true;
    try {
      await cagir('yardimci:kasaTipiKaydet', {
        id: kasa.id, kod, ad: adGirdi.value.trim(),
        dara: sayiOku(daraGirdi.value),
        depozito: sayiOku(depozitoGirdi.value)
      });
      bildir('Kaydedildi.', 'basarili');
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
      ayrinti: 'Bu tip artık seçilemez. Geçmiş kasa hareketleri etkilenmez.',
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

async function kasaKartlariniYukle() {
  try {
    durum.kasaKartlari = await cagir('yardimci:kasaTipleri', {
      sadeceAktif: true, firma: firmaKodu(), donem: donemKodu()
    });
  } catch (e) {
    durum.kasaKartlari = [];
    bildir('Kasa tipleri okunamadı: ' + e.message, 'hata');
  }
  kasaKartiSecimDoldur(el('iadeKasaTipi'));
  kasaSatirSecimleriniTazele();
  kasaKartlariTablosunuDoldur();
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

  satirEkle();
  toplamlariGuncelle();

  await baslangicVerisiniYukle();

  // Ana süreçteki guncelleme.baslat() pencere açılır açılmaz (bu betik
  // yüklenmeden önce) tetiklenebiliyor; ilk push kaçmış olabilir diye
  // mevcut durum bir kere de burada çekiliyor (yeni kontrol başlatmaz,
  // yalnızca son bilineni okur — ucuz ve zararsız).
  try {
    guncellemeDurumunuGoster(await cagir('guncelleme:durum', {}));
  } catch (e) { /* güncelleme bilgisi olmasa da program çalışır */ }
}

baslat();
