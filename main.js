'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

const { ayarOku, ayarYaz, ayarYolu } = require('./db/ayar');
const sql = require('./db/sql');
const firma = require('./db/firma');
const vega = require('./db/vega');
const yardimci = require('./db/yardimci');
const yazma = require('./db/yazma');
const guncelleme = require('./db/guncelleme');

// Windows 7 kurulumlarında eski ekran kartı sürücüleri yüzünden pencere bazen
// bomboş açılıyor. Bu program bir form uygulaması; donanım hızlandırmasına
// ihtiyacı yok, kapatmak her yerde açılmasını garantiliyor.
app.disableHardwareAcceleration();

let pencere = null;

function pencereOlustur() {
  pencere = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: 'Hızlı Belge Doldurucu',
    backgroundColor: '#f4f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  pencere.setMenuBarVisibility(false);
  pencere.loadFile(path.join(__dirname, 'ui', 'index.html'));
  pencere.once('ready-to-show', () => pencere.show());
  guncelleme.baslat(pencere);
  pencere.on('closed', () => { pencere = null; });
}

app.on('window-all-closed', async () => {
  try { await sql.havuzKapat(); } catch (e) { /* yoksay */ }
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(() => {
  pencereOlustur();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) pencereOlustur();
  });
});

// Arayüz her çağrıda { tamam, veri } ya da { tamam: false, hata } alır; böylece
// tek bir hata yolu var ve pencere hiçbir zaman sessizce boş kalmıyor.
function uc(kanal, isFn) {
  ipcMain.handle(kanal, async (olay, girdi) => {
    try {
      const veri = await isFn(girdi || {});
      return { tamam: true, veri };
    } catch (e) {
      return {
        tamam: false,
        hata: e && e.message ? e.message : String(e),
        kod: e && e.kod ? e.kod : null
      };
    }
  });
}

// --- Ayarlar ---------------------------------------------------------------

uc('ayar:oku', async () => {
  const a = ayarOku();
  // Şifre arayüze hiç gitmiyor; yalnızca girilmiş olup olmadığı gidiyor.
  const kopya = Object.assign({}, a);
  delete kopya.sifre;
  kopya.sifreGirildi = !!a.sifre;
  kopya.ayarDosyasi = ayarYolu();
  kopya.surum = app.getVersion();
  return kopya;
});

uc('ayar:yaz', async (girdi) => {
  const yeni = Object.assign({}, girdi);
  // Şifre alanı boş gönderildiyse mevcut şifreye dokunulmuyor.
  if (yeni.sifre === '' || yeni.sifre == null) delete yeni.sifre;
  const sonuc = ayarYaz(yeni);
  await sql.havuzKapat();
  firma.onbellekTemizle();
  const kopya = Object.assign({}, sonuc);
  delete kopya.sifre;
  kopya.sifreGirildi = !!sonuc.sifre;
  return kopya;
});

uc('baglanti:test', async () => sql.baglantiTesti());

// --- Firma / dönem / depo --------------------------------------------------

uc('firma:liste', async (girdi) => firma.firmalariGetir(!!girdi.yenile));
uc('firma:depolar', async () => firma.depolariGetir());

// --- VEGADB okumaları ------------------------------------------------------

uc('vega:cariler', async (girdi) => vega.carileriGetir(girdi));
uc('vega:stoklar', async (girdi) => vega.stoklariGetir(girdi));
uc('vega:kasaKartlari', async (girdi) => vega.kasaKartlariniGetir(girdi));
uc('vega:bakiye', async (girdi) => vega.cariBakiye(girdi));
uc('vega:ekstre', async (girdi) => vega.cariEkstre(girdi));

// --- Yardımcı (VEGADB içindeki küçük tablolar — dara, kasa defteri, günlük) -

uc('yardimci:kasaDaralari', async () => yardimci.kasaDaralariGetir());
uc('yardimci:kasaDarasiKaydet', async (girdi) => yardimci.kasaDarasiKaydet(girdi.stokNo, girdi.dara));
uc('yardimci:kasaBakiye', async (girdi) => yardimci.kasaBakiyesi(girdi));
uc('yardimci:sonIslemler', async (girdi) => yardimci.sonIslemleriGetir(girdi));

// --- VEGADB yazma (belge doğrudan buraya yazılır, ara veritabanı yok) ------

uc('yazma:durum', async () => ({ acik: yazma.yazmaAcikMi() }));
uc('yazma:belge', async (girdi) => yazma.belgeYaz(girdi));
uc('yazma:belgeGeriAl', async (girdi) => yazma.belgeGeriAl(girdi));
uc('yazma:kasaIade', async (girdi) => yazma.kasaIadesiYaz(girdi));

// --- Otomatik güncelleme ---------------------------------------------------

uc('guncelleme:kontrol', async () => guncelleme.simdiKontrolEt());
uc('guncelleme:durum', async () => guncelleme.durumAl());

// Geri alma gibi geri dönüşü olmayan işlerde arayüz bu onayı kullanıyor.
uc('onay', async (girdi) =>
  dialog.showMessageBox(pencere, {
    type: 'warning',
    buttons: ['Vazgeç', girdi.tamamBaslik || 'Devam et'],
    defaultId: 0,
    cancelId: 0,
    title: girdi.baslik || 'Onay',
    message: girdi.mesaj || '',
    detail: girdi.ayrinti || ''
  }).then((r) => ({ onaylandi: r.response === 1 }))
);
