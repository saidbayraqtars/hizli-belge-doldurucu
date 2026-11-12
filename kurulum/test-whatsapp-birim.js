'use strict';

// db/whatsapp.js sınaması — gerçek WhatsApp'a DOKUNMAZ; Baileys yerine sahte bir
// kütüphane (soket + olaylar) enjekte edilir.
//   node kurulum/test-whatsapp-birim.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
process.env.BELGE_WA_OTURUM = path.join(gecici, 'oturum');
const wa = require('../db/whatsapp');

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const DR = { loggedOut: 401, connectionReplaced: 440, restartRequired: 515 };

// ── Sahte Baileys ──
const soketler = [];
const kayit = { gonderilen: [], logout: 0 };
let varOlanNumara = true;

function kimlikYaz() {
  fs.mkdirSync(process.env.BELGE_WA_OTURUM, { recursive: true });
  fs.writeFileSync(path.join(process.env.BELGE_WA_OTURUM, 'creds.json'), '{}');
}

function sahteKutuphane() {
  return {
    DisconnectReason: DR,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => kimlikYaz() }),
    default: () => {
      const s = { ev: new EventEmitter(), user: { id: '905551112233:7@s.whatsapp.net' }, ws: { isOpen: true } };
      s.end = () => {};
      s.logout = async () => { kayit.logout++; };
      s.onWhatsApp = async (no) => (varOlanNumara ? [{ exists: no !== '905000000000', jid: no + '@s.whatsapp.net' }] : []);
      s.presenceSubscribe = async () => {};
      s.sendPresenceUpdate = async () => {};
      s.sendMessage = async (jid, icerik) => {
        kayit.gonderilen.push({ jid, icerik });
        return { key: { id: 'ID' + kayit.gonderilen.length }, message: {} };
      };
      soketler.push(s);
      return s;
    }
  };
}

const son = () => soketler[soketler.length - 1];
const olay = (s, o) => s.ev.emit('connection.update', o);
const kapanis = (kod, mesaj) => ({
  connection: 'close',
  lastDisconnect: { error: Object.assign(new Error(mesaj || 'kapandi'), { output: { statusCode: kod } }) }
});

async function hataBekle(is, desen, ad) {
  try { await is(); } catch (e) { assert.ok(desen.test(e.message), ad + ': ' + e.message); return; }
  assert.fail(ad + ': hata beklenirdi');
}

