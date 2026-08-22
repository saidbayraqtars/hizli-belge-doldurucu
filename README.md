# Hızlı Belge Doldurucu

Sebze-meyve toptan satışı için haftalık ürün girişi ve kasa depozito takibi.
Eski Access tabanlı programın yerine geçer; farkı, girilen belgeyi **doğrudan
VegaWin'in veritabanına (VEGADB) yazması** — programın kendi ayrı bir
veritabanı yoktur.

Tek kural: **aşırı basit olsun.** Belge girecek kişi bilgisayardan pek
anlamayan biri olacak — ekrana özellik eklemeden önce gerçekten isteniyor mu
diye bakın. "Faydalı olur" diye eklenen şey burada kusur sayılır.

## Ne yapar

**Belge Gir** — tek ve asıl ekran. Müşteri seçilir, satırlar girilir:

| Alan | Açıklama |
|---|---|
| Cinsi | VEGADB stok kartından seçilir (ALANYA MUZ, KARPUZ, KAPYA BİBER…) |
| Kasa Adedi | kaç kasa/kap gitti |
| Kasa Tipi | Vega'daki kasa/kap kartları — adında "KASA" ya da "DEPOZİTO" geçen stok kartları, canlı okunur |
| Brüt Miktar | kasayla birlikte tartılan kg |
| Dara | kasa adedi × kasa tipinin dara ağırlığı, kendiliğinden hesaplanır |
| Daralı Miktar | brüt − dara, kendiliğinden hesaplanır |
| Fiyat | elle girilir (Vega'da sebze-meyve için günlük değişen bir satış fiyatı tutulmuyor); ürün kartında bir fiyat varsa öneri olarak gelir |
| Tutar | daralı miktar × fiyat, kendiliğinden hesaplanır |
| Kasa Tutarı | kasa adedi × depozito bedeli, kendiliğinden hesaplanır |

Ayrıca **Tahsilat** alanı var: ürün satılıp aynı anda ödeme de alınıyorsa,
buraya girilen tutar kadar ayrı bir **cari giriş (tahsilat)** dekontu yazılır
— borç ve tahsilat aynı belgeyle birlikte Vega'ya gider.

Altta iki tuş var; belgenin Vega'da ne olacağını kullanıcı seçer:

- **Satış Faturası Olarak Kaydet** → Vega'da satış faturası (stok da düşer)
- **Cari Çıkış Olarak Kaydet** → Vega'da cari çıkış dekontu (stok etkilenmez)

Tuşa basılınca belge **anında** Vega'ya yazılır — ara bir "kaydet, sonra
gönder" adımı yok. Kasa tutarı her iki durumda da **ayrı bir dekont** olarak
müşterinin cari defterine düşer; kasa adedi de ayrıca kasa depozito defterine
işlenir (aşağıya bakın).

**Kasa** — kasa/kap depozitosu iade edilebilir. Müşteriye verilen kasalar
borcuna eklenir; kasalar geri geldiğinde buradan tek tuşla düşülür ve Vega'ya
yazılır. Ekranda hangi müşteride kaç kasa durduğu görünür.

**Son Belgeler** — yazılan belgelerin günlüğü: tarih, tür, müşteri, Vega belge
no, tutar. Her satırda bir **Geri Al** düğmesi var — yanlış girilen belge tek
tuşla Vega'dan silinir, müşterinin bakiyesi işlem öncesi haline döner.

**Ekstre** — müşterinin cari hesap ekstresi: ürün satırı, kasa tutarı satırı,
tahsilat satırı ve yürüyen bakiye; altta müşteride duran kasa özeti.

**Ayarlar** — sunucu, firma/dönem, depo, Vega'ya yazma kilidi, kasa/kap
kartlarının dara ağırlığı.

## Firma ve dönem

Bir kez Ayarlar ekranından seçilir, ayar dosyasına yazılır ve **değiştirilmedikçe
aynı kalır**. Liste sabit değil: program `sys.tables` tarayarak veritabanında
gerçekten hangi firma ve dönemin bulunduğunu buluyor, her dönemin kaç hareketi
olduğunu ve son hareket tarihini gösteriyor — hangisinin canlı olduğu görülsün.

## Programın kendi veritabanı yok

Belge, tek bir SQL işleminde, doğrudan VEGADB'nin gerçek tablolarına yazılır
(`TBLSATFATBASLIK`, `TBLCARCIKBASLIK`, `TBLCARIHAREKETLERI`, …). Ara bir
"kendi veritabanımızda tut, sonra gönder" adımı yok.

Vega'nın kendisinde bulunmayan, ama programın çalışması için gereken üç küçük
şey **VEGADB'nin İÇİNE**, `BD_` önekli üç tabloya kuruluyor (ayrı bir veritabanı
değil — aynı VEGADB, `db/yardimci.js`):

