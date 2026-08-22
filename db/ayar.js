'use strict';

const fs = require('fs');
const path = require('path');

const VARSAYILAN = {
  sunucu: 'localhost',
  port: 1433,
  windowsGirisi: false,
  kullanici: 'belge_doldurucu',
  sifre: '',
  vegaVeritabani: 'VEGADB',

  // Firma ve dönem bir kez seçilir, buraya yazılır ve kullanıcı değiştirmedikçe
  // aynı kalır. Boşken program açılışta Ayarlar ekranına yönlendirir.
  varsayilanFirma: '',
  varsayilanDonem: '',

  varsayilanDepo: 1,
  varsayilanKdv: 0,

  // Belge numarası öneki — yalnızca YEDEK: program önce o firma/dönemde
  // Vega'nın kendi satış faturası serisini (ör. "A") bulup onu sürdürmeye
  // çalışır (db/vega.js → satisSerisiTespitEt). Hiç fatura yoksa (yeni
  // firma/dönem) bu öneğe düşülür.
  belgeOneki: 'H',

  vegayaYazmaAktif: false
};

// Ayar dosyası nerede duruyor?
//   Kurulu programda : %APPDATA%\Hizli Belge Doldurucu\ayarlar.json
//   Geliştirmede     : proje kökündeki ayarlar.json
// Kurulu programda dosya yoksa kurulumla gelen ayarlar.ornek.json'dan kopyalanır.
let yolOnbellek = null;

function ayarYolu() {
  if (yolOnbellek) return yolOnbellek;

  // Sınama ve destek için başka bir ayar dosyası gösterilebilir:
  //   set BELGE_AYAR_DOSYASI=C:\yol\test-ayarlar.json
  if (process.env.BELGE_AYAR_DOSYASI) {
    yolOnbellek = process.env.BELGE_AYAR_DOSYASI;
    return yolOnbellek;
  }

  let elektron = null;
  try {
    elektron = require('electron');
  } catch (e) {
    elektron = null;
  }

  const paketli = elektron && elektron.app && elektron.app.isPackaged;

  if (paketli) {
    const klasor = elektron.app.getPath('userData');
    const hedef = path.join(klasor, 'ayarlar.json');
    if (!fs.existsSync(hedef)) {
      try {
        fs.mkdirSync(klasor, { recursive: true });
        const ornek = path.join(process.resourcesPath, 'ayarlar.ornek.json');
        if (fs.existsSync(ornek)) fs.copyFileSync(ornek, hedef);
        else fs.writeFileSync(hedef, JSON.stringify(VARSAYILAN, null, 2), 'utf8');
      } catch (e) {
        // Yazılamazsa aşağıdaki okuma varsayılanlara düşer.
      }
    }
    yolOnbellek = hedef;
    return yolOnbellek;
  }

  yolOnbellek = path.join(__dirname, '..', 'ayarlar.json');
  return yolOnbellek;
}

let onbellek = null;

function ayarOku() {
  if (onbellek) return onbellek;
  let dosya = {};
  try {
    // Not Defteri ile kaydedilen dosyalar başta BOM taşır; JSON.parse onu
    // kabul etmediği için temizliyoruz.
    const ham = fs.readFileSync(ayarYolu(), 'utf8').replace(/^\uFEFF/, '');
    dosya = JSON.parse(ham);
  } catch (e) {
    dosya = {};
  }
  onbellek = Object.assign({}, VARSAYILAN, dosya);
  return onbellek;
}

function ayarYaz(yeni) {
  const birlesik = Object.assign({}, ayarOku(), yeni);
  birlesik._aciklama =
    'Bu dosya bu bilgisayara özeldir. Programın Ayarlar ekranından da değiştirilebilir.';
  fs.writeFileSync(ayarYolu(), JSON.stringify(birlesik, null, 2), 'utf8');
  onbellek = birlesik;
  return birlesik;
}

module.exports = { ayarOku, ayarYaz, ayarYolu, VARSAYILAN };
