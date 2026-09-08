const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

async function calistir() {
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.css'), 'utf8');
  const html = `<!doctype html>
    <meta charset="utf-8">
    <style>${css}</style>
    <div class="secili"><b>Cari</b><span class="bakiye">100,00</span></div>
    <table class="veri rapor"><tbody><tr class="secili"><td>Müşteri</td></tr></tbody></table>`;

  const pencere = new BrowserWindow({ show: false });
  await pencere.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const gorunum = await pencere.webContents.executeJavaScript(`({
    cari: getComputedStyle(document.querySelector('div.secili')).display,
    raporSatiri: getComputedStyle(document.querySelector('tr.secili')).display
  })`);

  if (gorunum.cari !== 'flex') {
    throw new Error(`Cari seçim kutusu flex olmalıydı, bulunan: ${gorunum.cari}`);
  }
  if (gorunum.raporSatiri !== 'table-row') {
    throw new Error(`Seçili rapor satırı table-row olmalıydı, bulunan: ${gorunum.raporSatiri}`);
  }

  console.log('Geçen: cari seçim kutusu flex, seçili rapor satırı table-row.');
  pencere.destroy();
}

app.whenReady()
  .then(calistir)
  .then(() => app.quit())
  .catch((hata) => {
    console.error(hata);
    app.exit(1);
  });