| Tablo | Ne tutar | Neden Vega'da yok |
|---|---|---|
| `BD_KasaTipi` | Kasa/kap tipinin dara ağırlığı (boşken kaç kg) | Vega'nın stok kartında böyle bir alan yok |
| `BD_KasaHareket` | Müşteride kaç kasa açık olduğunun defteri (verilen/iade) | `TBLCARIHAREKETLERI` yalnızca PARA tutar, ADET tutmaz |
| `BD_Islem` | Hangi Vega satırına ne yazıldığının günlüğü | Geri alma bunsuz yapılamaz |

Bu üç tablo dışında **hiçbir belge, hiçbir müşteri/stok bilgisi programın
kendi tarafında durmaz** — hepsi doğrudan Vega'nın gerçek tablolarındadır.

## Vega'ya yazma — tek katmanlı kilit

Program varsayılan olarak **VEGADB'ye hiçbir şey yazmaz**; yalnızca okuma
ekranları (müşteri/stok listesi, ekstre) çalışır. Yazmak için Ayarlar
ekranındaki **"Vega'ya yazmayı aç"** işaretlenmelidir.

SQL tarafında yetki tek adımda veriliyor
(`kurulum/sql-kullanici-olustur.sql`, VEGADB üzerinde `db_owner`) — ayrı bir
"yazma yetkisini sonradan aç" betiği yok; program CREATE TABLE + yazma
yapabildiği için zaten tam yetki gerekiyor.

Açmadan önce **`kurulum/BELGE-DESENI.md` okunmalı.** O belgede hangi yazma
deseninin canlı doğrulandığı, hangisinin benzer belgelerden çıkarıldığı işaretli.

Yazılan her belge geri alınabilir: hangi tabloya hangi satırın yazıldığı
`VEGADB.dbo.BD_Islem` tablosunda kaydediliyor, geri alma tam o satırları siler.

## Satış faturası serisi

Belge numarası önce o firma/dönemde **Vega'nın kendi satış faturası serisini**
bulmaya çalışır: `TBLSATFATBASLIK.BELGENO`'daki en sık kullanılan tek harf önek
(ör. "A") bulunur ve numara **oradan devam eder** — program kendi ayrı bir
serisini değil, işletmenin gerçek/vergi dairesine bildirilmiş serisini
sürdürür. O firma/dönemde hiç fatura yoksa (yeni firma/dönem), Ayarlar
ekranındaki öneğe (varsayılan `H`) düşülür.

Numara **program genelinde tek sayaçtır**: aynı belgede yazılan fatura, kasa
dekontu ve tahsilat aynı seriden ayrı ayrı numara alır — hepsi
`WITH (UPDLOCK, HOLDLOCK)` ile aralık kilitlenerek okunur, bu programın kendi
kopyaları aynı anda çalışsa bile numara çakışmaz. (VegaWin'in kendi ekranından
tam o anda girilen bir belgeyle çakışma riski sıfırlanmaz — kullanım şeklinin
bunu örtüşmediği varsayılıyor.)

## Kasa tipleri nereden geliyor

Kasa/kap tipleri (ör. PK, SBÜYÜK, SMUZ, UP) Vega'da hiç yok — eski Access
programının kendi kısa kodlarıydı, gerçek işletme verisiyle doğrulandı.
Bu yüzden Vega'dan OKUNMUYOR: Ayarlar ekranından elle eklenir, her biri
kendi kodu, adı, depozito bedeli ve darasıyla (kap boşken kaç kg) birlikte
`BD_KasaTipi`'de tutulur.

## Kurulum

### 1. SQL kullanıcısı (bir kez, sunucuda)

`kurulum/sql-kullanici-olustur.sql` içindeki şifreyi değiştirin, sonra SQL
Server'ın kurulu olduğu makinede çalıştırın:

```
sqlcmd -S localhost -E -C -i kurulum\sql-kullanici-olustur.sql
```

Betik `belge_doldurucu` kullanıcısını oluşturur ve VEGADB üzerinde **tam
yetki (db_owner)** verir — program üç küçük yardımcı tabloyu kendisi kurup
yazacağı için salt okuma yetmiyor. Yazılabilirlik programın kendi tarafında
Ayarlar ekranındaki anahtarla ayrıca korunuyor.

### 2. Program (her bilgisayara)

`Hizli Belge Doldurucu Setup x.y.z.exe` çalıştırılır. Program ilk açılışta kendi
ayar dosyasını oluşturur:

