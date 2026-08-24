# Vega belge yazım deseni

`db/yazma.js` dosyasına dokunmadan önce bu belge okunmalı.

Aşağıdaki bilgi VegaWin/Arctos veritabanının canlı incelenmesinden geliyor.
Her maddenin yanında **nereden bilindiği** yazılı: doğrulanmış olanla
desenden çıkarılmış olan karışmasın.

| İşaret | Anlamı |
|---|---|
| ✅ | Canlı şemada ve `kurulum/test-yazma.js` ile doğrulandı |
| ⚠️ | Kod yazılıp sınandı ama Vega'nın KENDİ arayüzünde görüldüğü teyit edilmedi |

Doğrulama durumu: şema `F0102` / `D0001` (gerçek üretim dönemi — bkz. §10,
`D0002` hiç var olmayan bir dönemdi) üzerinde okundu; yazma yolu yapısı
kopyalanmış `VEGA_TEST` veritabanında **67 sınamayla** uçtan uca çalıştırıldı
— beş tablonun bağ alanları, cari bakiye değişimi ve geri almanın iz
bırakmaması dahil.

Kalan ⚠️: yazdığımız belgenin VegaWin'in kendi fatura/dekont ekranında
açıldığında doğru göründüğü. Bunu yalnızca Vega'yı çalıştırarak görebiliriz
(bkz. §8).

---

## 1. Tablo adlandırma ✅

```
Kart tablosu    : F{firma}TBL{ad}            → F0102TBLCARI
Dönemli tablo   : F{firma}D{dönem}TBL{ad}    → F0102D0002TBLCARIHAREKETLERI
```

Firma ve dönem kodları tablo adına **metin olarak** gömülüyor; parametre olarak
verilemiyorlar. `db/firma.js` bu yüzden yalnızca `sys.tables` içinde gerçekten
bulunan kodlara izin veriyor — kod enjeksiyonuna kapalı tek yol bu.

---

## 2. Cari hareket tablosu ✅

`TBLCARIHAREKETLERI` müşterinin defteri. Bakiye buradan hesaplanıyor:

```sql
SELECT SUM(ISNULL(BORC,0) - ISNULL(ALACAK,0))
FROM F{firma}D{dönem}TBLCARIHAREKETLERI
WHERE FIRMANO = <cari.IND> AND ISNULL(OZELKOD,'') <> 'KREDIHESABI'
```

- **Pozitif bakiye = müşteri bize borçlu.**
- `FIRMANO` = cari kartın `IND`'i (firma numarası DEĞİL — isim yanıltıcı).
- `IZAHAT` belge tipi kodunu tutan **metin** alan (`nvarchar(12)`).
- `EVRAKNO` belge numarası **metni** (`nvarchar(60)`, `'H0000001'`).
- `OZELKOD = 'KREDIHESABI'` satırları bakiyeye girmez.

### Tablonun tamamı 20 sütun — AÇIKLAMA ALANI YOK ✅

```
IND, FIRMANO, TARIH, IZAHAT, EVRAKNO, BORC, ALACAK, BAKIYE, LN, IADE,
LN2, CONVNUM, CONVSTYLE, PARABIRIMI, KUR, ODEMETARIHI, ISLEMTARIHI,
SIRALAMATARIHI, OZELKOD, SIRALAMATARIHIEX
```

Bu, programın tasarımını doğrudan belirleyen bir kısıt: **"KASA TUTARI" gibi
bir açıklama cari hareket satırına yazılamaz.** Metin belge BAŞLIĞINDA durur;
ekstre onu başlıktan okur (`db/vega.js` → `aciklamaBaglari`).

Başlangıçta cari harekete `ACIKLAMA` yazılmaya çalışılmıştı; sorgu
`Invalid column name 'ACIKLAMA'` ile düştü ve gerçek yapı böyle ortaya çıktı.

### IZAHAT kodları ✅

| Kod | Anlamı | Bakiyeye etkisi |
|---|---|---|
| 11 | Cari Çıkış (dekont) | BORÇ — bakiye artar |
| 13 | Cari Giriş / Tahsilat | ALACAK — bakiye azalır |
| 20 | Alış Faturası | ALACAK |
| 21 | Satış Faturası | BORÇ — bakiye artar |
| 22 / 23 | Alış / Satış İade | ters |
| 32 / 33 | Stok Giriş / Çıkış Fişi | — |
| 83 / 84 | Banka Giriş (havale) / Çıkış | ALACAK / BORÇ |
| 103 / 104 | Devir Giriş / Çıkış (yıl başı) | belge değil, hariç tutulur |

### 22.08.2026 düzeltmesi — gerçek kayıttan çıkan alanlar ⚠️

