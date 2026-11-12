'use strict';

// db/whatsapp.js sınaması — gerçek WhatsApp'a DOKUNMAZ; Vega WhatsApp'ın relay
// uçlarını (/api/relay-status, -check, -send) taklit eden yerel bir sunucu açar.
//   node kurulum/test-whatsapp-birim.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
process.env.BELGE_AYAR_DOSYASI = path.join(gecici, 'ayarlar.json');
const PORT = 39177;
const TOKEN = 'test-token';
const ayar = (o) => fs.writeFileSync(process.env.BELGE_AYAR_DOSYASI, JSON.stringify(o));
ayar({ whatsappAdres: `http://127.0.0.1:${PORT}/`, whatsappToken: TOKEN });

const ayarModulu = require('../db/ayar');
const wa = require('../db/whatsapp');

const kayit = [];
const sunucu = http.createServer((q, r) => {
  const parcalar = [];
  q.on('data', (p) => parcalar.push(p));
  q.on('end', () => {
    const gov = parcalar.length ? JSON.parse(Buffer.concat(parcalar).toString()) : null;
    const yanit = (kod, o) => { r.writeHead(kod, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (q.headers['x-relay-token'] !== TOKEN) return yanit(401, { success: false, error: 'relay parolası (token) geçersiz' });
    kayit.push({ yol: q.url, gov });
    if (q.url === '/api/relay-status') return yanit(200, { ready: true, me: '905551112233:5@s.whatsapp.net' });
    if (q.url === '/api/relay-check') return yanit(200, { exists: gov.phone !== '905000000000' });
    if (q.url === '/api/relay-send') return yanit(200, { success: true });
    yanit(404, {});
  });
});

async function hataBekle(is, desen, ad) {
  try { await is(); } catch (e) { assert.ok(desen.test(e.message), `${ad}: ${e.message}`); return; }
  assert.fail(ad + ': hata beklenirdi');
}

sunucu.listen(PORT, '127.0.0.1', async () => {
  try {
    assert.strictEqual(wa.telefonDuzenle('0532 123 45 67'), '905321234567');
    assert.strictEqual(wa.telefonDuzenle('(532) 123-45-67'), '905321234567');
    assert.strictEqual(wa.telefonDuzenle('00905321234567'), '905321234567');
    assert.ok(!wa.telefonGecerliMi(wa.telefonDuzenle('0362 123 45 67')), 'sabit hat geçersiz');

    const d = await wa.durum();
    assert.ok(d.bagli && d.numara === '905551112233');

    const s = await wa.pdfGonder({ telefon: '0532 123 45 67', mesaj: 'merhaba', pdf: Buffer.from('%PDF-1.4'), dosyaAdi: 'Ekstre-Test.pdf' });
    assert.strictEqual(s.telefon, '905321234567');
    const gonder = kayit.find((k) => k.yol === '/api/relay-send').gov;
    assert.strictEqual(gonder.phone, '905321234567');
    assert.strictEqual(gonder.text, 'merhaba');
    assert.strictEqual(gonder.media.kind, 'document');
    assert.strictEqual(gonder.media.mimetype, 'application/pdf');
    assert.strictEqual(Buffer.from(gonder.media.b64, 'base64').toString(), '%PDF-1.4');
    assert.strictEqual(gonder.opts.channel, 'extre');

    await hataBekle(() => wa.pdfGonder({ telefon: '905000000000', pdf: Buffer.from('x') }), /WhatsApp kullanıcısı değil/, 'WhatsApp\'ta olmayan numara');
    await hataBekle(() => wa.pdfGonder({ telefon: '123', pdf: Buffer.from('x') }), /Geçerli bir cep telefonu/, 'geçersiz numara');
    await hataBekle(() => wa.pdfGonder({ telefon: '0532 123 45 67', pdf: Buffer.alloc(0) }), /PDF/, 'boş PDF');

    ayarModulu.ayarYaz({ whatsappToken: 'yanlis' });
    await hataBekle(() => wa.durum(), /parolası \(relay token\) yanlış/, 'yanlış parola');

    ayarModulu.ayarYaz({ whatsappAdres: 'http://127.0.0.1:39176', whatsappToken: TOKEN });
    await hataBekle(() => wa.durum(), /ulaşılamıyor/, 'kapalı sunucu');

    ayarModulu.ayarYaz({ whatsappAdres: '' });
    await hataBekle(() => wa.durum(), /adresi girilmemiş/, 'adres yok');

    console.log('WhatsApp birim testleri geçti: telefon düzeni, durum, gönderim yükü, hata yolları.');
    sunucu.close();
  } catch (e) {
    console.error('BAŞARISIZ:', e.message);
    sunucu.close();
    process.exit(1);
  }
});