(async () => {
  try {
    // Telefon düzeni
    assert.strictEqual(wa.telefonDuzenle('0532 123 45 67'), '905321234567');
    assert.strictEqual(wa.telefonDuzenle('(532) 123-45-67'), '905321234567');
    assert.strictEqual(wa.telefonDuzenle('00905321234567'), '905321234567');
    assert.ok(!wa.telefonGecerliMi(wa.telefonDuzenle('0362 123 45 67')), 'sabit hat geçersiz');

    wa.testMotoru(sahteKutuphane());
    const degisimler = [];
    wa.dinle((d) => degisimler.push(d.durum));

    // Kimlik yokken kendiliğinden bağlanmaz / QR üretmez
    await wa.otomatikBaslat();
    assert.strictEqual(soketler.length, 0, 'kimlik yokken soket açılmamalı');
    assert.strictEqual(wa.durum().durum, 'kapali');

    // Bağlı değilken gönderim reddedilir
    await hataBekle(() => wa.pdfGonder({ telefon: '0532 123 45 67', pdf: Buffer.from('x') }), /WhatsApp bağlı değil/, 'bağlı değil');

    // QR iste → QR olayı → durum 'qr' + resim
    await wa.baglan({ qrIste: true });
    assert.strictEqual(wa.durum().durum, 'baglaniyor');
    olay(son(), { qr: 'sahte-qr-metni' });
    await bekle(100);
    assert.strictEqual(wa.durum().durum, 'qr');
    assert.ok(/^data:image\/png;base64,/.test(wa.durum().qr), 'QR data URL');

    // Eşleşme: kimlik yazılır, WhatsApp 515 ile yeniden bağlanma ister
    kimlikYaz();
    olay(son(), kapanis(515, 'restart required'));
    await bekle(100);
    assert.strictEqual(soketler.length, 2, '515 sonrası yeni soket');
    olay(son(), { connection: 'open' });
    assert.ok(wa.durum().bagli && wa.durum().numara === '905551112233');

    // Gönderim
    const s = await wa.pdfGonder({ telefon: '0532 123 45 67', mesaj: 'merhaba', pdf: Buffer.from('%PDF-1.4'), dosyaAdi: 'Ekstre-Test.pdf' });
    assert.strictEqual(s.telefon, '905321234567');
    const g = kayit.gonderilen[0];
    assert.strictEqual(g.jid, '905321234567@s.whatsapp.net');
    assert.strictEqual(g.icerik.caption, 'merhaba');
    assert.strictEqual(g.icerik.mimetype, 'application/pdf');
    assert.strictEqual(g.icerik.fileName, 'Ekstre-Test.pdf');
    assert.strictEqual(g.icerik.document.toString(), '%PDF-1.4');

    await hataBekle(() => wa.pdfGonder({ telefon: '905000000000', pdf: Buffer.from('x') }), /WhatsApp kullanıcısı değil/, 'WhatsApp olmayan numara');
    await hataBekle(() => wa.pdfGonder({ telefon: '123', pdf: Buffer.from('x') }), /Geçerli bir cep telefonu/, 'geçersiz numara');
    await hataBekle(() => wa.pdfGonder({ telefon: '0532 123 45 67', pdf: Buffer.alloc(0) }), /PDF/, 'boş PDF');
    varOlanNumara = false;
    await hataBekle(() => wa.pdfGonder({ telefon: '0532 123 45 67', pdf: Buffer.from('x') }), /geçici olarak/, 'boş doğrulama yanıtı');
    varOlanNumara = true;
    assert.strictEqual(kayit.gonderilen.length, 1, 'reddedilenler gönderilmemeli');

    // Çakışma: yeniden denemeden durur, kimlik silinmez
    olay(son(), kapanis(440, 'Stream Errored (conflict)'));
    await bekle(100);
    assert.strictEqual(wa.durum().durum, 'kapali');
    assert.ok(/başka bir yerde/.test(wa.durum().hata));
    assert.ok(wa.oturumVarMi(), 'çakışmada kimlik korunmalı');
    const sayi = soketler.length;
    await bekle(200);
    assert.strictEqual(soketler.length, sayi, 'çakışmada yeniden bağlanma denenmemeli');

    // Açılışta kayıtlı kimlikle sessiz bağlanma
    await wa.otomatikBaslat();
    assert.strictEqual(soketler.length, sayi + 1);
    olay(son(), { connection: 'open' });
    assert.ok(wa.durum().bagli);

    // Telefondan çıkarıldı (loggedOut): kimlik silinir, QR kendiliğinden gelmez
    const onceki = soketler.length;
    olay(son(), kapanis(401, 'logged out'));
    await bekle(100);
    assert.ok(!wa.oturumVarMi(), 'loggedOut kimliği silmeli');
    assert.strictEqual(wa.durum().durum, 'kapali');
    assert.strictEqual(soketler.length, onceki, 'loggedOut sonrası kendiliğinden bağlanma yok');

    // QR okutulmadı (408): döngü yok
    await wa.baglan({ qrIste: true });
    olay(son(), kapanis(408, 'QR refs attempts ended'));
    await bekle(100);
    assert.strictEqual(wa.durum().durum, 'kapali');
    assert.ok(/QR okutulmadı/.test(wa.durum().hata));

    // Çıkış: logout çağrılır, kimlik silinir
    await wa.baglan({ qrIste: true });
    kimlikYaz();
    olay(son(), { connection: 'open' });
    await wa.cikis();
    assert.strictEqual(kayit.logout, 1, 'logout çağrılmalı');
    assert.ok(!wa.oturumVarMi());
    assert.strictEqual(wa.durum().durum, 'kapali');

    assert.ok(degisimler.includes('qr') && degisimler.includes('bagli'), 'dinleyici durumları aldı');
    console.log('WhatsApp birim testleri geçti: telefon düzeni, QR, eşleşme (515), gönderim, hata yolları, çakışma, loggedOut, çıkış.');
    wa.kapat();
    process.exit(0);
  } catch (e) {
    console.error('BAŞARISIZ:', e.stack || e.message);
    process.exit(1);
  }
})();
