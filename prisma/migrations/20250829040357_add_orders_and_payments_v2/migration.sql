/*
  Warnings:

  - Made the column `extras` on table `businessconfig` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `businessconfig` ADD COLUMN `bancoDocumento` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `bancoNombre` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `bancoNumeroCuenta` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `bancoTipoCuenta` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `bancoTitular` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `envioCostoFijo` DECIMAL(65, 30) NULL,
    ADD COLUMN `envioEntregaEstimado` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `envioGratisDesde` DECIMAL(65, 30) NULL,
    ADD COLUMN `envioTipo` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `facturaElectronicaInfo` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `pagoLinkGenerico` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `pagoLinkProductoBase` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `pagoNotas` TEXT NULL,
    ADD COLUMN `soporteDevolucionesInfo` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `transferenciaQRUrl` VARCHAR(191) NOT NULL DEFAULT '',
    MODIFY `descripcion` TEXT NOT NULL,
    MODIFY `servicios` TEXT NOT NULL,
    MODIFY `faq` TEXT NOT NULL,
    MODIFY `horarios` TEXT NOT NULL,
    MODIFY `disclaimers` TEXT NOT NULL,
    MODIFY `canalesAtencion` TEXT NOT NULL,
    MODIFY `enviosInfo` TEXT NOT NULL,
    MODIFY `extras` TEXT NOT NULL,
    MODIFY `metodosPago` TEXT NOT NULL,
    MODIFY `politicasDevolucion` TEXT NOT NULL,
    MODIFY `politicasGarantia` TEXT NOT NULL,
    MODIFY `promocionesInfo` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `conversation` MODIFY `estado` ENUM('pendiente', 'respondido', 'en_proceso', 'requiere_agente', 'venta_en_proceso', 'venta_realizada', 'cerrado') NOT NULL DEFAULT 'pendiente';

-- CreateTable
CREATE TABLE `order` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `empresaId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `customerPhone` VARCHAR(191) NOT NULL,
    `customerName` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `address` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `subtotal` DECIMAL(65, 30) NOT NULL DEFAULT 0,
    `shippingCost` DECIMAL(65, 30) NOT NULL DEFAULT 0,
    `total` DECIMAL(65, 30) NOT NULL DEFAULT 0,
    `notes` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `order_empresaId_conversationId_status_idx`(`empresaId`, `conversationId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orderitem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `price` DECIMAL(65, 30) NOT NULL DEFAULT 0,
    `qty` INTEGER NOT NULL DEFAULT 1,
    `total` DECIMAL(65, 30) NOT NULL DEFAULT 0,

    INDEX `orderitem_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paymentreceipt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `messageId` INTEGER NULL,
    `imageUrl` VARCHAR(191) NOT NULL DEFAULT '',
    `amount` DECIMAL(65, 30) NULL,
    `reference` VARCHAR(191) NOT NULL DEFAULT '',
    `method` VARCHAR(191) NOT NULL DEFAULT '',
    `isVerified` BOOLEAN NOT NULL DEFAULT false,
    `verifiedAt` DATETIME(3) NULL,
    `rawOcrText` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paymentreceipt_orderId_isVerified_idx`(`orderId`, `isVerified`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `order` ADD CONSTRAINT `order_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order` ADD CONSTRAINT `order_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orderitem` ADD CONSTRAINT `orderitem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orderitem` ADD CONSTRAINT `orderitem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `paymentreceipt` ADD CONSTRAINT `paymentreceipt_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `paymentreceipt` ADD CONSTRAINT `paymentreceipt_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
