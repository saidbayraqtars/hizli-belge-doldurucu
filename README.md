# Hızlı Belge Doldurucu

Sebze-meyve toptan satışı için haftalık ürün girişi ve kasa depozito takibi.
Eski Access tabanlı programın yerine geçer; farkı, oluşan belgeyi **VegaWin'in
veritabanına (VEGADB) doğru şekilde yazması**.

Tek kural: **aşırı basit olsun.** Ekrana özellik eklemeden önce gerçekten
isteniyor mu diye bakın. "Faydalı olur" diye eklenen şey burada kusur sayılır.

## Ne yapar

**Belge Gir** — asıl ekran. Müşteri seçilir, satırlar girilir:

| Alan | Açıklama |
|---|---|
| Cinsi | VEGADB stok kartından seçilir (ALANYA MUZ, KARPUZ, KAPYA BİBER…) |
| Daralı Miktar | net kg |
| Kasa Adedi | kaç kasa gitti |
| Kasa Tipi | SBÜ, PK… (Ayarlar'da tanımlanır) |
| Fiyat | TL/kg — her gün değiştiği için elle girilir |
| Tutar | miktar × fiyat, kendiliğinden hesaplanır |
| Kasa Tutarı | kasa adedi × depozito bedeli, kendiliğinden hesaplanır |

Altta iki tuş var; belgenin Vega'da ne olacağını kullanıcı seçer:

- **Satış Faturası Olarak Kaydet** → Vega'da satış faturası (stok da düşer)
- **Cari Çıkış Olarak Kaydet** → Vega'da cari çıkış dekontu (stok etkilenmez)

Kasa tutarı her iki durumda da **ayrı bir satır** olarak müşterinin cari
defterine düşer — eski programın ekstresinde de öyle görünüyordu.

**Kasa** — kasa depozitosu iade edilebilir. Müşteriye verilen kasalar borcuna
eklenir; kasalar geri geldiğinde buradan düşülür. Ekranda hangi müşteride kaç
kasa durduğu görünür.

**Rapor** — girilen belgelerin haftalık listesi. Vega'ya gönderilmemiş belgeler
buradan gönderilir, gönderilmiş olanlar geri alınabilir.

**Ekstre** — müşterinin cari hesap ekstresi: ürün satırı, kasa tutarı satırı ve
yürüyen bakiye.

**Ayarlar** — sunucu, firma/dönem, depo, kasa tipleri ve depozito bedelleri,
Vega'ya yazma kilidi.

## Firma ve dönem

Bir kez Ayarlar ekranından seçilir, ayar dosyasına yazılır ve **değiştirilmedikçe
aynı kalır**. Liste sabit değil: program `sys.tables` tarayarak veritabanında
gerçekten hangi firma ve dönemin bulunduğunu buluyor, her dönemin kaç hareketi
olduğunu ve son hareket tarihini gösteriyor — hangisinin canlı olduğu görülsün.

## Vega'ya yazma — iki katmanlı kilit

Program varsayılan olarak **VEGADB'ye hiçbir şey yazmaz**. Belgeler kendi
veritabanında (`BELGE_DOLDURUCU`) tutulur ve program tam çalışır.

Yazmak için **ikisi birden** gerekir:

1. Ayarlar ekranında "Vega'ya yazmayı aç" işaretlenmesi,
2. SQL tarafında `belge_doldurucu` kullanıcısına yazma yetkisi verilmesi
   (`kurulum/sql-kullanici-olustur.sql` dosyasının en altındaki bölüm).

Açmadan önce **`kurulum/BELGE-DESENI.md` okunmalı.** O belgede hangi yazma
deseninin canlı doğrulandığı, hangisinin benzer belgelerden çıkarıldığı işaretli;
doğrulanmamış olanlar için İzleyici ile nasıl teyit edileceği yazılı.

Yazılan her belge geri alınabilir: hangi tabloya hangi satırın yazıldığı
kaydediliyor, geri alma tam o satırları siler.

## Kurulum

### 1. SQL kullanıcısı (bir kez, sunucuda)

`kurulum/sql-kullanici-olustur.sql` içindeki şifreyi değiştirin, sonra SQL
Server'ın kurulu olduğu makinede çalıştırın:

```
sqlcmd -S localhost -E -C -i kurulum\sql-kullanici-olustur.sql
```

Betik `belge_doldurucu` kullanıcısını oluşturur, VEGADB üzerinde **sadece okuma**
yetkisi verir, `BELGE_DOLDURUCU` veritabanını açar.

### 2. Program (her bilgisayara)

`Hizli Belge Doldurucu Setup x.y.z.exe` çalıştırılır. Program ilk açılışta kendi
ayar dosyasını oluşturur:

```
%APPDATA%\Hizli Belge Doldurucu\ayarlar.json
```

Ayarlar ekranından sunucu adı ve şifre girilir, "Bağlantıyı Dene" ile doğrulanır,
"Kendi Veritabanını Kur" ile şema kurulur, firma/dönem seçilip kaydedilir.

### 3. Ağdaki diğer bilgisayarlar

SQL Server'da TCP/IP protokolü açık ve 1433 portu güvenlik duvarında izinli
olmalı. Diğer bilgisayarlara aynı kurulum dosyası kurulur; ayarlarda `sunucu`
alanına SQL Server'ın makine adı yazılır.

Kasa depozito defteri ortak veritabanında durduğu için bütün bilgisayarlarda
aynı görünür.

## Windows 7 desteği

Program Windows 7 SP1 ve sonrasında çalışır. Bunun için sürümler bilerek geride
tutuldu — yükseltilmemeli:

| Bileşen | Sürüm | Neden |
|---|---|---|
| Electron | **22.3.27** | Windows 7/8/8.1 destekleyen **son** sürüm. 23 ve sonrası Windows 10 ister |
| Node (gömülü) | 16.17 | Electron 22 ile gelir. Node 18+ Windows 7'yi bırakmıştır |
| mssql | **9.3.2** | tedious 15 kullanır, Node 16 ile çalışır. mssql 10+ Node 18 ister |

Ek olarak:

- Kurulum dosyası **x64 ve 32-bit** olarak üretilir (eski makineler 32-bit olabilir).
- Donanım hızlandırması kapalı (`app.disableHardwareAcceleration`) — eski ekran
  kartı sürücülerinde pencere bomboş açılıyordu.
- SQL sorgularında `TRY_CAST`, `OFFSET/FETCH`, `IIF`, `CONCAT`, `THROW` gibi
  SQL Server 2012+ söz dizimi kullanılmıyor; eski sunucularda da çalışır.
  Kurulum betiği rol atamasını `sp_addrolemember` ile yapıyor — `ALTER ROLE ...
  ADD MEMBER` SQL Server 2012 ister, Windows 7 makinelerinde SQL Server 2008
  çıkabiliyor.
- Arayüzde özel font ve dış kaynak yok; CSP tüm dış istekleri kapatıyor.
- **Windows oturumuyla bağlanma yok.** Bunun için gereken `msnodesqlv8` yerel
  (native) sürücüsü kurulum dosyasına paketlenmiyor: 32-bit ve 64-bit için ayrı
  derlenmiş ikili gerektiriyor ve Windows 7'de kırılgan. Program SQL kullanıcı
  adı/şifresiyle bağlanır — kurulum betiği bu kullanıcıyı zaten oluşturuyor.
  Gerekirse `npm i msnodesqlv8`, `ayarlar.json` içinde `windowsGirisi: true` ve
  yeniden derleme ile açılabilir; `db/sql.js` bu yolu destekliyor.

## Geliştirme

```
npm install
npm start            # programı çalıştır
npm run test:db      # 21 okuma sınaması (Electron gerekmez)
npm run test:yazma   # 62 yazma sınaması (aşağıdaki hazırlık gerekli)
npm run dist         # kurulum dosyasını üret (x64 + 32-bit)
```

Sınamalar bağlantı bilgilerini proje kökündeki `ayarlar.json` dosyasından alır.

### Yazma sınaması

Yazma yolu **müşteri verisine dokunulmadan** sınanır: yapısı VEGADB'den
kopyalanmış boş bir `VEGA_TEST` veritabanında çalışır. Bir kez hazırlık:

```
sqlcmd -S localhost -E -C -i kurulum\vega-test-olustur.sql
npm run test:yazma
```

Betik `VEGA_TEST` ve `BELGE_DOLDURUCU_TEST` veritabanlarını sıfırdan kurar,
tabloların yapısını kopyalar (`SELECT * INTO ... WHERE 1=0` kalıbı IDENTITY'yi
korur), kart tablolarına birkaç örnek satır koyar.

Sınama, adı bu ikisinden farklı bir veritabanı görürse hiçbir şey yapmadan
çıkar — yanlışlıkla canlı veritabanına yazmayı engelleyen koruma bu.

Sınadığı şey: beş tablonun doğru bağ alanlarıyla dolduğu, cari bakiyenin doğru
değiştiği, "Cari Çıkış" seçildiğinde stoğun etkilenmediği, kasa iadesinin
bakiyeyi düşürdüğü ve geri almanın hiç iz bırakmadığı.

> **`ELECTRON_RUN_AS_NODE` tuzağı.** Bu ortam değişkeni set ise Electron
> pencere açmaz, `Cannot read properties of undefined (reading
> 'disableHardwareAcceleration')` verir. Kabuğunuzda varsa temizleyin:
> `unset ELECTRON_RUN_AS_NODE` (PowerShell'de
> `Remove-Item Env:ELECTRON_RUN_AS_NODE`).

## Dosya düzeni

```
main.js              Electron ana süreç, IPC uçları
preload.js           Arayüzün erişebildiği kanal beyaz listesi
ui/                  Arayüz (index.html + app.css + app.js) — çerçeve yok
db/ayar.js           ayarlar.json okuma/yazma
db/sql.js            SQL Server bağlantı havuzu, sorgu ve işlem yardımcıları
db/firma.js          Firma ve dönem keşfi, tablo adı üretimi
db/vega.js           VEGADB okumaları (tek satır yazma yok)
db/kayit.js          BELGE_DOLDURUCU şeması, belgeler, kasa depozito defteri
db/yazma.js          VEGADB'ye yazan HER ŞEY — varsayılan kapalı
kurulum/BELGE-DESENI.md      Yazma deseni — yazmaya dokunmadan önce okunur
kurulum/sql-kullanici-olustur.sql   SQL kullanıcısı + kendi veritabanı
kurulum/vega-test-olustur.sql       VEGA_TEST boş kopya (yazma sınaması için)
kurulum/test-sorgular.js     21 okuma sınaması
kurulum/test-yazma.js        62 yazma sınaması
```

Kod ve değişken adları Türkçe. Sürdürün — yarısı Türkçe yarısı İngilizce bir kod
tabanını okumak zorlaşıyor.

## Bilinen durum

- Kasa depozito bedeli Vega'da tanımlı değil; programın kendi veritabanında
  tutuluyor ve Ayarlar ekranından giriliyor. Bedel girilmemiş bir kasa tipinde
  kasa tutarı sıfır hesaplanır.
- **Yazma yolu `VEGA_TEST` üzerinde çalıştı (62 sınama), ama yazdığımız belge
  VegaWin'in KENDİ ekranında açılıp görülmedi.** Canlıya almadan önce
  `kurulum/BELGE-DESENI.md` §8 yapılmalı: bir belge yazılıp Vega'nın fatura ve
  cari çıkış ekranında doğru göründüğü teyit edilmeli. Geri alma hazır, o yüzden
  deneme geri sarılabilir.
- Belge numarası bu programın kendi serisinde ilerler (varsayılan `H0000001`).
  Geri alınan bir belgenin numarası serbest kalır ve sonraki belgeye yeniden
  verilir — numara var olan satırların en büyüğünden türetiliyor.
- Kasa iadesi cari giriş dekontu (tip 13) olarak yazılıyor. Ödeme aracı alanları
  (`IZAHAT`, `PORTNO`) bilerek boş bırakılıyor ki Vega bunu kasaya postalamasın;
  gerekçesi `BELGE-DESENI.md` §5'te.
- Program simgesi yok, varsayılan Electron simgesi kullanılıyor.
- Otomatik güncelleme yok. Gerekirse `electron-updater` 5.x eklenebilir
  (6.x Windows 7 ile denenmedi); kurulum dosyaları için ayrı ve **açık** bir
  release deposu gerekir.
