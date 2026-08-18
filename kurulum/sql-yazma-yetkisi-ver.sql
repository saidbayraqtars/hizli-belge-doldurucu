/* ============================================================
   Hizli Belge Doldurucu — VEGADB yazma yetkisi
   ============================================================

   NE ZAMAN GEREKIR:
   Programdaki "Vega'ya yazma" bayragi acik olsa bile, SQL kullanicisi
   VEGADB uzerinde salt okunur kuruldugu icin yazma islemleri su hatayla
   duser:

     The INSERT permission was denied on the object '...'

   Bu betik belge_doldurucu kullanicisina VEGADB uzerinde yazma yetkisi
   verir. Yani programin ikinci emniyet kilidini kaldirir.

   ONCE:
     1. VEGADB'nin YEDEGINI ALIN.
     2. Yazma sinamalarinin VEGA_TEST uzerinde gectigini gorun:
          node kurulum/test-yazma.js
     3. kurulum/BELGE-DESENI.md okunmus olmali.

   NASIL CALISTIRILIR (yonetici yetkisi olan bir hesapla):

     sqlcmd -S localhost -E -C -i kurulum/sql-yazma-yetkisi-ver.sql

   GERI ALMAK ICIN en alttaki bolum kullanilir.
   ============================================================ */

USE [VEGADB];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'belge_doldurucu')
    CREATE USER [belge_doldurucu] FOR LOGIN [belge_doldurucu];
ALTER ROLE db_datareader ADD MEMBER [belge_doldurucu];
ALTER ROLE db_datawriter ADD MEMBER [belge_doldurucu];
PRINT 'VEGADB: okuma + yazma yetkisi verildi.';
GO

/* ------------------------------------------------------------
   GERI ALMA — yazma yetkisini kaldirir, okuma kalir:

   USE [VEGADB];
   ALTER ROLE db_datawriter DROP MEMBER [belge_doldurucu];
   PRINT 'VEGADB: yazma yetkisi kaldirildi.';
   ------------------------------------------------------------ */
