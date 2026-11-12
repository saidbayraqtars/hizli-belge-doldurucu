'use strict';

// Ekstreyi WhatsApp'tan göndermek için programın KENDİ WhatsApp oturumu
// (13.11.2026 — Said isteği: "kendi QR kodunu okutacak, gönderimler tek
// programdan, Hızlı Belge Doldurucu üzerinden").
//
// Ayarlar > WhatsApp'ta QR okutulunca bu bilgisayarda "Bağlı cihaz" olarak
// eşleşir (Baileys, kimlik klasörü: kullanıcı verisi / whatsapp-oturum).
// YALNIZ ELLE gönderim: otomatik ya da toplu gönderim yoktur; her gönderim
// bir kullanıcı tıklamasından gelir ve tek PDF'tir.
//
// Önemli:
//  - Bu klasör (kimlik) başka bir bilgisayara/programa KOPYALANMAZ. Aynı kimliği
//    iki yerde açmak WhatsApp'ta "conflict" yapıp oturumu düşürür. Vega
//    WhatsApp ayrı bir bağlı cihazdır; ikisi aynı numarada yan yana çalışabilir.
//  - QR yalnız kullanıcı "QR Okut"a basınca üretilir; okutulmazsa döngüye
//    girilmez (her yeni el sıkışma WhatsApp'a gereksiz yük ve risktir).
//  - Oturum iptal edilirse (telefondan "bağlı cihazlar"dan çıkarma) kimlik silinir
//    ve kendiliğinden yeniden QR üretilmez.

const fs = require('fs');
const path = require('path');

let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { QRCode = null; }

const MIN_ARALIK_MS = 4000;       // iki gönderim arası en az bekleme
const KOPMA_BEKLEMELERI = [3000, 10000, 30000, 60000, 120000];

let elektronApp = null;
try { elektronApp = require('electron').app || null; } catch (e) { elektronApp = null; }

// ─── Telefon ────────────────────────────────────────────────────────────────

// Vega WhatsApp (server/phone.js) ile aynı kural: 0532… / 532… / 90532… → 90532…
function telefonDuzenle(ham) {
  let r = String(ham || '').replace(/\D/g, '');
  if (!r) return '';
  if (r.startsWith('00')) r = r.slice(2);
  if (r.startsWith('0')) r = '90' + r.slice(1);
  else if (r.length === 10 && r.startsWith('5')) r = '90' + r;
  else if (r.length === 7) return '';
  return r;
}

function telefonGecerliMi(duzenli) {
  return /^905\d{9}$/.test(duzenli);
}

// ─── Oturum durumu ──────────────────────────────────────────────────────────

const durumu = {
  durum: 'kapali',   // kapali | baglaniyor | qr | bagli
  qr: null,          // QR'ın data: URL'i (yalnız durum === 'qr')
  numara: '',
  hata: ''
};

const dinleyiciler = new Set();

function degisti() {
  const g = durum();
  for (const f of dinleyiciler) {
    try { f(g); } catch (e) { /* dinleyici hatası oturumu bozmasın */ }
  }
}

function durumuYaz(yeni) {
  Object.assign(durumu, yeni);
  degisti();
}

function durum() {
  return {
    durum: durumu.durum,
    bagli: durumu.durum === 'bagli',
    qr: durumu.qr,
    numara: durumu.numara,
    hata: durumu.hata,
    oturumVar: oturumVarMi()
  };
}

function dinle(f) {
  dinleyiciler.add(f);
  return () => dinleyiciler.delete(f);
}

// ─── Kimlik klasörü ─────────────────────────────────────────────────────────

function oturumKlasoru() {
  if (process.env.BELGE_WA_OTURUM) return process.env.BELGE_WA_OTURUM;
  const taban = elektronApp && typeof elektronApp.getPath === 'function'
    ? elektronApp.getPath('userData')
    : path.join(__dirname, '..');
  return path.join(taban, 'whatsapp-oturum');
}

function oturumVarMi() {
  try { return fs.existsSync(path.join(oturumKlasoru(), 'creds.json')); } catch (e) { return false; }
}

