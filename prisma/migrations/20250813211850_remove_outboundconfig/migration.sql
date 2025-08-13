/*
  Warnings:

  - You are about to drop the `outboundconfig` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `outboundconfig` DROP FOREIGN KEY `outboundconfig_empresaId_fkey`;

-- DropTable
DROP TABLE `outboundconfig`;
