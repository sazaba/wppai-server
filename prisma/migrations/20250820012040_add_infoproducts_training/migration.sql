/*
  Warnings:

  - You are about to drop the column `escalarPalabrasClave` on the `businessconfig` table. All the data in the column will be lost.
  - You are about to drop the column `escalarPorReintentos` on the `businessconfig` table. All the data in the column will be lost.
  - You are about to drop the column `escalarSiNoConfia` on the `businessconfig` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[empresaId]` on the table `BusinessConfig` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE `businessconfig` DROP FOREIGN KEY `businessconfig_empresaId_fkey`;

-- AlterTable
ALTER TABLE `businessconfig` DROP COLUMN `escalarPalabrasClave`,
    DROP COLUMN `escalarPorReintentos`,
    DROP COLUMN `escalarSiNoConfia`,
    ADD COLUMN `businessType` ENUM('servicios', 'infoproductos') NOT NULL DEFAULT 'servicios',
    ADD COLUMN `disclaimers` VARCHAR(191) NOT NULL DEFAULT '',
    MODIFY `nombre` VARCHAR(191) NOT NULL,
    MODIFY `descripcion` VARCHAR(191) NOT NULL,
    MODIFY `servicios` VARCHAR(191) NOT NULL DEFAULT '',
    MODIFY `faq` VARCHAR(191) NOT NULL DEFAULT '',
    MODIFY `horarios` VARCHAR(191) NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE `Product` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `empresaId` INTEGER NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(191) NOT NULL,
    `descripcion` VARCHAR(191) NOT NULL DEFAULT '',
    `beneficios` VARCHAR(191) NOT NULL DEFAULT '',
    `caracteristicas` VARCHAR(191) NOT NULL DEFAULT '',
    `precioDesde` DECIMAL(65, 30) NULL,
    `disponible` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Product_slug_key`(`slug`),
    INDEX `Product_empresaId_nombre_idx`(`empresaId`, `nombre`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductImage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productId` INTEGER NOT NULL,
    `url` VARCHAR(191) NOT NULL,
    `alt` VARCHAR(191) NOT NULL DEFAULT '',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `BusinessConfig_empresaId_key` ON `BusinessConfig`(`empresaId`);

-- AddForeignKey
ALTER TABLE `BusinessConfig` ADD CONSTRAINT `BusinessConfig_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Product` ADD CONSTRAINT `Product_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductImage` ADD CONSTRAINT `ProductImage_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
