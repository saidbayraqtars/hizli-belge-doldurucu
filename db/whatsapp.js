'use strict';

// Ekstreyi WhatsApp'tan göndermek için Vega WhatsApp'ın RELAY uçlarını kullanır
// (12.11.2026 — Hakan Bey isteği: "bizim WhatsApp'ı bozmayalım").
//
// Bu program KENDİ WhatsApp oturumu AÇMAZ. Aynı numara iki yerde bağlanırsa
// WhatsApp "conflict" verip oturumları düşürür ve hesap işaretlenir (bkz. vault:
// vega-relay-modu). Bunun yerine Vega WhatsApp'ın çalıştığı bilgisayardaki
// /api/relay-status, /api/relay-check ve /api/relay-send uçlarına LAN'dan istek
// atılır; gönderimi, anti-ban sayacını ve oturumu Vega WhatsApp yönetir.
// Vega WhatsApp tarafında kod değişikliği gerekmez — yalnız Ayarlar'da relay
// parolası (config.json → wa.relayToken) tanımlı olmalı.

const http = require('http');
const https = require('https');
const { ayarOku } = require('./ayar');

const ZAMAN_ASIMI_MS = 45000;

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

function ayarlar() {
  const a = ayarOku();
  const adres = String(a.whatsappAdres || '').trim().replace(/\/+$/, '');
  const token = String(a.whatsappToken || '');
  if (!adres) {
    throw new Error('Vega WhatsApp adresi girilmemiş. Ayarlar → WhatsApp bölümünden girin.');
  }
  if (!token) {
    throw new Error('Vega WhatsApp parolası (relay token) girilmemiş. Ayarlar → WhatsApp bölümünden girin.');
  }
  return { adres: /^https?:\/\//i.test(adres) ? adres : 'http://' + adres, token };
}

function istek(yol, metod, govde, ayar) {
  return new Promise((coz, red) => {
    let url;
    try { url = new URL(ayar.adres + yol); } catch (e) {
      return red(new Error('Vega WhatsApp adresi geçersiz: ' + ayar.adres));
    }
    const yuk = govde == null ? null : Buffer.from(JSON.stringify(govde), 'utf8');
    const baslik = { 'x-relay-token': ayar.token };
    if (yuk) {
      baslik['Content-Type'] = 'application/json';
      baslik['Content-Length'] = yuk.length;
    }
    const modul = url.protocol === 'https:' ? https : http;
    const r = modul.request(url, { method: metod, headers: baslik, timeout: ZAMAN_ASIMI_MS }, (yanit) => {
      const parcalar = [];
      yanit.on('data', (p) => parcalar.push(p));
      yanit.on('end', () => {
        const metin = Buffer.concat(parcalar).toString('utf8');
        let veri = {};
        try { veri = metin ? JSON.parse(metin) : {}; } catch (e) { veri = { hata: metin.slice(0, 200) }; }
        coz({ kod: yanit.statusCode, veri });
      });
    });
    r.on('timeout', () => r.destroy(new Error('zaman aşımı')));
    r.on('error', (e) => {
      const kod = e && e.code;
      if (kod === 'ECONNREFUSED' || kod === 'ENOTFOUND' || kod === 'EHOSTUNREACH' || kod === 'ENETUNREACH' || kod === 'ETIMEDOUT' || e.message === 'zaman aşımı') {
        red(new Error('Vega WhatsApp\'a ulaşılamıyor (' + ayar.adres + '). Program o bilgisayarda açık mı, adres ve port doğru mu?'));
      } else {
        red(e);
      }
    });
    if (yuk) r.write(yuk);
    r.end();
  });
}

function hataMetni(yanit, varsayilan) {
  const v = yanit.veri || {};
  if (yanit.kod === 401) return 'Vega WhatsApp parolası (relay token) yanlış.';
  if (yanit.kod === 503 && /token/i.test(v.error || '')) {
    return 'Vega WhatsApp tarafında relay parolası tanımlı değil (config.json → wa.relayToken). Kurulumu yapan kişiden tanımlamasını isteyin.';
  }
  return v.error || v.message || v.hata || varsayilan;
}

// Vega WhatsApp erişilebilir mi, WhatsApp bağlı mı?
async function durum() {
  const ayar = ayarlar();
  const y = await istek('/api/relay-status', 'GET', null, ayar);
  if (y.kod !== 200) throw new Error(hataMetni(y, 'Vega WhatsApp durumu okunamadı (HTTP ' + y.kod + ').'));
  const bagli = !!y.veri.ready;
  return {
    bagli,
    numara: y.veri.me ? String(y.veri.me).split(':')[0].split('@')[0] : '',
    hata: bagli ? '' : (y.veri.error || 'Vega WhatsApp açık ama WhatsApp bağlı değil (QR okutulmamış olabilir).')
  };
}

// Tek PDF'yi tek numaraya gönderir. Önce numaranın WhatsApp'ta olup olmadığı
// sorulur (Vega WhatsApp'ın kendi Ekstre gönderimiyle aynı sıra).
async function pdfGonder({ telefon, mesaj, pdf, dosyaAdi }) {
  const ayar = ayarlar();
  const no = telefonDuzenle(telefon);
  if (!telefonGecerliMi(no)) {
    throw new Error('Geçerli bir cep telefonu girin (ör. 0532 123 45 67).');
  }
  if (!pdf || !pdf.length) throw new Error('Ekstre PDF\'i oluşturulamadı.');

  const d = await durum();
  if (!d.bagli) throw new Error(d.hata);

  const kontrol = await istek('/api/relay-check', 'POST', { phone: no }, ayar);
  if (kontrol.kod !== 200) throw new Error(hataMetni(kontrol, 'Numara doğrulanamadı.'));
  if (!kontrol.veri.exists) {
    throw new Error(kontrol.veri.transient
      ? 'WhatsApp doğrulaması geçici olarak yapılamadı — biraz sonra tekrar deneyin.'
      : 'Bu numara WhatsApp kullanıcısı değil.');
  }

  const y = await istek('/api/relay-send', 'POST', {
    phone: no,
    text: String(mesaj || ''),
    media: {
      kind: 'document',
      mimetype: 'application/pdf',
      fileName: dosyaAdi || 'Ekstre.pdf',
      b64: Buffer.from(pdf).toString('base64')
    },
    opts: { simulateTyping: true, typingMs: 1200, channel: 'extre' }
  }, ayar);

  if (y.kod === 429) throw new Error(hataMetni(y, 'Anti-ban: günlük gönderim sınırına ulaşıldı.'));
  if (y.kod !== 200 || y.veri.success === false) {
    throw new Error(hataMetni(y, 'Gönderilemedi (HTTP ' + y.kod + ').'));
  }
  return { telefon: no };
}

module.exports = { durum, pdfGonder, telefonDuzenle, telefonGecerliMi };
