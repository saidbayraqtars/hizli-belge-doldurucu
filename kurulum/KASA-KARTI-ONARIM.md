# Kasa kartı düzeltmesi ve geçmiş belgeler

Bir kasa tipi ancak seçili firmada `STOKKODU` aynı, `KOD1=KASA`, silinmemiş ve
tek varsayılan birimli bir Vega kartı varsa kullanılır. Satış faturası ve stok
giriş iadesi kasa kalemini bu karta yazar; kartı olmayan tip seçim ve ayar
ekranında listelenmez, doğrudan istekte açık hatayla durur.

## 1.7.4: kasa tipi programdan açılınca Vega kartı da açılır

Ayarlar > Kasa Tipleri'nden eklenen ya da kaydedilen tip aynı SQL
transaction'ında Vega'ya yazılır (`db/kasa.js`):

- Kart yoksa açılır. Alanlar VegaWin'in müşteride kendi açtığı PK/UP/SB
  kartlarından alındı: `STOKKODU` = kod, `MALINCINSI` = ad, `KOD1=KASA`,
  `STOKTIPI=0`, `STATUS=1`, `MALIYET=1`, ayarlardaki depo, `%0` KDV grubu
  (orana bakılarak; grup numarası firmadan firmaya değişir), `{GUID}` UID.
  Varsayılan `ADET` birimi: `CARPAN=1`, `VARSAYILAN=1`, `ANABIRIM=1`,
  `AGIRLIK` = dara, `SATISFIYATI1` = depozito, `PB1-3=TL`. Kart ile birim çift
  yönlü bağlanır (`BIRIMEX = ANABIRIM = birim IND`). Açılıştan sonra aynı
  transaction'da tekrar okunup doğrulanır; tutmazsa hiçbir satır kalmaz.
- Kart varsa adı, darası ve depozitosu karta işlenir (eski fiyat
  `ESKIFIYAT1`'e).
- Kod başka bir kartta duruyorsa (kasa işaretsiz ürün ya da silinmiş kart —
  `STOKKODU` UNIQUE, silinmiş kart da kodu tutar) hiçbir şey yazılmaz, neden
  ekranda gösterilir. Ürün kartı kendiliğinden kasaya çevrilmez.
- Kayıtlı tipin kodu değiştirilemez. Harf büyüklüğü Vega'nın Türkçe harmanına
  bırakılır (`i` büyüyünce `İ` olur; `sinama` ile `SINAMA` farklı koddur).

## Güncellemeden sonra otomatik bakım

Programdan daha önce açılıp Vega'ya işlenmemiş kasa tipleri silinmez. Paketli
program güncellenip ilk açıldığında, Vega'ya yazma açıksa, geçmiş belge
bakımından hemen sonra bir kez (`main.js` → `otomatikCalistir`):

1. Programın yazdığı her firmada, aktif ya da o firmada kullanılmış ama Vega
   kartı olmayan her tip için yukarıdaki desenle kart açılır. Her kart kendi
   transaction'ındadır; biri açılamazsa ötekiler durmaz.
2. Aşağıdaki güvenli onarım çalışır: bu kartları bekleyen geçmiş kasa satırları
   ve yanlış sistem kartına (VADE FARKI, KUR FARKI, DEVIR, HIZMET) düşmüş PK/SB/
   UP satırları yedek alınarak gerçek karta bağlanır.
3. Açılan kart varsa ekrandaki kasa listeleri kendiliğinden tazelenir.

Rapor ve yedekler `%LOCALAPPDATA%\hizli-belge-doldurucu-bakim\kasa-karti-*`
dosyalarındadır, özet program günlüğüne yazılır. Yazma kapalıysa, bir kart
açılamadıysa ya da doğrulama tutmazsa bakım tamamlandı sayılmaz ve sonraki
açılışta yeniden denenir (iki adım da tekrar çalıştırılabilir).

### Müşteri kopyasında beklenen sonuç (15.09.2026 salt okunur tarama)

`VEGADB_belgedoldurucu`, F0102:

| Durum | Kodlar |
| --- | --- |
| Kart zaten var | PK, UP, SB |
| Kart açılacak | KAYIK, MPK, MSK, MUP, S.MUZ, XSMUZ |
| Açılmayacak | İNCİR — kod, meyve olarak satılan ürün kartında (kart no 129) |

Kasa satırı 395: 239'u hemen düzeltilebilir, 141'i kart bekliyor (kartlar
açılınca düzeltilebilir hale gelir), 18'i elle incelenecek (işlem 24, 25, 26,
58). İNCİR kasa olarak eklenmeyecek (kullanıcı kararı, 15.09.2026): kart 129
program tarafından 19 satış faturasında incir ürünü olarak kg ile satıldı; kasa
işaretlenirse ürün satışları ve kasa hareketleri aynı kartta birikirdi. Tip kasa
listesinde görünmez, Ayarlar'da nedeniyle "listelenmeyen" olarak durur; istenirse
oradan silinebilir. Kasa tipi olarak hiç kullanılmadı.

## Elle çalıştırma

Varsayılan çalışma salt okunurdur; açılacak kartları, açılamayanları,
düzeltilebilir satırları ve elle incelenecekleri yazar:

```powershell
npm run bakim:kasa -- --fis 00751
npm run bakim:kasa
```

Tüm satırlar `%LOCALAPPDATA%\hizli-belge-doldurucu-bakim` altındaki
`kasa-karti-tarama-*.json` dosyasındadır. `--ayar DOSYA` ile bağlantı dosyası
seçilebilir. `--uygula` önce eksik kartları açar, sonra satırları onarır:

```powershell
npm run bakim:kasa -- --fis 00751 --uygula
npm run bakim:kasa -- --uygula
npm run bakim:kasa -- --geri-al "YEDEK_DOSYASI.json"
```

`--geri-al` yalnız satır onarımını geri alır; açılan Vega kartları silinmez.

### Müşteri bilgisayarında (kaynak kod ve npm olmadan)

Araç kurulumun içinde gelir ve kurulu programın kendi Electron'u ile Node olarak
çalıştırılır. Bağlantı bilgisini kurulu programın
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

## Satır onarımı nasıl korunuyor

Yalnız program günlüğünün tek tek işaretlediği, başlık imzası ve
`LN`/`HAREKETIND` bağlantıları doğrulanan kasa satırları tek SQL
transaction'ında yerinde güncellenir; öncesinde geri alma yedeği diske yazılır.
Fatura veya iade tutarı, cari hareket, kasa defteri ve satır kimlikleri
değiştirilmez. Kartı eksik veya bağlantısı tutarsız satırlar atlanır ve raporda
kalır. Her UPDATE aynı transaction içinde tekrar okunur; bir satır değişmişse
tüm işlem geri sarılır. `--geri-al` JSON yedeğindeki yeni değerleri
karşılaştırarak eski değerleri yine tek transaction'da geri yazar.

Envanter toplamı VegaWin'de ayrıca hesaplanıyorsa Vega'nın yeniden hesaplama
işlevi gerekebilir; bu araç yalnız bağlı hareket satırlarını günceller. Riskli
satırlar müşteri kaydı değiştirilmeden ayrı incelenmelidir. İade fişinin
`AFIYATI`/`BIRIMMALIYET` deseni gerçek VegaWin girişiyle yeniden
karşılaştırılana kadar önceki kodun değerleri korunur.