Kullanıcının gerçek Vega geçmişinden aktardığı alan değerleriyle karşılaştırılıp
düzeltildi (Vega'nın kendi ekranında henüz açılıp teyit edilmedi, bu yüzden ⚠️):

- **`ISLEMTARIHI`, `SIRALAMATARIHI`** artık `GETDATE()` ile (gerçek girilme anı,
  saat dahil) doluyor — önceden hiç yazılmıyordu / yalnızca kullanıcının seçtiği
  gün-başı tarihiyle dolduruluyordu.
- **`ODEMETARIHI`** artık belge tarihiyle (`TARIH` ile aynı) doluyor.
- **`OZELKOD`** artık `'MERKEZ'` yazıyor — `TBLSATFATBASLIK.OZELKOD1/OZELKOD2`
  ile aynı sabit değer, gerçek kayıtlarda tutarlı görülüyor. `'KREDIHESABI'`
  ile karışmaz (bakiye hesabı yalnız o değeri dışlıyor).

### TBLCARIGENELHAREKET — artık yazılıyor ⚠️

Bu tabloya hiç yazmıyorduk; kullanıcının gerçek kaydından bu tablonun **her**
cari harekete (satış faturası, cari çıkış, cari giriş/tahsilat) eşlik ettiği,
yalnızca satış faturasına özgü olmadığı ortaya çıktı. `db/yazma.js` →
`cariHareketEkle`'nin İÇİNDEN, `TBLCARIHAREKETLERI`'ye yazılan HER satır için
bir kez daha çağrılıyor (`cariGenelHareketEkle`).

24 sütun: `IND, FIRMANO, TARIH, VADE, BELGEIND, ISLEMIND, BELGEIZAHAT,
ISLEMIZAHAT, BELGELINK, BORC, ALACAK, AYLIKVADE, BELGENO, ISLEMNO, CONVERTED,
IPTAL, SIRALAMATARIHI, TAHSILLINK, GECIKMEHESAPLA, PARABIRIMI, KUR,
BASLIKPARABIRIMI, BASLIKKURU, ACIKLAMA, SIRALAMATARIHIEX`.

Gerçek örnekten çıkarılan desen:

| Alan | Satış / cari çıkış (BORÇ) | Tahsilat / cari giriş (ALACAK) |
|---|---|---|
| `BELGEIZAHAT` = `ISLEMIZAHAT` | izahat kodu (21 / 11) | izahat kodu (13) |
| `BELGEIND` = `ISLEMIND` = `ISLEMNO` | ilgili başlığın `IND`'i / `BELGENO`'su | aynı |
| `BELGELINK` | `NULL` | `-1` |
| `GECIKMEHESAPLA` | `0` | `1` |

Tablo bazı kurulumlarda olmayabilir (`tabloVarMi` ile önce kontrol edilir);
yoksa sessizce atlanır.

---

## 3. Bu programın yazdığı belgeler

Kullanıcı **iki tuştan** birine basıyor. Kasa depozitosu **hiçbir zaman ayrı
belge açmaz** — hangi tuşa basılırsa basılsın ürünle aynı belgenin içinde
(2. kalem). Tahsilat tek istisna: o hep ayrı bir dekont (farklı bir olay,
ödeme geldiği an).

| Kullanıcı eylemi | Vega'da oluşan | Bölüm |
|---|---|---|
| "Satış Faturası Olarak Kaydet" | Satış faturası (tip 21); kasa varsa faturanın **2. (3., ...) kalemi**, KDV'siz | §4 |
| "Cari Giriş Olarak Kaydet" (faturasız) | **Tek** Cari Giriş dekontu (tip 13), BORÇ; ürün ve kasa aynı başlık altında **2 ayrı hareket satırı** | §5 |
| Tahsilat tutarı girilmişse (her iki tuşta) | Ayrı cari giriş dekontu (tip 13), ALACAK, açıklama `Tahsilat` | §5 |
| "İadeyi Kaydet" (Kasa ekranı) | **Stok Giriş İade Fişi** (tip 34) — depo stoğu artar + cari ALACAK, açıklama `KASA IADE` | §5.1 |

Eskiden (24.08.2026'dan önce) ürün ve kasa hep 2 ayrı belgeydi, faturasız
akış da "Cari Çıkış" idi; kullanıcı ikisini de tek belgede ve Cari Giriş
yönünde istedi — "bize para girer, mal/kasa çıkar" (kendi tarifi). Buton
metni de buna göre "Cari Giriş Olarak Kaydet" oldu (iç kod adı hâlâ
`cariCikis` — sadece görünen isim değişti, bkz. `ui/index.html` /
`ui/app.js`).

**Kasa artık satış faturasının içinde:** Kasa/kap kartları artık gerçek
`TBLSTOKLAR` kartları (canlı Vega'dan geliyor, bkz. `ui/app.js` →
`durum.kasaKartlari`, id = STOKNO) — eski `BD_KasaTipi` elle-liste dönemi
bitti (bkz. [[vegadb-direkt-yazma-mimarisi]]). Fatura kesilirken kasa
gerçek bir fatura satırı (`db/yazma.js` → `belgeYaz`, `kasaSatirlari` →
`fatSatirlari`'na ekleniyor, KDV oranı bilerek 0); faturasız akışta ise
`cariDekontuYaz`'ın `kalemler` parametresiyle AYNI başlık altında 2. hareket
satırı olarak yazılıyor (satış faturasındaki çoklu-satır deseniyle aynı
mantık).

**Cari Giriş / Çıkış yönü ile Borç / Alacak yönü BAĞIMSIZ:** `giris`
(hangi Vega tablosuna/ekranına yazılsın — "para bize mi geldi, biz mi
verdik" sorusu) ile borç/alacak (müşterinin bakiyesi ne yönde değişsin)
eskiden tek bayrakla (`giris`) birlikte belirleniyordu; artık
`cariDekontuYaz(..., giris, borcMu)` olarak ayrı. Ürün satışı/kasa
depozitosu alınırken tutar "bize girmiş" sayılır (Cari Giriş) ama müşteri
yine de BORÇLANIR. Kasa **iade** edilirken artık Cari Çıkış dekontu
kullanılmıyor — bkz. §5.1: müşterinin borcu yine ALACAK ile AZALIR ama
belge Stok Giriş İade Fişi'dir (fiziksel kasa geri geldiği için depo
stoğunu da artırır).

**"Girilen fiyatlara KDV dahil" kutusu (Belge Gir ekranı):** İşaretlenirse
kullanıcının yazdığı Fiyat BRÜT kabul edilir, KDV oranına bölünerek NET
fiyata çevrilir (`ui/app.js` → `satirOku`) — Vega'ya her zaman NET
fiyat/tutar yazılır, tıpkı önceden olduğu gibi. Bu, Vega'nın kendi Satış
Faturası ekranındaki "Kdv Dahil" kutusuyla aynı mantık; kullanıcı canlı
ortamda doğruladı (kutu kapatılınca 60 TL/11.880 TL → 50 TL/9.900 TL'ye
dönüyor, yani Vega'da kalıcı bir "KDV dahil" sütunu YOK, salt o ekranın
gösterim tercihi).

---

## 4. Satış faturası (tip 21)

Beş tabloya yazılır. Bağ alanları:

```
TBLSATFATBASLIK
   IND ──────────────────────────┬─→ TBLSATFATHAREKET.EVRAKNO      ✅
   (IDENTITY)                    ├─→ TBLSTOKHAREKETLERI.BELGENO    ✅
                                 └─→ TBLDEPOENVANTER.BELGEIND      ✅
TBLSATFATHAREKET
   IND ──────────────────────────┬─→ TBLSTOKHAREKETLERI.LN         ✅
   (IDENTITY)                    └─→ TBLDEPOENVANTER.HAREKETIND    ✅
TBLSTOKHAREKETLERI
   EVRAKNO ←── belge numarası metni ('H0000001')                   ✅
   BELGENO ←── başlık IND, SAYI olarak                             ✅
   IZAHAT  ←── 21
   CIKAN   ←── miktar (satışta çıkış)
TBLDEPOENVANTER
   ENVANTER ←── −miktar (fark tutar, bakiye değil)                 ✅
TBLCARIHAREKETLERI
   IZAHAT '21', BORC = genel toplam, EVRAKNO = belge no metni       ✅
```

> **En kolay yapılan hata:** `TBLSTOKHAREKETLERI.BELGENO` alanının belge
> numarası metnini tuttuğunu sanmak. Tutmuyor — **sayıdır ve başlığın IND'ini**
> tutar. Numara metni `EVRAKNO` alanındadır. İsimler sezgiye ters.

Beş bağın hepsi `test-yazma.js` içinde ayrı ayrı sınanıyor: belge yazıldıktan
sonra her hareket satırı başlığa ve satıra JOIN edilebiliyor mu diye
sayılıyor. Yanlış bağlanan satır hatasız yazılır ama Vega'nın hiçbir ekranında
görünmez — sessiz bozulmanın en sık kaynağı bu.

### Alan adı tuzakları ✅

Desenden beklenip **gerçekte var olmayan** alanlar (ilk yazımda kullanılmış,
şema okunduktan sonra düzeltildi):

| Beklenen | Gerçek | Tablo |
|---|---|---|
| `TOPLAM` | yok (`GERCEKTOPLAM` var) | `TBLSATFATHAREKET` |
| `ARATOPLAM`, `KDV`, `EKBELGETIPI` | yok | `TBLCARCIKBASLIK` |
| `STOKHAREKETEYAZ`, `CARIHAREKETEYAZ`, `SUCCESS` | yok (yalnız fatura başlığında var) | `TBLCARCIKBASLIK` |
| `ALTNOT` | **`ACIKLAMA`** | `TBLCARCIKBASLIK` |
| `DETAY`, `TARIH` | yok | `TBLCARCIKHAREKET` |

`db/yazma.js` → `ekle()` bu yüzden INSERT'i hedef tabloda **gerçekten bulunan**
sütunlardan kuruyor: yanlış alan adı belgenin tamamını düşürmüyor, ama olmazsa
olmaz bir alan eksikse net bir hata veriyor.

### 22.08.2026 düzeltmesi — başlık ve satır alanları ⚠️

Kullanıcının gerçek Vega kaydından karşılaştırılıp düzeltildi:

**`TBLSATFATBASLIK`** (başlık):
- `FIRMAADI` artık **hiç yazılmıyor** (`NULL`) — önceden cari adı yazılıyordu.
- `KDV` sütunu **`BIT`** tipinde — tutar değil! Artık "KDV var mı" bayrağı
  (`kdvToplam > 0 ? 1 : 0`) yazıyor. Önceden yanlışlıkla KDV tutarı yazılıyordu.
- `ENVANTERUPDATE` artık `0` (önceden `1`), `SUCCESS` artık **hiç yazılmıyor**
  (önceden `1` zorlanıyordu).
- `AK` artık `0` yazıyor (önceden hiç yazılmıyordu).
- `USERNO` artık **sabit `100`** — kullanıcının gerçek kaydında bu değer sabit
  görülmüş; `secenek.userNo` artık bu tabloda kullanılmıyor.
- Yeni sabit alanlar: `OZELKOD1='MERKEZ'`, `OZELKOD2='MERKEZ'`, `YUVARLAMA=0`,
  `ALLOWYUVARLAMA=0`, `ODENEN=0`, `ENTEGRE=0`, `SATISSEKLI=0`, `YURTDISI=0`,
  `MUHASEBELESMEYECEK=0`, `KAYNAK=0`, `EFATURA=0`.

**`TBLSATFATHAREKET`** (satır):
- `KDVTUTARI` artık **hiç yazılmıyor** (`NULL`) — önceden hesaplanan tutar
  yazılıyordu. Dikkat: bu tabloda ayrıca `KDVTUTAR` (sonunda "I" yok) diye
  **ayrı bir sütun daha** var, karıştırılmamalı — ona da dokunulmuyor.
- `SATIRNO` artık **hiç yazılmıyor** (önceden `0, 1, 2...` sırayla yazılıyordu).
- Yeni sabit alanlar: `ISK1..ISK6=0`, `PERSONEL=0`, `PIRIM=0`, `OPSIYON=0`,
  `PROMOSYON=0`, `SATISKOSULU=1`, `SERIMIKTAR=1`, `MASRAF=0`, `OIV=0`,
  `INDIRIM=0`, `OTV=0`, `GRUPMIKTAR=1`.

---

## 5. Cari çıkış / cari giriş dekontu (tip 11 / 13) ✅

Üç tabloya yazılır, **stok hareketi oluşmaz**:

```
TBLCARCIKBASLIK  (çıkış)  /  TBLCARGIRBASLIK  (giriş)
   IND ─────────→ TBLCARCIKHAREKET.EVRAKNO / TBLCARGIRHAREKET.EVRAKNO
   BELGENO, TARIH, FIRMANO (cari IND), BELGETIPI (11 / 13), TUTAR,
   ACIKLAMA ("KASA TUTARI" / "KASA IADE"), GIRIS (0 / 1), CREDATE
TBLCARIHAREKETLERI
   BORC/ALACAK ←── `borcMu` parametresi (bkz. §3) — IZAHAT'tan (11/13)
                   BAĞIMSIZ, hangi tabloya yazıldığından değil çağıranın
                   niyetinden gelir
```

### Ödeme aracı alanları bilerek boş bırakılıyor ✅

`TBLCARCIKHAREKET` / `TBLCARGIRHAREKET` tablosundaki **`IZAHAT` belge tipi
değil, ÖDEME ARACI kodudur** — `PORTNO` ona eşlik eder:

| `IZAHAT` | `PORTNO` | Vega bunu nereye postalar |
|---|---|---|
| 1 | −1 | `TBLKASA` → **kasa nakdine girer** |
| 2 | | `TBLCEKGIRIS` / `TBLCEKCIKIS` |
| 3 | | `TBLSENETGIRIS` / `TBLSENETCIKIS` |
| | 6 | `TBLVISAPORTFOY` (kredi kartı) |

Yazdığımız satır bir tahsilat değil, cari defter düzeltmesi. Nakit
işaretlersek Vega'nın kasa raporunda **karşılığı olmayan bir para** görünür ve
kasa bakiyesi gerçeği tutmaz. Bu yüzden `IZAHAT`, `PORTNO` ve `BANKANO`
alanlarına dokunulmuyor. `test-yazma.js` bu alanların boş kaldığını ayrıca
sınıyor.

---

## 5.1. Kasa iadesi — Stok Giriş İade Fişi (tip 34) ✅

24.08.2026'ya kadar kasa iadesi de §5'teki gibi bir Cari Çıkış dekontuydu.
Kullanıcı canlıda şu belgeyi açtı: "Cari Çıkış Bordrosu" ekranında **Şube ve
Kasa alanları boş** görünüyordu ve belge Vega'da kapanmıyordu. Şema kontrol
edildi: **`TBLCARCIKBASLIK`'ta Şube/Kasa/Depo'ya karşılık gelen HİÇBİR sütun
yok** (32 sütunun tamamı tarandı) — bu alanlar orada doldurulamaz bile, boş
kalması Vega'nın kendi kısıtı. Kullanıcı Vega'nın kendi "Stok Giriş İade
Fişi" ekranından ELLE bir kayıt oluşturdu (BELGENO A0000001, F0102/D0001,
24.08.2026) ve bu, aşağıdaki desenin **doğrudan kaynağı**: tahmin değil,
Vega'nın kendi ürettiği gerçek satırlardan okundu.

```
TBLSTKGIRBASLIK
   IND ──────────────────────────┬─→ TBLSTKGIRHAREKET.EVRAKNO
   (IDENTITY)                    ├─→ TBLSTOKHAREKETLERI.BELGENO   (sayı!)
                                  └─→ TBLDEPOENVANTER.BELGEIND
   BELGETIPI = 34, IADE = 1, GIRIS = 1
   OZELKOD1 = 'MERKEZ'  ←── Şube (ekranda görünen alan)
   OZELKOD2 = 'MERKEZ'  ←── Kasa (ekranda görünen alan)
   HAREKETDEPOSU = depo, STOKHAREKETEYAZ = 1, CARIHAREKETEYAZ = 1
TBLSTKGIRHAREKET
   IND ──────────────────────────┬─→ TBLSTOKHAREKETLERI.LN
   (IDENTITY)                    └─→ TBLDEPOENVANTER.HAREKETIND
TBLSTOKHAREKETLERI
   IZAHAT '34', GIREN = adet, CIKAN = 0                              (satıştaki tersi)
TBLDEPOENVANTER
   ENVANTER = +adet ←── kasa fiziksel stoğa geri girdi                (satıştaki -miktar'ın tersi)
TBLCARIHAREKETLERI
   IZAHAT '34', ALACAK = tutar, OZELKOD = ''                          (§5'teki 'MERKEZ' DEĞİL — gerçek kayıtta boş)
TBLCARIGENELHAREKET
   BELGEIZAHAT = ISLEMIZAHAT = 34, BELGELINK = NULL, GECIKMEHESAPLA = NULL
   (ALACAK > 0 olsa bile — §5'teki tahsilat sezgisiyle karıştırılmasın diye
   `cariHareketEkle`/`cariGenelHareketEkle`'ye elle geçiliyor)
```

`db/yazma.js` → `stokGirisIadesiYaz`. `kasaIadesiYaz` bu tabloları
(`TBLSTKGIRBASLIK`/`TBLSTKGIRHAREKET`) bulamazsa ya da depo seçili değilse
eski yola (yalnız cari dekont, §5) düşer — geriye dönük uyumluluk için.
`kurulum/vega-test-olustur.sql`'e bu iki tablo da eklendi;
`kurulum/test-yazma.js` §C bu deseni sınıyor.

---

## 6. Kimlik ve numara üretimi ✅

Başlık tablolarının `IND` alanı **IDENTITY**'dir. Numarayı SQL Server üretir;
dışarıdan `MAX(IND)+1` **hesaplanmaz**.

Belge numarası metni (`BELGENO`) için program **HER ZAMAN** Ayarlar'daki
kendi önekini kullanır (varsayılan `H`) — `db/yazma.js` → `onekTespitEt`.
Eskiden Vega'nın kendi satış faturası serisini (`TBLSATFATBASLIK.BELGENO`'daki
en sık geçen tek harf önek, `satisSerisiTespitEt`) bulup onu sürdürüyordu;
24.08.2026'da KALDIRILDI — aynı seriyi paylaşmak Vega'nın kendi
muhasebeleştirmesiyle çakışıyordu: belge Vega'da açıldığında/eski
hareketlerden girildiğinde Vega ikinci bir `TBLCARIHAREKETLERI` satırı
üretip bakiyeyi ikiye katlıyordu (bkz. A0000009 olayı, §2). Artık program
serisi Vega'nın gerçek serisiyle asla kesişmiyor. Sayaç, satış faturası /
cari dekont / stok giriş iade fişi arasında **PAYLAŞILAN TEK sayaç**
(`BELGE_NO_TABLOLARI` dört tabloyu birden tarar) — aynı belge iki farklı
numara taşımasın diye.

> **Yarış tehlikesi.** Program ağdaki birkaç bilgisayara kurulacak. `BELGENO`
> IDENTITY değil; iki bilgisayar aynı anda kaydederse ikisi de aynı `MAX + 1`
> değerini okur. Bu yüzden numara **işlemin içinde**, `WITH (UPDLOCK, HOLDLOCK)`
> ile aralık kilitlenerek alınıyor (`db/yazma.js` → `siradakiBelgeNo`).

---

## 7. Programın uyduğu kurallar

- **Tek işlem.** Bir belgenin tüm satırları tek transaction içinde yazılır. Bir
  adım hata verirse hiçbiri kalmaz; yarım belge oluşmaz.
- **Yazılan her satır kaydedilir.** Hangi tabloya hangi `IND`'in yazıldığı
  `VEGADB.dbo.BD_Islem.Yazilan` alanında JSON olarak durur (`db/yardimci.js`).
  Geri alma tam o satırları, ters sırada siler.
- **Var olmayan sütuna yazılmaz.** Her INSERT hedef tabloda gerçekten bulunan
  sütunlardan kurulur (`db/yazma.js` → `ekle`). Olmazsa olmaz bir sütun eksikse
  işlem net bir hatayla durur — sessizce yanlış belge yazmaz.
- **Program kendi ayrı bir veritabanı tutmaz.** Belge doğrudan VEGADB'nin
  gerçek tablolarına yazılır. `ayarlar.json` → `vegayaYazmaAktif` kapalıyken
  program tek satır yazmaz; SQL tarafında da `belge_doldurucu` VEGADB üzerinde
  tam yetkilidir (`kurulum/sql-kullanici-olustur.sql`).
- **Günlük.** Her yazma `VEGADB.dbo.BD_Islem` tablosuna kullanıcı, bilgisayar
  ve satır kimlikleriyle yazılır.

### Dört sert kural ✅

1. **`DELETED = 0` yazma.** Alan satırların neredeyse tamamında `NULL`;
   `ISNULL(DELETED, 0) = 0` kullan. Yoksa liste boş döner.
2. **`TBLDEPOENVANTER.ENVANTER` fark (delta) tutar, bakiye değil.** Güncel stok
   = deltaların toplamı. `BELGETIPI = 67` hariç tutulur.
3. **`TBLSTOKHAREKETLERI.BELGENO` sayıdır ve başlık IND'ini tutar.**
4. **`SIRALAMATARIHIEX` kayan noktalı tarihtir:** `CONVERT(FLOAT, GETDATE())`.
   Aynı gün içindeki hareketlerin sırasını belirler.

---

## 8. Yazmayı açmadan önce — İzleyici ile doğrulama

⚠️ işaretli desenler tahminle yazılmadı ama bu veritabanında da doğrulanmadı.
Yanlış yazılan belge stok, maliyet ve muhasebe zincirini birden bozar. Sıra:

1. **VEGADB'nin yedeğini al.**
2. Vega'nın gerçekte ne yazdığını yakala. `rapor programı (galya)` projesindeki
   taşınabilir `GalyaIzleyici.exe` bunu yapıyor (SQL Server Extended Events,
   veri değiştirmez, yalnızca dinler). Elle kurulacaksa:

```sql
IF EXISTS(SELECT 1 FROM sys.server_event_sessions WHERE name='belge_izleme')
  DROP EVENT SESSION [belge_izleme] ON SERVER;
CREATE EVENT SESSION [belge_izleme] ON SERVER
  ADD EVENT sqlserver.sql_statement_completed(
    ACTION(sqlserver.client_app_name, sqlserver.sql_text)
    WHERE sqlserver.database_name = N'VEGADB'),
  ADD EVENT sqlserver.rpc_completed(
    ACTION(sqlserver.client_app_name, sqlserver.sql_text)
    WHERE sqlserver.database_name = N'VEGADB')
  ADD TARGET package0.ring_buffer(SET max_memory=8192)
  WITH (MAX_DISPATCH_LATENCY=3 SECONDS, TRACK_CAUSALITY=ON);
ALTER EVENT SESSION [belge_izleme] ON SERVER STATE = START;
```

3. VegaWin'de **elle** bir satış faturası ve bir cari çıkış dekontu gir.
4. Ring buffer'ı oku, `INSERT` ifadelerini bu belgedeki desenle karşılaştır:

```sql
SELECT CAST(t.target_data AS XML)
FROM sys.dm_xe_sessions s
JOIN sys.dm_xe_session_targets t ON t.event_session_address = s.address
WHERE s.name = 'belge_izleme' AND t.target_name = 'ring_buffer';
```

5. **Oturumu kapat** (`DROP EVENT SESSION [belge_izleme] ON SERVER;`) — açık
   kalırsa sunucudaki kayıt büyümeye devam eder.
6. Fark varsa `db/yazma.js` düzeltilir ve bu belge güncellenir.
7. Yazmayı önce DEMO firmasında, sonra canlıda tek belgeyle dene; Vega'nın kendi
   ekranından belgeyi aç, doğru göründüğünü gör; geri almayı da dene.

**Extended Events sysadmin ister** — genelde `sa` ile bağlanılır. Programın
kendi `belge_doldurucu` kullanıcısının bu yetkisi yok ve olmamalı.

---

## 9. Boş kopya veritabanında yazma sınaması

Müşteri verisine dokunmadan yazma yolunu denemek için, yapısı VEGADB'den
kopyalanmış boş bir veritabanı kullanılır:

```sql
CREATE DATABASE [VEGA_TEST];
-- Her tablo için: SELECT * INTO [VEGA_TEST].dbo.<tablo>
--                 FROM [VEGADB].dbo.<tablo> WHERE 1 = 0
```

`SELECT * INTO ... WHERE 1=0` kalıbı IDENTITY özelliğini korur; bu yüzden
seçildi. Sonra `ayarlar.json` içindeki `vegaVeritabani` geçici olarak
`VEGA_TEST` yapılır, yazma açılır, belge yazılıp geri alınır.

---

## 10. 22.08.2026 — "faturaları görüntüleyemiyoruz" kök nedeni ✅

Canlı VEGADB'de A-serisi (Vega'nın kendi ekranından girilmiş) ile bu
programın yazdığı belgeler karşılaştırılmak istendiğinde ortaya çıktı:
**`VEGADB.dbo.BD_Islem` günlüğü tamamen boştu** — program o ana kadar tek
bir belgeyi bile gerçek VEGADB'ye yazamamıştı. Sebep koddaki bir mantık
hatası değil, **yapılandırma hatasıydı**:

