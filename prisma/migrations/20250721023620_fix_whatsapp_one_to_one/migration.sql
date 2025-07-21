-- CreateTable
CREATE TABLE `WhatsappAccount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `phoneNumberId` VARCHAR(191) NOT NULL,
    `accessToken` VARCHAR(191) NOT NULL,
    `empresaId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WhatsappAccount_phoneNumberId_key`(`phoneNumberId`),
    UNIQUE INDEX `WhatsappAccount_empresaId_key`(`empresaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WhatsappAccount` ADD CONSTRAINT `WhatsappAccount_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `Empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
