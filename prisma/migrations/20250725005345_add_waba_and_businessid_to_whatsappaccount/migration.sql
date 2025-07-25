/*
  Warnings:

  - Added the required column `businessId` to the `whatsappaccount` table without a default value. This is not possible if the table is not empty.
  - Added the required column `wabaId` to the `whatsappaccount` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE `businessconfig` DROP FOREIGN KEY `BusinessConfig_empresaId_fkey`;

-- DropForeignKey
ALTER TABLE `conversation` DROP FOREIGN KEY `Conversation_empresaId_fkey`;

-- DropForeignKey
ALTER TABLE `message` DROP FOREIGN KEY `Message_conversationId_fkey`;

-- DropForeignKey
ALTER TABLE `usuario` DROP FOREIGN KEY `Usuario_empresaId_fkey`;

-- DropForeignKey
ALTER TABLE `whatsappaccount` DROP FOREIGN KEY `WhatsappAccount_empresaId_fkey`;

-- AlterTable
ALTER TABLE `whatsappaccount` ADD COLUMN `businessId` VARCHAR(191) NOT NULL,
    ADD COLUMN `wabaId` VARCHAR(191) NOT NULL;

-- AddForeignKey
ALTER TABLE `usuario` ADD CONSTRAINT `usuario_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message` ADD CONSTRAINT `message_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `conversation` ADD CONSTRAINT `conversation_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `businessconfig` ADD CONSTRAINT `businessconfig_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `whatsappaccount` ADD CONSTRAINT `whatsappaccount_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `usuario` RENAME INDEX `Usuario_email_key` TO `usuario_email_key`;

-- RenameIndex
ALTER TABLE `whatsappaccount` RENAME INDEX `WhatsappAccount_empresaId_key` TO `whatsappaccount_empresaId_key`;

-- RenameIndex
ALTER TABLE `whatsappaccount` RENAME INDEX `WhatsappAccount_phoneNumberId_key` TO `whatsappaccount_phoneNumberId_key`;