function oturumuSil() {
  try { fs.rmSync(oturumKlasoru(), { recursive: true, force: true }); } catch (e) { /* yoksay */ }
}

// ─── Baileys ────────────────────────────────────────────────────────────────

let kutuphane = null;        // testte sahte kütüphane verilebilir
async function baileys() {
  if (!kutuphane) kutuphane = await import('@whiskeysockets/baileys');
  return kutuphane;
}

function testMotoru(lib) { kutuphane = lib; }

function sessizGunluk() {
  const g = {
    trace() {}, debug() {}, info() {},
    warn(...a) { console.warn('[WhatsApp]', ...a); },
    error(...a) { console.error('[WhatsApp]', ...a); },
    fatal(...a) { console.error('[WhatsApp][FATAL]', ...a); },
    level: 'warn'
  };
  g.child = () => sessizGunluk();
  return g;
}

let sock = null;
let nesil = 0;               // eski soketin geç gelen olayları yok sayılsın
let yenidenTimer = null;
let kopmaSayisi = 0;
let qrIstendi = false;
const gonderilenler = new Map(); // getMessage için (yeniden şifreleme)

function zamanlayiciyiTemizle() {
  if (yenidenTimer) { clearTimeout(yenidenTimer); yenidenTimer = null; }
}

function soketiKapat() {
  nesil++;
  zamanlayiciyiTemizle();
  const s = sock;
  sock = null;
  if (s) {
    try { s.ev.removeAllListeners(); } catch (e) { /* yoksay */ }
    try { s.end(undefined); } catch (e) { /* yoksay */ }
  }
}

async function qrResmi(qr) {
  if (!QRCode) return null;
  return QRCode.toDataURL(qr, { margin: 1, width: 280 });
}

// Bağlan. qrIste=false iken yalnız diskte kayıtlı kimlik varsa bağlanır; kimlik
// yokken kendiliğinden QR üretilmez (kullanıcı "QR Okut"a basmalı).
async function baglan(secenek) {
  const qrIste = !!(secenek && secenek.qrIste);
  if (qrIste) { qrIstendi = true; kopmaSayisi = 0; }
  if (!qrIste && !oturumVarMi()) return durum();
  if (sock && (durumu.durum === 'bagli' || durumu.durum === 'baglaniyor' || durumu.durum === 'qr')) {
    return durum();
  }

  soketiKapat();
  const benimNesil = nesil;
  durumuYaz({ durum: 'baglaniyor', qr: null, hata: '' });

  try {
    const lib = await baileys();
    const makeWASocket = lib.default || lib.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = lib;

    fs.mkdirSync(oturumKlasoru(), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(oturumKlasoru());

    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { version = undefined; }
    if (benimNesil !== nesil) return durum();

    const s = makeWASocket({
      logger: sessizGunluk(),
      printQRInTerminal: false,
      auth: state,
      version,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      // Telefona bildirim gitmesin: program "çevrimiçi" işaretlenmez.
      markOnlineOnConnect: false,
      // Bağlı cihazlar listesinde görünen ad.
      browser: ['Hizli Belge Doldurucu', 'Chrome', '120.0'],
      // Geçmiş sohbetleri çekme — programın geçmişe ihtiyacı yok.
      syncFullHistory: false,
      getMessage: async (key) => gonderilenler.get(key && key.id) || undefined
    });
    sock = s;

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (u) => {
      if (benimNesil !== nesil) return;
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        let resim = null;
        try { resim = await qrResmi(qr); } catch (e) { resim = null; }
        if (benimNesil !== nesil) return;
        durumuYaz({ durum: 'qr', qr: resim, hata: resim ? '' : 'QR resmi oluşturulamadı.' });
      }

      if (connection === 'open') {
        kopmaSayisi = 0;
        qrIstendi = false;
        const id = s.user && s.user.id ? String(s.user.id) : '';
        durumuYaz({ durum: 'bagli', qr: null, hata: '', numara: id.split(':')[0].split('@')[0] });
      }

      if (connection === 'close') {
        const kod = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode : undefined;
        const mesaj = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : '';
        const onceBagliydi = durumu.durum === 'bagli';
        soketiKapat();
        await kopmayiIsle(kod, mesaj, onceBagliydi, DisconnectReason || {});
      }
    });
  } catch (e) {
    soketiKapat();
    durumuYaz({ durum: 'kapali', qr: null, hata: 'WhatsApp başlatılamadı: ' + e.message });
  }
  return durum();
}

