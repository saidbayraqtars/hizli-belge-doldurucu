/* ============================================================
   ARTIK GEREKSİZ — sql-kullanici-olustur.sql'e taşındı
   ============================================================

   Program artık kendi ayrı bir veritabanı tutmuyor; belge doğrudan
   VEGADB'ye yazılıyor ve üç küçük yardımcı tablo da (dara, kasa defteri,
   yazma günlüğü) VEGADB'nin içine kuruluyor. Bunun için okuma yetkisi
   yetmiyor, CREATE TABLE de gerekiyor — o yüzden
   kurulum/sql-kullanici-olustur.sql artık VEGADB üzerinde baştan
   db_owner veriyor; bu betiği AYRICA çalıştırmaya gerek yok.

   Eski kurulumdan kalma bir "belge_doldurucu" kullanıcınız db_datareader
   ile sınırlıysa, tek yapmanız gereken sql-kullanici-olustur.sql'i tekrar
   çalıştırmak (var olanı bozmaz, yetkiyi db_owner'a yükseltir).

   Bu dosya yalnızca geriye dönük referans için duruyor:
   ============================================================ */

USE [VEGADB];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'belge_doldurucu')
    CREATE USER [belge_doldurucu] FOR LOGIN [belge_doldurucu];
EXEC sp_addrolemember N'db_owner', N'belge_doldurucu';
PRINT 'VEGADB: tam yetki (db_owner) verildi.';
GO
