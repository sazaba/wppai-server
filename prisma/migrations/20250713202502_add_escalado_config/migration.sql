-- AlterTable
ALTER TABLE `businessconfig` ADD COLUMN `escalarPalabrasClave` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `escalarPorReintentos` INTEGER NOT NULL DEFAULT 2,
    ADD COLUMN `escalarSiNoConfia` BOOLEAN NOT NULL DEFAULT true;
