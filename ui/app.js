'use strict';

// Arayüzün tamamı. Çerçeve yok — Windows 7 üzerindeki eski makinelerde de
// anında açılması için düz JavaScript. Veritabanına erişim yalnızca
// window.api.cagir() üzerinden, preload'daki kanal listesiyle sınırlı.

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

function bugun() {
  const d = new Date();
  const ay = String(d.getMonth() + 1).padStart(2, '0');
  const gun = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${ay}-${gun}`;
}

function isoTarih(d) {
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
  kasaTipleri: [],
  stoklar: [],
  stokHaritasi: new Map(),
  yazmaAcik: false,
  sonBelgeId: null
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

function kasaTipiSecenekleri(secili) {
  const s = document.createElement('select');
  const bos = document.createElement('option');
  bos.value = '';
  bos.textContent = '—';
  s.appendChild(bos);
  for (const t of durum.kasaTipleri) {
    const o = document.createElement('option');
    o.value = String(t.id);
    o.textContent = t.kod;
    if (String(secili) === String(t.id)) o.selected = true;
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

  const miktar = sayiHucresi('kg');
  const kasaAdedi = sayiHucresi('adet');

  const tipHucre = document.createElement('td');
  const tip = kasaTipiSecenekleri('');
  tipHucre.appendChild(tip);

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
    stokHucre, miktar.td, kasaAdedi.td, tipHucre, fiyat.td,
    tutarHucre, kasaTutarHucre, silHucre
  );
  govde.appendChild(tr);

  // Satır verisini DOM'da değil burada tutuyoruz; hesaplama tek yerden geçiyor.
  tr._satir = {
    stokGirdi: stok,
    miktarGirdi: miktar.girdi,
    kasaAdediGirdi: kasaAdedi.girdi,
    tipSecim: tip,
    fiyatGirdi: fiyat.girdi,
    tutarHucre,
    kasaTutarHucre
  };

  [stok, miktar.girdi, kasaAdedi.girdi, fiyat.girdi].forEach((i) => {
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
  const daraliMiktar = sayiOku(s.miktarGirdi.value);
  const kasaAdedi = sayiOku(s.kasaAdediGirdi.value);
  const fiyat = sayiOku(s.fiyatGirdi.value);
  const tipId = s.tipSecim.value ? Number(s.tipSecim.value) : null;
  const tip = tipId ? durum.kasaTipleri.find((t) => t.id === tipId) : null;

  const tutar = Math.round(daraliMiktar * fiyat * 100) / 100;
  const kasaDepozito = tip ? tip.depozito : 0;
  const kasaTutari = Math.round(kasaAdedi * kasaDepozito * 100) / 100;

  return {
    etiket, stok, daraliMiktar, kasaAdedi, fiyat, tutar,
    kasaTipiId: tipId,
    kasaTipiKod: tip ? tip.kod : null,
    kasaDepozito,
    kasaTutari,
    bos: !etiket && !daraliMiktar && !kasaAdedi && !fiyat
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
    tr._satir.tutarHucre.textContent = para(s.tutar);
    tr._satir.kasaTutarHucre.textContent = para(s.kasaTutari);
    urun += s.tutar;
    kasa += s.kasaTutari;
  }
  el('urunToplam').textContent = para(urun);
  el('kasaToplam').textContent = para(kasa);
  el('genelToplam').textContent = para(urun + kasa);
}

el('satirEkle').addEventListener('click', () => satirEkle());

el('formTemizle').addEventListener('click', () => {
  el('satirGovde').innerHTML = '';
  satirEkle();
  el('fisNo').value = '';
  belgeCari.temizle();
  el('sonKayit').classList.add('gizli');
  durum.sonBelgeId = null;
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
    if (!(s.daraliMiktar > 0)) {
      return bildir(`"${s.stok.ad}" için daralı miktar girilmedi.`, 'hata');
    }
    if (s.kasaAdedi > 0 && !s.kasaTipiId) {
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
      kasaTipiId: s.kasaTipiId,
      kasaTipiKod: s.kasaTipiKod,
      kasaDepozito: s.kasaDepozito,
      kasaTutari: s.kasaTutari,
      fiyat: s.fiyat,
      tutar: s.tutar
    });
  }

  if (!satirlar.length) return bildir('Belgeye en az bir satır girilmeli.', 'hata');

  const dugmeler = [el('kaydetFatura'), el('kaydetCariCikis')];
  dugmeler.forEach((d) => { d.disabled = true; });

  try {
    const sonuc = await cagir('belge:kaydet', {
      firma: firmaKodu(),
      donem: donemKodu(),
      tarih: el('belgeTarih').value || bugun(),
      cariInd: cari.cariInd,
      cariKod: cari.kod,
      cariAd: cari.ad,
      belgeTuru,
      fisNo: el('fisNo').value.trim(),
      satirlar
    });

    durum.sonBelgeId = sonuc.belgeId;
    bildir(
      `Belge kaydedildi. Ürün ${para(sonuc.urunTutari)} + kasa ${para(sonuc.kasaTutari)} = ` +
      `${para(sonuc.toplam)} TL.`,
      'basarili'
    );
    sonKaydiGoster(sonuc, belgeTuru);
  } catch (e) {
    bildir('Kaydedilemedi: ' + e.message, 'hata');
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
    `#${sonuc.belgeId} · ` +
    (belgeTuru === 'satisFaturasi' ? 'Satış Faturası' : 'Cari Çıkış') +
    ` · ${para(sonuc.toplam)} TL`;

  const eylem = document.createElement('div');
  eylem.className = 'eylemler sol';

  if (durum.yazmaAcik) {
    const yaz = document.createElement('button');
    yaz.type = 'button';
    yaz.className = 'dugme birincil';
    yaz.textContent = "Vega'ya Yaz";
    yaz.addEventListener('click', async () => {
      yaz.disabled = true;
      try {
        const y = await cagir('yazma:belge', { belgeId: sonuc.belgeId });
        bildir("Vega'ya yazıldı. Belge no: " + y.belgeNo, 'basarili');
        yaz.remove();
        await belgeCari.yenile();
      } catch (e) {
        bildir("Vega'ya yazılamadı: " + e.message, 'hata');
        yaz.disabled = false;
      }
    });
    eylem.appendChild(yaz);
  } else {
    const not = document.createElement('span');
    not.className = 'ipucu';
    not.textContent =
      "Vega'ya yazma kapalı — belge yalnızca bu programın veritabanına kaydedildi. " +
      'Rapor ekranından sonradan gönderilebilir.';
    eylem.appendChild(not);
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

function kasaTipiSecimDoldur(secim) {
  secim.innerHTML = '';
  const bos = document.createElement('option');
  bos.value = '';
  bos.textContent = '— seçin —';
  secim.appendChild(bos);
  for (const t of durum.kasaTipleri) {
    const o = document.createElement('option');
    o.value = String(t.id);
    o.textContent = `${t.kod} (${para(t.depozito)} TL)`;
    secim.appendChild(o);
  }
}

async function iadeBilgisiniGuncelle() {
  const bilgi = el('iadeBilgi');
  const cari = iadeCari.secili();
  if (!cari) { bilgi.textContent = ''; return; }
  try {
    const liste = await cagir('kasa:bakiye', { firma: firmaKodu(), cariInd: cari.cariInd });
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
  const tipId = el('iadeKasaTipi').value;
  if (!tipId) return bildir('Kasa tipi seçilmedi.', 'hata');
  const adet = sayiOku(el('iadeAdet').value);
  if (!(adet > 0)) return bildir('İade adedi sıfırdan büyük olmalı.', 'hata');

  const dugme = el('iadeKaydet');
  dugme.disabled = true;
  try {
    const sonuc = await cagir('kasa:iade', {
      firma: firmaKodu(),
      donem: donemKodu(),
      cariInd: cari.cariInd,
      cariAd: cari.ad,
      kasaTipiId: Number(tipId),
      adet,
      tarih: el('iadeTarih').value || bugun()
    });

    let mesaj =
      `İade kaydedildi: ${miktarYaz(sonuc.adet)} adet, ${para(sonuc.tutar)} TL. ` +
      `Müşteride kalan: ${miktarYaz(sonuc.kalanAdet)} adet.`;

    if (durum.yazmaAcik && sonuc.tutar > 0) {
      try {
        const y = await cagir('yazma:kasaIade', { kasaHareketId: sonuc.kasaHareketId });
        mesaj += ` Vega'ya yazıldı, belge no: ${y.belgeNo}.`;
      } catch (e) {
        mesaj += ` Ancak Vega'ya yazılamadı: ${e.message}`;
        bildir(mesaj, 'hata');
        el('iadeAdet').value = '';
        await iadeBilgisiniGuncelle();
        kasaBakiyesiniYukle();
        return;
      }
    }

    bildir(mesaj, 'basarili');
    el('iadeAdet').value = '';
    await iadeBilgisiniGuncelle();
    await iadeCari.yenile();
    kasaBakiyesiniYukle();
  } catch (e) {
    bildir('İade kaydedilemedi: ' + e.message, 'hata');
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
    const liste = await cagir('kasa:bakiye', { firma: firmaKodu() });
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
    t.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = para(toplamTutar) + ' TL';
    t.appendChild(b);
    tr.append(bos, t);
    govde.appendChild(tr);
  } catch (e) {
    boslukTemizle(govde, 4, 'Okunamadı: ' + e.message);
  }
}

// ═══════════════════════ RAPOR ═══════════════════════

el('raporBuHafta').addEventListener('click', () => {
  const d = new Date();
  // Pazartesi haftanın ilk günü.
  const gun = (d.getDay() + 6) % 7;
  const pazartesi = new Date(d);
  pazartesi.setDate(d.getDate() - gun);
  const pazar = new Date(pazartesi);
  pazar.setDate(pazartesi.getDate() + 6);
  el('raporBaslangic').value = isoTarih(pazartesi);
  el('raporBitis').value = isoTarih(pazar);
  raporYukle();
});

el('raporGetir').addEventListener('click', () => raporYukle());

async function raporYukle() {
  const govde = el('raporGovde');
  const ozet = el('raporOzet');
  ozet.textContent = '';

  if (!firmaSecildiMi()) {
    return boslukTemizle(govde, 11, 'Önce Ayarlar ekranından firma ve dönem seçin.');
  }

  try {
    const satirlar = await cagir('belge:rapor', {
      firma: firmaKodu(),
      baslangic: el('raporBaslangic').value || null,
      bitis: el('raporBitis').value || null
    });

    if (!satirlar.length) {
      return boslukTemizle(govde, 11, 'Bu aralıkta kayıt yok.');
    }

    govde.innerHTML = '';
    let toplam = 0;
    let oncekiBelge = null;

    for (const s of satirlar) {
      const tr = document.createElement('tr');
      const ilkSatir = s.belgeId !== oncekiBelge;
      oncekiBelge = s.belgeId;

      const hucreler = [
        [tarihYaz(s.tarih), ''],
        [s.cinsi, ''],
        [miktarYaz(s.daraliMiktar), 'sayi'],
        [miktarYaz(s.kasaAdedi), 'sayi'],
        [s.kasaTipi, ''],
        [para(s.fiyat), 'sayi'],
        [para(s.tutar), 'sayi'],
        [s.fisNo, ''],
        [ilkSatir ? s.cariAd : '', '']
      ];
      for (const [metin, sinif] of hucreler) {
        const td = document.createElement('td');
        if (sinif) td.className = sinif;
        td.textContent = metin;
        tr.appendChild(td);
      }

      const durumHucre = document.createElement('td');
      if (ilkSatir) {
        const isaret = document.createElement('span');
        isaret.className = 'isaret ' + (s.vegayaYazildi ? 'yazildi' : 'bekliyor');
        isaret.textContent = s.vegayaYazildi ? s.vegaBelgeNo || 'yazıldı' : 'bekliyor';
        durumHucre.appendChild(isaret);
      }
      tr.appendChild(durumHucre);

      const eylemHucre = document.createElement('td');
      if (ilkSatir) eylemHucre.appendChild(raporEylemi(s));
      tr.appendChild(eylemHucre);

      govde.appendChild(tr);
      toplam += s.tutar;
    }

    ozet.textContent = `${satirlar.length} satır · ürün toplamı ${para(toplam)} TL`;
  } catch (e) {
    boslukTemizle(govde, 11, 'Okunamadı: ' + e.message);
  }
}

function raporEylemi(s) {
  const sarmal = document.createElement('div');
  sarmal.className = 'eylemler sol';

  if (!durum.yazmaAcik) return sarmal;

  if (!s.vegayaYazildi) {
    const yaz = document.createElement('button');
    yaz.type = 'button';
    yaz.className = 'dugme mini birincil';
    yaz.textContent = "Vega'ya Yaz";
    yaz.addEventListener('click', async () => {
      yaz.disabled = true;
      try {
        const y = await cagir('yazma:belge', { belgeId: s.belgeId });
        bildir(`Belge #${s.belgeId} Vega'ya yazıldı. Belge no: ${y.belgeNo}`, 'basarili');
        raporYukle();
      } catch (e) {
        bildir("Vega'ya yazılamadı: " + e.message, 'hata');
        yaz.disabled = false;
      }
    });
    sarmal.appendChild(yaz);
  } else {
    const geri = document.createElement('button');
    geri.type = 'button';
    geri.className = 'dugme mini tehlike';
    geri.textContent = 'Geri Al';
    geri.addEventListener('click', async () => {
      const onay = await cagir('onay', {
        baslik: 'Vega kaydını geri al',
        mesaj: `Belge #${s.belgeId} Vega'dan silinecek.`,
        ayrinti:
          `Belge no: ${s.vegaBelgeNo || '—'}\n\n` +
          'Bu belgenin Vega\'daki satış/cari kayıtları ve stok hareketleri silinir. ' +
          'Müşterinin bakiyesi işlem öncesi haline döner. ' +
          'Programın kendi kaydı silinmez; belge yeniden gönderilebilir.',
        tamamBaslik: 'Geri al'
      });
      if (!onay.onaylandi) return;

      geri.disabled = true;
      try {
        const r = await cagir('yazma:belgeGeriAl', { belgeId: s.belgeId });
        bildir(`Geri alındı (${r.silinenSatir} satır silindi).`, 'basarili');
        raporYukle();
      } catch (e) {
        bildir('Geri alınamadı: ' + e.message, 'hata');
        geri.disabled = false;
      }
    });
    sarmal.appendChild(geri);
  }

  return sarmal;
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
      bos.innerHTML = '';
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

    // Kasa depozitosu Vega'ya ayrı satır olarak yazılıyor; yine de programın
    // kendi defterindeki açık kasa adedi burada gösteriliyor.
    try {
      const kasalar = await cagir('kasa:bakiye', { firma: firmaKodu(), cariInd: cari.cariInd });
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
  el('ayKendiDb').value = a.kendiVeritabani || '';
  el('ayKdv').value = a.varsayilanKdv != null ? a.varsayilanKdv : 0;
  el('ayOnek').value = a.belgeOneki || 'H';
  el('ayYazmaAktif').checked = !!a.vegayaYazmaAktif;
  firmaSecimDoldur();
  depoSecimDoldur();
  kasaTipiTablosunuDoldur();
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

el('ayVeritabaniKur').addEventListener('click', async () => {
  const sonuc = el('ayBaglantiSonuc');
  sonuc.textContent = 'Kuruluyor…';
  try {
    await ayarlariKaydet(true);
    await cagir('kayit:hazirla', {});
    durum.kasaTipleri = await cagir('kasaTipi:liste', { hepsi: true });
    kasaTipiTablosunuDoldur();
    sonuc.textContent = `"${el('ayKendiDb').value}" veritabanı hazır.`;
  } catch (e) {
    sonuc.textContent = 'Kurulamadı: ' + e.message;
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
    kendiVeritabani: el('ayKendiDb').value.trim() || 'BELGE_DOLDURUCU',
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

// --- Kasa tipleri tablosu ---

function kasaTipiTablosunuDoldur() {
  const govde = el('kasaTipiGovde');
  govde.innerHTML = '';
  if (!durum.kasaTipleri.length) {
    return boslukTemizle(govde, 5, 'Kasa tipi tanımlı değil.');
  }
  for (const t of durum.kasaTipleri) govde.appendChild(kasaTipiSatiri(t));
}

function kasaTipiSatiri(tip) {
  const tr = document.createElement('tr');

  function girdiHucresi(deger, sinif, yerTutucu) {
    const td = document.createElement('td');
    const i = document.createElement('input');
    i.type = 'text';
    i.value = deger == null ? '' : String(deger);
    if (sinif) i.className = sinif;
    if (yerTutucu) i.placeholder = yerTutucu;
    i.autocomplete = 'off';
    td.appendChild(i);
    return { td, girdi: i };
  }

  const kod = girdiHucresi(tip.kod, '', 'SBÜ');
  const ad = girdiHucresi(tip.ad, '', 'açıklama');
  const depozito = girdiHucresi(
    tip.id ? String(tip.depozito).replace('.', ',') : '',
    'sayi',
    '0,00'
  );
  depozito.girdi.inputMode = 'decimal';

  const aktifHucre = document.createElement('td');
  const aktif = document.createElement('input');
  aktif.type = 'checkbox';
  aktif.checked = tip.aktif !== false;
  aktifHucre.appendChild(aktif);

  const eylemHucre = document.createElement('td');
  const kaydet = document.createElement('button');
  kaydet.type = 'button';
  kaydet.className = 'dugme mini birincil';
  kaydet.textContent = 'Kaydet';
  kaydet.addEventListener('click', async () => {
    kaydet.disabled = true;
    try {
      await cagir('kasaTipi:kaydet', {
        id: tip.id || null,
        kod: kod.girdi.value.trim(),
        ad: ad.girdi.value.trim(),
        depozito: sayiOku(depozito.girdi.value),
        aktif: aktif.checked
      });
      durum.kasaTipleri = await cagir('kasaTipi:liste', { hepsi: true });
      kasaTipiTablosunuDoldur();
      kasaTipiSecimDoldur(el('iadeKasaTipi'));
      bildir('Kasa tipi kaydedildi.', 'basarili');
    } catch (e) {
      bildir('Kaydedilemedi: ' + e.message, 'hata');
      kaydet.disabled = false;
    }
  });
  eylemHucre.appendChild(kaydet);

  tr.append(kod.td, ad.td, depozito.td, aktifHucre, eylemHucre);
  return tr;
}

el('kasaTipiEkle').addEventListener('click', () => {
  const govde = el('kasaTipiGovde');
  if (govde.querySelector('.bosSatir')) govde.innerHTML = '';
  govde.appendChild(kasaTipiSatiri({ id: null, kod: '', ad: '', depozito: 0, aktif: true }));
});

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

  try {
    durum.kasaTipleri = await cagir('kasaTipi:liste', { hepsi: true });
  } catch (e) {
    durum.kasaTipleri = [];
    bildir(
      'Programın kendi veritabanı hazır değil: ' + e.message +
      ' — Ayarlar ekranındaki "Kendi Veritabanını Kur" düğmesine basın.',
      'hata'
    );
    sekmeAc('ayar');
    return;
  }
  kasaTipiSecimDoldur(el('iadeKasaTipi'));

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
  el('raporBitis').value = bugunMetni;

  const birHaftaOnce = new Date();
  birHaftaOnce.setDate(birHaftaOnce.getDate() - 7);
  el('raporBaslangic').value = isoTarih(birHaftaOnce);

  satirEkle();
  toplamlariGuncelle();

  await baslangicVerisiniYukle();
}

baslat();
