/* ============================================================
   VEGA_TEST — yazma sınaması için boş kopya veritabanı
   ============================================================

   Yönetici yetkisiyle BİR KEZ çalıştırılır:

       sqlcmd -S localhost -E -C -i kurulum\vega-test-olustur.sql

   Sonra yazma sınaması:

       node kurulum/test-yazma.js

   Ne yapar:
     * VEGA_TEST veritabanını sıfırdan oluşturur (varsa siler),
     * VEGADB'den gereken tabloların YAPISINI kopyalar,
     * kart tablolarını birkaç örnek satırla doldurur (geçerli cari ve
       stok numarası olsun),
     * hareket tablolarını BOŞ bırakır,
     * belge_doldurucu kullanıcısına burada okuma+yazma yetkisi verir.

   VEGADB'ye tek satır yazmaz — yalnızca okur.

   Neden "SELECT * INTO ... WHERE 1=0" kalıbı: bu kalıp IDENTITY özelliğini
   korur. Program belge numaralarını IDENTITY'den alıyor; korunmazsa sınama
   gerçek davranışı ölçmez.
   ============================================================ */

:on error exit

SET NOCOUNT ON;
GO

USE [master];
GO

IF DB_ID(N'VEGA_TEST') IS NOT NULL
BEGIN
  ALTER DATABASE [VEGA_TEST] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE [VEGA_TEST];
  PRINT N'Eski VEGA_TEST silindi.';
END
GO

CREATE DATABASE [VEGA_TEST];
GO

PRINT N'VEGA_TEST olusturuldu.';
GO

USE [VEGA_TEST];
GO

DECLARE @firma SYSNAME = N'F0102';
DECLARE @donem SYSNAME = N'D0002';

DECLARE @kart TABLE (ad SYSNAME, veriIle BIT, sinir INT);
DECLARE @sql NVARCHAR(MAX);
DECLARE @tam SYSNAME;
DECLARE @kaynak SYSNAME;
DECLARE @ad SYSNAME;
DECLARE @veriIle BIT;
DECLARE @sinir INT;

/* Global tablolar (ön eksiz) — firma ve depo listesi veriyle gelmeli,
   yoksa program firmayi bulamaz. */
INSERT INTO @kart (ad, veriIle, sinir) VALUES
  (N'TBLFIRMA',   1, NULL),
  (N'TBLDONEM',   1, NULL),
  (N'TBLDEPOLAR', 1, NULL);

/* Kart tablolari (F{firma}...) — ornek satirlarla. */
INSERT INTO @kart (ad, veriIle, sinir) VALUES
  (@firma + N'TBLCARI',       1, 5),
  (@firma + N'TBLSTOKLAR',    1, 5),
  (@firma + N'TBLBIRIMLEREX', 1, 50);

/* Hareket tablolari (F{firma}D{donem}...) — BOS. */
INSERT INTO @kart (ad, veriIle, sinir) VALUES
  (@firma + @donem + N'TBLCARIHAREKETLERI', 0, NULL),
  (@firma + @donem + N'TBLCARCIKBASLIK',    0, NULL),
  (@firma + @donem + N'TBLCARCIKHAREKET',   0, NULL),
  (@firma + @donem + N'TBLCARGIRBASLIK',    0, NULL),
  (@firma + @donem + N'TBLCARGIRHAREKET',   0, NULL),
  (@firma + @donem + N'TBLSATFATBASLIK',    0, NULL),
  (@firma + @donem + N'TBLSATFATHAREKET',   0, NULL),
  (@firma + @donem + N'TBLSTOKHAREKETLERI', 0, NULL),
  (@firma + @donem + N'TBLDEPOENVANTER',    0, NULL);

DECLARE gezgin CURSOR LOCAL FAST_FORWARD FOR
  SELECT ad, veriIle, sinir FROM @kart;

OPEN gezgin;
FETCH NEXT FROM gezgin INTO @ad, @veriIle, @sinir;

