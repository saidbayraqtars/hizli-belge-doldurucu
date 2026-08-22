'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Arayüzün erişebildiği kanallar. Liste dışı bir kanal çağrılamaz; arayüz
// tarafında Node yok, veritabanına doğrudan erişim yok.
const KANALLAR = [
  'ayar:oku',
  'ayar:yaz',
  'baglanti:test',
  'firma:liste',
  'firma:depolar',
  'vega:cariler',
  'vega:stoklar',
  'vega:kasaKartlari',
  'vega:bakiye',
  'vega:ekstre',
  'yardimci:kasaDaralari',
  'yardimci:kasaDarasiKaydet',
  'yardimci:kasaBakiye',
  'yardimci:sonIslemler',
  'yazma:durum',
  'yazma:belge',
  'yazma:belgeGeriAl',
  'yazma:kasaIade',
  'guncelleme:kontrol',
  'guncelleme:durum',
  'onay'
];

// Ana sürecin kendiliğinden gönderdiği tek yönlü bildirimler.
const DINLENEBILIR = ['guncelleme:durum'];

contextBridge.exposeInMainWorld('api', {
  cagir(kanal, girdi) {
    if (!KANALLAR.includes(kanal)) {
      return Promise.resolve({ tamam: false, hata: `Bilinmeyen kanal: ${kanal}` });
    }
    return ipcRenderer.invoke(kanal, girdi || {});
  },
  dinle(kanal, isFn) {
    if (!DINLENEBILIR.includes(kanal)) return;
    ipcRenderer.on(kanal, (olay, veri) => isFn(veri));
  }
});
