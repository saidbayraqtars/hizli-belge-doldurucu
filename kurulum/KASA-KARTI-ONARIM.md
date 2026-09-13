# Kasa kartı düzeltmesi ve geçmiş belgeler

Yeni yazma kodu bir kasa tipi için seçili firmada `KOD1=KASA`, aynı `STOKKODU`
ve varsayılan birim bulunan etkin Vega kartı ister. Kart açılmadan yeni satış
faturası ve stok giriş iadesi o tip için açık hatayla durur.

Müşteri kopyasındaki 13.09.2026 salt okunur kontrolde PK, UP ve SB kartları
vardı. Aşağıdakiler VegaWin'de açılmalı; **kodlar harfi harfine** kullanılmalı:

| STOKKODU | Programdaki dara (kg) | Programdaki depozito (TL) |
| --- | ---: | ---: |
| MPK | 0 | 100 |
| MUP | 0 | 100 |
| S.MUZ | 0,7 | 20 |
| KAYIK | 1,5 | 100 |
| XSMUZ | 0,7 | 15 |
| MSK | 0 | 10 |
| İNCİR | 0 | 0 |

Her kartta `KOD1=KASA`, varsayılan `ADET` birimi, bu birimde dara/ağırlık ve
depozito/satış fiyatı doğrulanmalı. Özellikle İNCİR için sıfır depozito
işletmeyle kontrol edilmeli. Kartları doğrudan SQL ile üretmek, Vega'nın bağlı
birim ve fiyat kayıtlarını eksik bırakabilir.

Kartlar açıldıktan sonra önce salt okunur tarama çalıştırın:

```powershell
npm run bakim:kasa -- --fis 00751
npm run bakim:kasa
```

Araç hedef veritabanını, düzeltilebilir satırları, kart bekleyenleri ve elle
incelenecek bağlantıları yazdırır; tüm satırlar `%LOCALAPPDATA%\hizli-belge-doldurucu-bakim`
altındaki `kasa-karti-tarama-*.json` dosyasındadır. `--ayar DOSYA` ile bağlantı
dosyası seçilebilir. Hedef firma/dönem ve kartlar kontrol edildikten sonra:

```powershell
npm run bakim:kasa -- --fis 00751 --uygula
npm run bakim:kasa -- --uygula
npm run bakim:kasa -- --geri-al "YEDEK_DOSYASI.json"
```

### Müşteri bilgisayarında (kaynak kod ve npm olmadan)

Araç 1.7.3'ten itibaren kurulumun içinde gelir ve kurulu programın kendi
Electron'u ile Node olarak çalıştırılır. Bağlantı bilgisini kurulu programın
`%APPDATA%\hizli-belge-doldurucu\ayarlar.json` dosyasından okur. Program
varsayılan klasöre kurulduysa PowerShell'de:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$hbd = "$env:LOCALAPPDATA\Programs\hizli-belge-doldurucu"
& "$hbd\Hizli Belge Doldurucu.exe" "$hbd\resources\app.asar\kurulum\kasa-kartlarini-onar.js" --fis 00751 2>&1 | Out-Host
& "$hbd\Hizli Belge Doldurucu.exe" "$hbd\resources\app.asar\kurulum\kasa-kartlarini-onar.js" 2>&1 | Out-Host
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

`--uygula` ve `--geri-al` seçenekleri aynı satırın sonuna eklenir. Kurulum
başka klasöre yapıldıysa `$hbd` o klasör olmalıdır. `| Out-Host` gerekli:
Electron pencere uygulaması olduğu için çıktı borusuz konsolda görünmez.
Son satırdaki `Remove-Item` unutulursa aynı pencereden açılan program pencere
açmadan kapanır.

`--uygula` öncesinde geri alma yedeği diske yazılır. Yalnız program günlüğünün
tek tek işaretlediği, başlık imzası ve `LN`/`HAREKETIND` bağlantıları doğrulanan
kasa satırları tek SQL transaction'ında yerinde güncellenir. Fatura veya iade
tutarı, cari hareket, kasa defteri ve satır kimlikleri değiştirilmez. Kartı
eksik veya bağlantısı tutarsız satırlar atlanır ve raporda kalır. Her UPDATE
aynı transaction içinde tekrar okunur; bir satır değişmişse tüm işlem geri
sarılır. `--geri-al` JSON yedeğindeki yeni değerleri karşılaştırarak eski
değerleri yine tek transaction'da geri yazar.

Önce `00751` üzerinde uygulayıp VegaWin'de fatura satırlarını ve stok raporunu
gözle kontrol edin. Diğer kayıtları ancak bu kontrol ve yedek doğrulamasından
sonra onarın. Envanter toplamı VegaWin'de ayrıca hesaplanıyorsa Vega'nın
yeniden hesaplama işlevi gerekebilir; bu araç yalnız bağlı hareket satırlarını
günceller. Riskli satırlar, müşteri kaydı değiştirilmeden ayrı incelenmelidir.
İade fişinin `AFIYATI`/`BIRIMMALIYET` deseni gerçek VegaWin girişiyle yeniden
karşılaştırılana kadar önceki kodun değerleri korunur.