```
%APPDATA%\Hizli Belge Doldurucu\ayarlar.json
```

Ayarlar ekranından sunucu adı ve şifre girilir, "Bağlantıyı Dene" ile
doğrulanır, firma/dönem seçilip kaydedilir, Vega'ya yazma açılır.

### 3. Ağdaki diğer bilgisayarlar

SQL Server'da TCP/IP protokolü açık ve 1433 portu güvenlik duvarında izinli
olmalı. Diğer bilgisayarlara aynı kurulum dosyası kurulur; ayarlarda `sunucu`
alanına SQL Server'ın makine adı yazılır.

Kasa depozito defteri VEGADB'nin içinde durduğu için bütün bilgisayarlarda
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
npm run test:db      # okuma sınaması (Electron gerekmez)
npm run test:yazma   # yazma sınaması (aşağıdaki hazırlık gerekli)
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

Betik `VEGA_TEST` veritabanını sıfırdan kurar, tabloların yapısını kopyalar
(`SELECT * INTO ... WHERE 1=0` kalıbı IDENTITY'yi korur), kart tablolarına
birkaç örnek satır ve adında KASA geçen sınama amaçlı bir kart koyar. Program
kendi ayrı bir veritabanı tutmadığı için `BD_` tabloları da VEGA_TEST'in
içine kurulur — ayrıca bir "kendi test veritabanı" gerekmiyor.

Sınama, adı `VEGA_TEST`'ten farklı bir veritabanı görürse hiçbir şey yapmadan
çıkar — yanlışlıkla canlı veritabanına yazmayı engelleyen koruma bu.

Sınadığı şey: beş tablonun doğru bağ alanlarıyla dolduğu, cari bakiyenin doğru
değiştiği, tahsilatın ayrı bir cari giriş olarak yazıldığı, "Cari Çıkış"
seçildiğinde stoğun etkilenmediği, kasa defterinin (`BD_KasaHareket`) doğru
işlediği, kasa iadesinin bakiyeyi düşürdüğü ve geri almanın hiç iz
bırakmadığı.

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
db/yardimci.js       VEGADB'nin İÇİNE kurulan 3 küçük tablo — dara, kasa defteri, yazma günlüğü
db/yazma.js          VEGADB'ye yazan HER ŞEY — varsayılan kapalı
kurulum/BELGE-DESENI.md      Yazma deseni — yazmaya dokunmadan önce okunur
kurulum/sql-kullanici-olustur.sql   SQL kullanıcısı + VEGADB üzerinde tam yetki
kurulum/vega-test-olustur.sql       VEGA_TEST boş kopya (yazma sınaması için)
kurulum/test-sorgular.js     okuma sınaması
kurulum/test-yazma.js        yazma sınaması
```

Kod ve değişken adları Türkçe. Sürdürün — yarısı Türkçe yarısı İngilizce bir kod
tabanını okumak zorlaşıyor.

## Bilinen durum

- **Yazma yolu `VEGA_TEST` üzerinde sınandı, ama yazdığımız belge VegaWin'in
  KENDİ ekranında açılıp görülmedi.** Canlıya almadan önce
  `kurulum/BELGE-DESENI.md` §8 yapılmalı: bir belge yazılıp Vega'nın fatura ve
  cari çıkış ekranında doğru göründüğü teyit edilmeli. Geri alma hazır, o yüzden
  deneme geri sarılabilir.
- Fatura serisi tespiti (Vega'nın gerçek harfini bulup sürdürme) yeni: önce
  DEMO ya da az önemli bir firma/dönemde denenmeli, tespit edilen harfin
  gerçekten doğru olduğu gözle de doğrulanmalı.
- Kasa tipleri (PK, SBÜYÜK, SMUZ, UP...) Vega'da hiç yok — eski Access
  programının kendi kodlarıydı. Bu yüzden Vega'dan OKUNMUYOR; Ayarlar
  ekranından elle eklenir (kod, ad, dara, depozito).
- Kasa iadesi cari giriş dekontu (tip 13) olarak yazılıyor. Ödeme aracı alanları
  (`IZAHAT`, `PORTNO`) bilerek boş bırakılıyor ki Vega bunu kasaya postalamasın;
  gerekçesi `BELGE-DESENI.md` §5'te.
- Program simgesi yok, varsayılan Electron simgesi kullanılıyor.
- Otomatik güncelleme yok. Gerekirse `electron-updater` 5.x eklenebilir
  (6.x Windows 7 ile denenmedi); kurulum dosyaları için ayrı ve **açık** bir
  release deposu gerekir.