async function kopmayiIsle(kod, mesaj, onceBagliydi, DR) {
  // Çıkış yapıldı / telefon bağlı cihazlardan çıkardı → kimlik geçersiz.
  if (kod === DR.loggedOut || kod === 401) {
    oturumuSil();
    qrIstendi = false;
    return durumuYaz({
      durum: 'kapali', qr: null, numara: '',
      hata: 'WhatsApp oturumu kapatılmış (telefondan "Bağlı cihazlar"dan çıkarılmış olabilir). Yeniden QR okutun.'
    });
  }
  // Hesap kısıtlı: yeniden bağlanma deneme, oturumu silme.
  if (kod === 403) {
    return durumuYaz({ durum: 'kapali', qr: null, hata: 'WhatsApp bu oturuma izin vermiyor (403). Telefondan numaranın durumunu kontrol edin.' });
  }
  // Aynı kimlik başka yerde açıldı: yeniden denemek düşürme savaşı yapar.
  if (kod === DR.connectionReplaced || kod === 440 || /conflict|replaced/i.test(String(mesaj || ''))) {
    return durumuYaz({
      durum: 'kapali', qr: null,
      hata: 'Bu WhatsApp oturumu başka bir yerde açıldı. Oturum klasörü kopyalanmış olabilir; Ayarlar\'dan bağlantıyı kesip yeniden QR okutun.'
    });
  }
  // QR okutulmadı (408 "QR refs attempts ended"): döngüye girme.
  if (kod === 408 && /QR refs/i.test(String(mesaj || ''))) {
    qrIstendi = false;
    return durumuYaz({ durum: 'kapali', qr: null, hata: 'QR okutulmadı. Yeniden denemek için "QR Okut"a basın.' });
  }
  // Eşleşme tamamlandı, WhatsApp yeniden bağlanmayı istiyor (515): hemen yeniden.
  if (kod === DR.restartRequired || kod === 515) {
    durumuYaz({ durum: 'baglaniyor', qr: null, hata: '' });
    return baglan({ qrIste: qrIstendi });
  }
  // Geçici kopma: aralıklarla yeniden bağlan; sonunda vazgeç.
  if (!oturumVarMi() && !qrIstendi) {
    return durumuYaz({ durum: 'kapali', qr: null, hata: mesaj || 'Bağlantı kapandı.' });
  }
  if (kopmaSayisi >= KOPMA_BEKLEMELERI.length) {
    kopmaSayisi = 0;
    return durumuYaz({ durum: 'kapali', qr: null, hata: 'WhatsApp\'a bağlanılamıyor (' + (mesaj || 'kod ' + kod) + '). İnternet bağlantısını kontrol edip "Bağlan"a basın.' });
  }
  const bekle = KOPMA_BEKLEMELERI[kopmaSayisi++];
  durumuYaz({ durum: 'baglaniyor', qr: null, hata: onceBagliydi ? 'Bağlantı koptu, yeniden bağlanılıyor…' : '' });
  yenidenTimer = setTimeout(() => { yenidenTimer = null; baglan({ qrIste: qrIstendi }); }, bekle);
  if (yenidenTimer.unref) yenidenTimer.unref();
}

// Program açılışında: kayıtlı oturum varsa sessizce bağlan (QR üretmez).
function otomatikBaslat() {
  if (oturumVarMi()) return baglan({ qrIste: false });
  return Promise.resolve(durum());
}

// Bağlantıyı kes: telefondaki "Bağlı cihazlar"dan da çıkar, kimliği sil.
async function cikis() {
  const s = sock;
  qrIstendi = false;
  if (s && durumu.durum === 'bagli') {
    try { await s.logout(); } catch (e) { /* zaten kopmuş olabilir */ }
  }
  soketiKapat();
  oturumuSil();
  durumuYaz({ durum: 'kapali', qr: null, numara: '', hata: '' });
  return durum();
}