WHILE @@FETCH_STATUS = 0
BEGIN
  IF OBJECT_ID(N'[VEGADB].dbo.' + QUOTENAME(@ad), 'U') IS NULL
  BEGIN
    PRINT N'  atlandi (VEGADB icinde yok): ' + @ad;
  END
  ELSE
  BEGIN
    SET @sql =
      N'SELECT ' +
      CASE WHEN @veriIle = 1 AND @sinir IS NOT NULL
           THEN N'TOP ' + CAST(@sinir AS NVARCHAR(10)) + N' ' ELSE N'' END +
      N'* INTO [VEGA_TEST].dbo.' + QUOTENAME(@ad) +
      N' FROM [VEGADB].dbo.' + QUOTENAME(@ad) +
      CASE WHEN @veriIle = 1 THEN N';' ELSE N' WHERE 1 = 0;' END;

    EXEC sp_executesql @sql;

    SET @sql = N'SELECT @adet = COUNT(*) FROM [VEGA_TEST].dbo.' + QUOTENAME(@ad);
    DECLARE @adet INT;
    EXEC sp_executesql @sql, N'@adet INT OUTPUT', @adet = @adet OUTPUT;

    PRINT N'  kopyalandi: ' + @ad + N'  (' + CAST(@adet AS NVARCHAR(10)) + N' satir)';
  END

  FETCH NEXT FROM gezgin INTO @ad, @veriIle, @sinir;
END

CLOSE gezgin;
DEALLOCATE gezgin;
GO

/* IDENTITY korundu mu? Program belge numarasini IDENTITY'den aliyor. */
PRINT N'';
PRINT N'IDENTITY tasiyan tablolar (bos olmamali):';
GO

SELECT t.name AS tablo, c.name AS kolon
FROM [VEGA_TEST].sys.columns c
JOIN [VEGA_TEST].sys.tables t ON t.object_id = c.object_id
WHERE c.is_identity = 1
ORDER BY t.name;
GO

/* belge_doldurucu kullanicisina burada okuma + YAZMA yetkisi.
   Bu bir sinama veritabani; gercek VEGADB'de yazma yetkisi ayrica ve
   bilerek verilir (bkz. sql-kullanici-olustur.sql, bolum 5). */

USE [VEGA_TEST];
GO

IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'belge_doldurucu')
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'belge_doldurucu')
    CREATE USER [belge_doldurucu] FOR LOGIN [belge_doldurucu];

  EXEC sp_addrolemember N'db_datareader', N'belge_doldurucu';
  EXEC sp_addrolemember N'db_datawriter', N'belge_doldurucu';
  GRANT VIEW DEFINITION TO [belge_doldurucu];
  PRINT N'belge_doldurucu kullanicisina VEGA_TEST uzerinde okuma+yazma verildi.';
END
ELSE
  PRINT N'UYARI: belge_doldurucu girisi yok. Once sql-kullanici-olustur.sql calistirilmali.';
GO

/* Sinama, programin kendi kayitlarini da ayri bir veritabaninda tutar;
   gercek BELGE_DOLDURUCU sinama satirlariyla kirlenmesin. */

USE [master];
GO

IF DB_ID(N'BELGE_DOLDURUCU_TEST') IS NOT NULL
BEGIN
  ALTER DATABASE [BELGE_DOLDURUCU_TEST] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE [BELGE_DOLDURUCU_TEST];
END
GO

CREATE DATABASE [BELGE_DOLDURUCU_TEST];
GO

USE [BELGE_DOLDURUCU_TEST];
GO

IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'belge_doldurucu')
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'belge_doldurucu')
    CREATE USER [belge_doldurucu] FOR LOGIN [belge_doldurucu];
  EXEC sp_addrolemember N'db_owner', N'belge_doldurucu';
  PRINT N'BELGE_DOLDURUCU_TEST olusturuldu, yetki verildi.';
END
GO

PRINT N'';
PRINT N'TAMAM. Simdi: node kurulum/test-yazma.js';
GO
