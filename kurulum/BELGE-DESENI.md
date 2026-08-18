# Vega belge yazım deseni

`db/yazma.js` dosyasına dokunmadan önce bu belge okunmalı.

Aşağıdaki bilgi VegaWin/Arctos veritabanının canlı incelenmesinden geliyor.
Her maddenin yanında **nereden bilindiği** yazılı: doğrulanmış olanla
desenden çıkarılmış olan karışmasın.

| İşaret | Anlamı |
|---|---|
| ✅ | Canlı şemada ve `kurulum/test-yazma.js` ile doğrulandı |
| ⚠️ | Kod yazılıp sınandı ama Vega'nın KENDİ arayüzünde görüldüğü teyit edilmedi |

Doğrulama durumu: şema `F0102` / `D0002` (GALYA YENİ, 1.646 stok kartı)
üzerinde okundu; yazma yolu yapısı kopyalanmış `VEGA_TEST` veritabanında
**62 sınamayla** uçtan uca çalıştırıldı — beş tablonun bağ alanları, cari
bakiye değişimi ve geri almanın iz bırakmaması dahil.

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

---

## 3. Bu programın yazdığı belgeler

Kullanıcı **iki tuştan** birine basıyor; kasa depozitosu her iki durumda da
ayrı bir dekont oluyor.

| Kullanıcı eylemi | Vega'da oluşan | Bölüm |
|---|---|---|
| "Satış Faturası Olarak Kaydet" | Satış faturası (tip 21) | §4 |
| "Cari Çıkış Olarak Kaydet" | Cari çıkış dekontu (tip 11) | §5 |
| Kasa adedi girilmişse (her iki tuşta) | Ayrı cari çıkış dekontu (tip 11), açıklama `KASA TUTARI` | §5 |
| "İadeyi Kaydet" (Kasa ekranı) | Cari giriş dekontu (tip 13), açıklama `KASA IADE` | §5 |

**Kasa tutarı neden ayrı belge:** Vega'da kasa/kap için stok kartı yok, dolayısıyla
fatura satırı olamaz. Zaten istenen davranış da bu — eski programın ekstresinde
kasa tutarı, ürün satırının **altında ayrı bir satır** olarak duruyor ve ikisi
toplanıp bakiyeye işleniyor.

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
| `SIRANO` | **`SATIRNO`** | `TBLSATFATHAREKET` |
| `TOPLAM` | yok (`GERCEKTOPLAM` var) | `TBLSATFATHAREKET` |
| `ARATOPLAM`, `KDV`, `EKBELGETIPI` | yok | `TBLCARCIKBASLIK` |
| `STOKHAREKETEYAZ`, `CARIHAREKETEYAZ`, `SUCCESS` | yok (yalnız fatura başlığında var) | `TBLCARCIKBASLIK` |
| `ALTNOT` | **`ACIKLAMA`** | `TBLCARCIKBASLIK` |
| `DETAY`, `TARIH` | yok | `TBLCARCIKHAREKET` |

`db/yazma.js` → `ekle()` bu yüzden INSERT'i hedef tabloda **gerçekten bulunan**
sütunlardan kuruyor: yanlış alan adı belgenin tamamını düşürmüyor, ama olmazsa
olmaz bir alan eksikse net bir hata veriyor.

---

## 5. Cari çıkış / cari giriş dekontu (tip 11 / 13) ✅

Üç tabloya yazılır, **stok hareketi oluşmaz**:

```
TBLCARCIKBASLIK  (çıkış)  /  TBLCARGIRBASLIK  (giriş)
   IND ─────────→ TBLCARCIKHAREKET.EVRAKNO / TBLCARGIRHAREKET.EVRAKNO
   BELGENO, TARIH, FIRMANO (cari IND), BELGETIPI (11 / 13), TUTAR,
   ACIKLAMA ("KASA TUTARI" / "KASA IADE"), GIRIS (0 / 1), CREDATE
TBLCARIHAREKETLERI
   IZAHAT '11' → BORC        (müşteriyi borçlandırır)
   IZAHAT '13' → ALACAK      (borcunu düşürür)
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

## 6. Kimlik ve numara üretimi ✅

Başlık tablolarının `IND` alanı **IDENTITY**'dir. Numarayı SQL Server üretir;
dışarıdan `MAX(IND)+1` **hesaplanmaz**.

Belge numarası metni (`BELGENO`) için Vega kendi serilerinde `A`, `S` ve `Z`
öneklerini kullanıyor. Bu program **ayrı bir önek** kullanır (varsayılan `H`,
Ayarlar'dan değiştirilir) — ürettiğimiz numara Vega'nın kendi sayacıyla asla
çakışmaz.

> **Yarış tehlikesi.** Program ağdaki birkaç bilgisayara kurulacak. `BELGENO`
> IDENTITY değil; iki bilgisayar aynı anda kaydederse ikisi de aynı `MAX + 1`
> değerini okur. Bu yüzden numara **işlemin içinde**, `WITH (UPDLOCK, HOLDLOCK)`
> ile aralık kilitlenerek alınıyor (`db/yazma.js` → `siradakiBelgeNo`).

---

## 7. Programın uyduğu kurallar

- **Tek işlem.** Bir belgenin tüm satırları tek transaction içinde yazılır. Bir
  adım hata verirse hiçbiri kalmaz; yarım belge oluşmaz.
- **Yazılan her satır kaydedilir.** Hangi tabloya hangi `IND`'in yazıldığı
  `BELGE_DOLDURUCU.dbo.Belge.VegaKayit` alanında JSON olarak durur. Geri alma tam
  o satırları, ters sırada siler.
- **Var olmayan sütuna yazılmaz.** Her INSERT hedef tabloda gerçekten bulunan
  sütunlardan kurulur (`db/yazma.js` → `ekle`). Olmazsa olmaz bir sütun eksikse
  işlem net bir hatayla durur — sessizce yanlış belge yazmaz.
- **İki katmanlı kilit.** `ayarlar.json` → `vegayaYazmaAktif` **ve** SQL
  tarafında `db_datawriter` yetkisi. İkisi de açılmadan VEGADB'ye tek satır
  gitmez.
- **Günlük.** Her yazma `BELGE_DOLDURUCU.dbo.Islem` tablosuna kullanıcı,
  bilgisayar ve satır kimlikleriyle yazılır.

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
