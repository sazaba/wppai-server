/*
  Warnings:

  - The values [infoproductos] on the enum `BusinessConfig_businessType` will be removed. If these variants are still used in the database, this will fail.

*/
-- DropForeignKey
ALTER TABLE `businessconfig` DROP FOREIGN KEY `BusinessConfig_empresaId_fkey`;

-- AlterTable
ALTER TABLE `businessconfig` MODIFY `nombre` VARCHAR(191) NOT NULL DEFAULT '',
    MODIFY `descripcion` VARCHAR(191) NOT NULL DEFAULT '',
    MODIFY `businessType` ENUM('servicios', 'productos') NOT NULL DEFAULT 'servicios';

-- AddForeignKey
ALTER TABLE `BusinessConfig` ADD CONSTRAINT `BusinessConfig_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
