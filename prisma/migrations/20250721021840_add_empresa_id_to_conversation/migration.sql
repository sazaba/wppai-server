/*
  Warnings:

  - Added the required column `empresaId` to the `BusinessConfig` table without a default value. This is not possible if the table is not empty.
  - Added the required column `empresaId` to the `Conversation` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `businessconfig` ADD COLUMN `empresaId` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `conversation` ADD COLUMN `empresaId` INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE `BusinessConfig` ADD CONSTRAINT `BusinessConfig_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `Empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `Empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
