/* ============================================================
   Hızlı Belge Doldurucu — SQL kullanıcısı
   ============================================================

   Sunucuda BİR KEZ çalıştırılır:

       sqlcmd -S localhost -E -C -i kurulum\sql-kullanici-olustur.sql

   Ne yapar:
     * belge_doldurucu adlı SQL kullanıcısını oluşturur,
     * VEGADB üzerinde TAM YETKİ (db_owner) verir.

   NEDEN db_owner VE NEDEN TEK ADIM: Program kendi ayrı bir veritabanı
   tutmuyor — belge doğrudan VEGADB'nin gerçek tablolarına yazılıyor, ve
   üç küçük yardımcı tablo da (dara ağırlığı, kasa depozito defteri, yazma
   günlüğü) VEGADB'nin İÇİNE kuruluyor (db/yardimci.js). Bunun için salt
   okuma yetmiyor; CREATE TABLE + INSERT/UPDATE/DELETE gerekiyor. Program
   basit bir belge girme aracı olarak kullanılacağı için ayrı bir "yazma
   yetkisini sonradan aç" betiği yerine tek adımda tam yetki veriliyor.

   Yazılabilirlik programın kendi tarafında da bir anahtarla korunuyor:
   ayarlar.json → vegayaYazmaAktif false olduğu sürece program VEGADB'ye
   tek satır yazmaz (bkz. db/yazma.js). Bu betik SQL tarafını açar; o
   anahtar YAZILABİLİR olup olmadığını, program tarafında, ayrıca kapatır.

   Betik yeniden çalıştırılabilir: var olanı bozmaz, eksik olanı ekler.

   sp_addrolemember kullanılıyor — "ALTER ROLE ... ADD MEMBER" söz dizimi
   SQL Server 2012 ve sonrasını ister. Program Windows 7 makinelerinde de
   çalışacak ve oralarda SQL Server 2008 çıkabiliyor; sp_addrolemember
   eski ve yeni sürümlerin hepsinde çalışır.
   ============================================================ */

/* Bir adım hata verirse betik burada dursun. Yoksa sonraki GO blokları
   çalışmaya devam eder ve en sonda hatalı bir "TAMAM" basılır. */
:on error exit

SET NOCOUNT ON;
GO

/* ---- 1. Şifre ve giriş (login) ----------------------------------------

   AŞAĞIDAKİ ŞİFREYİ DEĞİŞTİRİN ve aynısını programın Ayarlar ekranına
   girin. Bu dosyaya gerçek şifre yazıp depoya göndermeyin.

   Şifre yalnızca bir yerde geçiyor. Aşağıdaki kontrol, yer tutucunun
   değiştirilip değiştirilmediğini metni PARÇALI yazarak anlıyor — böylece
   yer tutucuyu topluca değiştiren bir işlem kontrolü de bozup kendi
   kendini tetiklemiyor.                                              */

DECLARE @sifre NVARCHAR(128) = N'BURAYA-GUCLU-BIR-SIFRE-YAZIN';

DECLARE @kul NVARCHAR(128) = N'belge_doldurucu';
DECLARE @sql NVARCHAR(MAX);

IF @sifre LIKE (N'BURAYA' + N'-GUCLU%')
BEGIN
  RAISERROR(N'Once dosyadaki @sifre degerini degistirin, sonra betigi calistirin.', 16, 1);
  RETURN;
END

IF LEN(@sifre) < 10
BEGIN
  RAISERROR(N'Sifre en az 10 karakter olmali.', 16, 1);
  RETURN;
END

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @kul)
BEGIN
  SET @sql = N'CREATE LOGIN ' + QUOTENAME(@kul) +
             N' WITH PASSWORD = ' + QUOTENAME(@sifre, '''') +
             N', CHECK_POLICY = OFF' +
             N', DEFAULT_DATABASE = [VEGADB];';
  EXEC sp_executesql @sql;
  PRINT N'Giris olusturuldu: ' + @kul;
END
ELSE
  PRINT N'Giris zaten var: ' + @kul;
GO

/* ---- 2. VEGADB — tam yetki (db_owner) ---------------------------------- */

USE [VEGADB];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'belge_doldurucu')
  CREATE USER [belge_doldurucu] FOR LOGIN [belge_doldurucu];
GO

EXEC sp_addrolemember N'db_owner', N'belge_doldurucu';
GO

PRINT N'';
PRINT N'TAMAM. belge_doldurucu VEGADB uzerinde tam yetkili (db_owner).';
PRINT N'Sifreyi programin Ayarlar ekranina girin, "Baglantiyi Dene" ile dogrulayin,';
PRINT N've Vega''ya yazmayi ayni ekrandan acin.';
GO

/* ============================================================
   GERİ ALMA — yalnızca okumaya döndürmek için:

   USE [VEGADB];
   EXEC sp_droprolemember N'db_owner', N'belge_doldurucu';
   EXEC sp_addrolemember N'db_datareader', N'belge_doldurucu';
   GRANT VIEW DEFINITION TO [belge_doldurucu];

   NOT: db_owner geri alınırsa program VEGADB'ye hiçbir şey yazamaz —
   yalnızca okuma ekranları (müşteri/stok listesi, ekstre) çalışır.
   ============================================================ */
