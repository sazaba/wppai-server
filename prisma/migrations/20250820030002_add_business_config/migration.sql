-- DropForeignKey
ALTER TABLE `businessconfig` DROP FOREIGN KEY `BusinessConfig_empresaId_fkey`;

-- AddForeignKey
ALTER TABLE `businessconfig` ADD CONSTRAINT `businessconfig_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `businessconfig` RENAME INDEX `BusinessConfig_empresaId_key` TO `businessconfig_empresaId_key`;
