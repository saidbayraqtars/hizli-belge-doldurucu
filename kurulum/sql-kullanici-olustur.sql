/* ============================================================
   Hızlı Belge Doldurucu — SQL kullanıcısı
   ============================================================

   Sunucuda BİR KEZ çalıştırılır:

       sqlcmd -S localhost -E -C -i kurulum\sql-kullanici-olustur.sql

   Ne yapar:
     * programın kendi veritabanını (BELGE_DOLDURUCU) oluşturur,
     * belge_doldurucu adlı SQL kullanıcısını oluşturur,
     * VEGADB üzerinde SADECE OKUMA yetkisi verir,
     * kullanıcıyı programın kendi veritabanında sahip yapar.

   Yani bu betik çalıştıktan sonra program VEGADB'yi okuyabilir ama
   YAZAMAZ. Yazma yetkisi dosyanın en altındaki bölümde, ayrıca ve
   bilerek verilir.

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

/* ---- 1. Programın kendi veritabanı -----------------------------------
   Girişten önce oluşturuluyor: kullanıcının varsayılan veritabanı
   olarak gösterilebilsin.                                            */

IF DB_ID(N'BELGE_DOLDURUCU') IS NULL
BEGIN
  CREATE DATABASE [BELGE_DOLDURUCU];
  PRINT N'Veritabani olusturuldu: BELGE_DOLDURUCU';
END
ELSE
  PRINT N'Veritabani zaten var: BELGE_DOLDURUCU';
GO

/* ---- 2. Şifre ve giriş (login) ---------------------------------------

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
             N', DEFAULT_DATABASE = [BELGE_DOLDURUCU];';
  EXEC sp_executesql @sql;
  PRINT N'Giris olusturuldu: ' + @kul;
END
ELSE
  PRINT N'Giris zaten var: ' + @kul;
GO

/* ---- 3. Kendi veritabanında tam yetki --------------------------------
   Program şemayı (tablo, indeks) kendisi kuruyor.                    */

USE [BELGE_DOLDURUCU];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'belge_doldurucu')
  CREATE USER [belge_doldurucu] FOR LOGIN [belge_doldurucu];
GO

EXEC sp_addrolemember N'db_owner', N'belge_doldurucu';
GO

/* ---- 4. VEGADB — yalnızca okuma -------------------------------------- */

USE [VEGADB];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'belge_doldurucu')
  CREATE USER [belge_doldurucu] FOR LOGIN [belge_doldurucu];
GO

EXEC sp_addrolemember N'db_datareader', N'belge_doldurucu';
GO

/* Program firma ve dönem listesini sys.tables tarayarak buluyor. */
GRANT VIEW DEFINITION TO [belge_doldurucu];
GO

PRINT N'';
PRINT N'TAMAM. Program VEGADB uzerinde SADECE OKUYABILIR.';
PRINT N'Sifreyi programin Ayarlar ekranina girin ve "Baglantiyi Dene" ile dogrulayin.';
GO


/* ============================================================
   5. YAZMA YETKİSİ — BİLEREK AYRI TUTULDU
   ============================================================

   Aşağıdaki bölüm YORUM içindedir. Program VEGADB'ye ancak
   (a) ayarlar.json içindeki vegayaYazmaAktif true yapıldığında VE
   (b) aşağıdaki yetki verildiğinde yazabilir.

   İki katmanı da açmadan önce:
     1. kurulum/BELGE-DESENI.md okunmalı,
     2. VEGADB'nin yedeği alınmalı,
     3. İşlem önce DEMO firmasında (ya da yapısı kopyalanmış boş bir
        veritabanında) denenmeli.

   -- USE [VEGADB];
   -- GO
   -- EXEC sp_addrolemember N'db_datawriter', N'belge_doldurucu';
   -- GO

   Yazma yetkisini geri almak için:

   -- USE [VEGADB];
   -- GO
   -- EXEC sp_droprolemember N'db_datawriter', N'belge_doldurucu';
   -- GO
   ============================================================ */
