'use strict';

// Otomatik güncelleme. Program açıldığında GitHub Releases üzerindeki yeni
// sürümü kontrol eder, arka planda indirir ve kullanıcıya "şimdi kur" der.
// Kullanıcı hiçbir şey yapmazsa güncelleme program kapanırken kurulur.

const { dialog } = require('electron');

let updater = null;
let log = null;
try {
  updater = require('electron-updater').autoUpdater;
  log = require('electron-log');
} catch (e) {
  updater = null;
}

let pencereRef = null;
let sonDurum = { durum: 'bilinmiyor', surum: null, mesaj: '' };

function durumBildir(durum, mesaj, surum) {
  sonDurum = { durum, mesaj: mesaj || '', surum: surum || null };
  if (pencereRef && !pencereRef.isDestroyed()) {
    pencereRef.webContents.send('guncelleme:durum', sonDurum);
  }
}

function baslat(pencere) {
  pencereRef = pencere;
  if (!updater) {
    durumBildir('kapali', 'Otomatik güncelleme bu sürümde kapalı.');
    return;
  }

  if (log) {
    log.transports.file.level = 'info';
    updater.logger = log;
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('checking-for-update', () => durumBildir('bakiliyor', 'Güncelleme kontrol ediliyor…'));
  updater.on('update-not-available', () => durumBildir('guncel', 'Program güncel.'));
  updater.on('error', (e) =>
    durumBildir('hata', 'Güncelleme kontrol edilemedi: ' + (e && e.message ? e.message : e))
  );
  updater.on('download-progress', (p) =>
    durumBildir('iniyor', `Yeni sürüm indiriliyor… %${Math.round(p.percent)}`)
  );

  updater.on('update-available', (bilgi) =>
    durumBildir('bulundu', 'Yeni sürüm bulundu: ' + bilgi.version, bilgi.version)
  );

  updater.on('update-downloaded', async (bilgi) => {
    durumBildir('hazir', 'Yeni sürüm hazır: ' + bilgi.version, bilgi.version);
    const sonuc = await dialog.showMessageBox(pencereRef, {
      type: 'info',
      buttons: ['Şimdi kur ve yeniden başlat', 'Program kapanınca kurulsun'],
      defaultId: 0,
      cancelId: 1,
      title: 'Güncelleme hazır',
      message: `Hızlı Belge Doldurucu ${bilgi.version} sürümü indirildi.`,
      detail: 'Kurulum birkaç saniye sürer ve program kendiliğinden yeniden açılır.'
    });
    if (sonuc.response === 0) updater.quitAndInstall(false, true);
  });

  // Açılışta bir kez, sonra her 4 saatte bir kontrol et.
  updater.checkForUpdatesAndNotify().catch(() => {});
  setInterval(() => updater.checkForUpdatesAndNotify().catch(() => {}), 4 * 60 * 60 * 1000);
}

async function simdiKontrolEt() {
  if (!updater) return { durum: 'kapali', mesaj: 'Otomatik güncelleme bu sürümde kapalı.' };
  try {
    await updater.checkForUpdates();
  } catch (e) {
    durumBildir('hata', 'Güncelleme kontrol edilemedi: ' + e.message);
  }
  return sonDurum;
}

function durumAl() {
  return sonDurum;
}

module.exports = { baslat, simdiKontrolEt, durumAl };