```
ayarlar.json  →  "varsayilanDonem": "D0002"
```

Ama `F0102` firmasında (ve tek firma olan `F0101`'de de) VEGADB'de **yalnızca
`D0001` dönemi var** — `D0002` hiç var olmadı. `db/firma.js` → `dogrula()`
her çağrıda dönemi `firma.donemler` listesine karşı doğruluyor; `D0002` o
listede olmadığı için her `belgeYaz()` çağrısı **hiçbir INSERT çalışmadan**,
en baştaki doğrulama adımında `Dönem bulunamadı: F0102 / D0002` hatasıyla
düşüyordu. Bu yüzden Vega'da hiçbir zaman görülecek bir fatura oluşmadı —
görüntüleme sorunu değil, yazmanın hiç başlamamasıydı.

Ayarlar ekranındaki dönem seçici yalnızca gerçekten var olan dönemleri
listeler (`firmalariGetir()`), yani bu değer arayüzden asla seçilemezdi;
muhtemelen ilk kurulumda elle ya da geliştirme sırasında örnek bir değerle
yazılmıştı — aynı yanlış değer `kurulum/test-yazma.js` ve
`kurulum/vega-test-olustur.sql` içinde de vardı (üçü birlikte düzeltildi).
`VEGA_TEST` de bu yüzden önceden eksik kuruluyordu: `SELECT * INTO` var
olmayan `F0102D0002...` kaynak tablolarını bulamayıp o tabloları sessizce
atlıyordu (`atlandi (VEGADB icinde yok)`).

**Düzeltilen 3 dosya:** `ayarlar.json`, `kurulum/test-yazma.js`,
`kurulum/vega-test-olustur.sql` — hepsi `D0001`. `vega-test-olustur.sql`
yeniden çalıştırıldı, artık 16/16 tablo kopyalanıyor (önceden çoğu
atlanıyordu); `test-yazma.js` 67/67 geçiyor.

### Belge serisi tespiti — tek harf varsayımı yanlıştı ✅

Aynı karşılaştırmada ikinci bir gerçek hata bulundu: `F0101` firmasının
gerçek fatura serisi `MSA2026000000001` — üç harfli sabit önek + yıl + 9
haneli sayaç. `db/vega.js` → `satisSerisiTespitEt` öneği `LEFT(BELGENO, 1)`
ile tek harfe kesiyordu ("M"); bu hem yanlış önekle numara üretirdi
("M0000001", gerçek formatla eşleşmez) hem de sayaç genişliği
`db/yazma.js` → `siradakiBelgeNo` içinde sabit 7 basamak varsayıyordu (gerçek
seri 9 basamaklı). İkisi de düzeltildi: önek artık `PATINDEX` ile BELGENO'daki
ilk rakama kadar olan tüm baştaki harfleri alıyor (`F0102` için hâlâ "A",
`F0101` için artık doğru "MSA"), sayaç genişliği de o seride görülen gerçek
basamak sayısından okunuyor (bulunamazsa 7'ye düşülüyor — eski davranış).

### Fatura başlığında 3 alan daha düzeltildi ⚠️

5 gerçek faturanın (`A0000001..5`) tamamı karşılaştırıldı, tutarlı 3 fark
bulundu:

- **`DEPO`** (başlık) hiç yazılmamalı — 5/5 gerçek faturada `NULL`. Depo
  numarası yalnızca `HAREKETDEPOSU`'nda tutuluyor. Önceden ikisine de aynı
  değer yazılıyordu.
- **`ENVANTERUPDATE`** hiç yazılmamalı — 5/5 gerçek faturada `NULL`, `0`
  değil. Önceden `0` zorlanıyordu.
- **`ODEMETARIHI`** artık `TARIH` ile aynı değeri alıyor (3/5 gerçek
  faturada dolu, hep `TARIH` ile aynı) — önceden bu tabloda hiç yazılmıyordu.

### Canlı VEGADB'de tek belge yazıp geri alma ✅

Kullanıcı onayıyla gerçek VEGADB'de (F0102/D0001, cari 296, 1 TL'lik sembolik
satır) `belgeYaz()` çalıştırıldı: 6 tablonun tümüne yazıldı (`TBLSATFATBASLIK`
IND 117, `TBLSATFATHAREKET`, `TBLSTOKHAREKETLERI`, `TBLDEPOENVANTER`,
`TBLCARIHAREKETLERI`, `TBLCARIGENELHAREKET`), cari bakiye 35→36 oldu, yazılan
başlık satırı A0000001-5 ile aynı desende çıktı (DEPO=NULL, ENVANTERUPDATE=
NULL, ODEMETARIHI dolu, USERNO=100, OZELKOD1/2='MERKEZ'). Sonra `belgeGeriAl()`
6 satırı sildi, bakiye 36→35'e döndü, hiçbir iz kalmadı.

Bu sırada üçüncü bir gerçek bug bulundu ve düzeltildi:

#### `sys.columns.max_length` BAYT'tır, KARAKTER değil ✅

İlk canlı deneme `String or binary data would be truncated` hatasıyla düştü
(transaction düzgün geri sarıldı, iz kalmadı). Kaynağı:
`TBLCARIGENELHAREKET.ACIKLAMA` sütunu `nvarchar(100)` — ama `nvarchar` iki
bayt/karakter kullandığı için bu **50 karakter** demek, 100 değil. Yazılan
açıklama (`"Hizli Belge Doldurucu - fis ..."`) 52 karakterdi, taştı. Şemayı
okuyan kodda (`db/vega.js` → `kolonVarMi` ile ilgisiz, burada
`db/yazma.js` → `sutunlariGetir`) bu ayrım hiç yapılmıyordu.

Kalıcı çözüm sabit bir yerde `.substring(N)` değil — `ekle()` artık her
tablonun HER metin sütununun gerçek karakter sınırını (`nvarchar`/`nchar` için
`max_length/2`, `varchar`/`char` için `max_length`) şemadan okuyup, o sütuna
yazılan her string değeri otomatik kırpıyor. Müşteriden müşteriye sütun
genişliği değişebildiği için (bkz. §"Şema uyumu") sabit bir kırpma boyu güvenli
değil — gerçek sınır neyse ona göre kırpılıyor.

`VEGA_TEST`'te 67/67, canlıda ikinci deneme (bu düzeltmeyle) 6/6 tablo temiz
yazıldı ve geri alındı.

### Hâlâ doğrulanamayan ⚠️

Vega'nın KENDİ ekranında bir faturanın açılıp doğru göründüğü henüz
görülmedi — bu yalnızca VegaWin çalıştırılarak, insan gözüyle teyit
edilebilir (§8). Yazma yolu artık canlıda kanıtlanmış durumda; kalan tek
belirsizlik görüntüleme, veri bütünlüğü değil.