// Uygulama kapanırken soketi nazikçe kapat (kimliği silmez).
function kapat() {
  soketiKapat();
  durumu.durum = 'kapali';
}

// QR ekranını iptal et (okutmaktan vazgeç).
function qrIptal() {
  if (durumu.durum === 'qr' || (durumu.durum === 'baglaniyor' && !oturumVarMi())) {
    soketiKapat();
    qrIstendi = false;
    durumuYaz({ durum: 'kapali', qr: null, hata: '' });
  }
  return durum();
}

// ─── Gönderim ───────────────────────────────────────────────────────────────

let sonGonderim = 0;
let gonderimSirasi = Promise.resolve();

function sirayaAl(is) {
  const bu = gonderimSirasi.then(is, is);
  gonderimSirasi = bu.catch(() => {});
  return bu;
}

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

// Tek PDF'yi tek numaraya gönderir (elle). Önce numaranın WhatsApp'ta olup
// olmadığı sorulur; arka arkaya gönderimler arasında en az MIN_ARALIK_MS beklenir.
function pdfGonder({ telefon, mesaj, pdf, dosyaAdi }) {
  return sirayaAl(async () => {
    const no = telefonDuzenle(telefon);
    if (!telefonGecerliMi(no)) {
      throw new Error('Geçerli bir cep telefonu girin (ör. 0532 123 45 67).');
    }
    if (!pdf || !pdf.length) throw new Error('Ekstre PDF\'i oluşturulamadı.');
    if (durumu.durum !== 'bagli' || !sock) {
      throw new Error('WhatsApp bağlı değil. Ayarlar > WhatsApp bölümünden QR okutup bağlanın.');
    }
    const s = sock;
    if (s.ws && s.ws.isOpen === false) {
      throw new Error('WhatsApp bağlantısı kopuk, yeniden bağlanılıyor — birkaç saniye sonra tekrar deneyin.');
    }

    let sonuc;
    try { sonuc = await s.onWhatsApp(no); } catch (e) {
      throw new Error('Numara doğrulanamadı: ' + e.message);
    }
    if (!Array.isArray(sonuc) || !sonuc.length) {
      throw new Error('WhatsApp doğrulaması geçici olarak yapılamadı — biraz sonra tekrar deneyin.');
    }
    if (!sonuc[0] || !sonuc[0].exists) throw new Error('Bu numara WhatsApp kullanıcısı değil.');
    const jid = sonuc[0].jid || `${no}@s.whatsapp.net`;

    const fark = Date.now() - sonGonderim;
    if (fark < MIN_ARALIK_MS) await bekle(MIN_ARALIK_MS - fark);

    try {
      try {
        await s.presenceSubscribe(jid);
        await s.sendPresenceUpdate('composing', jid);
        await bekle(1200);
        await s.sendPresenceUpdate('paused', jid);
      } catch (e) { /* "yazıyor" göstergesi başarısızsa gönderimi engellemesin */ }

      const gonderilen = await s.sendMessage(jid, {
        document: Buffer.from(pdf),
        mimetype: 'application/pdf',
        fileName: dosyaAdi || 'Ekstre.pdf',
        caption: String(mesaj || '')
      });
      if (gonderilen && gonderilen.key && gonderilen.key.id) {
        gonderilenler.set(gonderilen.key.id, gonderilen.message);
        if (gonderilenler.size > 50) gonderilenler.delete(gonderilenler.keys().next().value);
      }
      sonGonderim = Date.now();
      return { telefon: no };
    } catch (e) {
      sonGonderim = Date.now();
      throw new Error('Gönderilemedi: ' + e.message);
    }
  });
}

module.exports = {
  durum, dinle, baglan, otomatikBaslat, cikis, kapat, qrIptal, pdfGonder,
  telefonDuzenle, telefonGecerliMi, oturumVarMi, testMotoru
};
