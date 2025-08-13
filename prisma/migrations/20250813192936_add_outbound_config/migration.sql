-- CreateTable
CREATE TABLE `outboundconfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `empresaId` INTEGER NOT NULL,
    `fallbackTemplateName` VARCHAR(191) NOT NULL DEFAULT 'hola',
    `fallbackTemplateLang` VARCHAR(191) NOT NULL DEFAULT 'es',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `outboundconfig_empresaId_key`(`empresaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `message_conversationId_timestamp_idx` ON `message`(`conversationId`, `timestamp`);

-- AddForeignKey
ALTER TABLE `outboundconfig` ADD CONSTRAINT `outboundconfig_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
