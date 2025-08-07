-- CreateTable
CREATE TABLE `messagetemplate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nombre` VARCHAR(100) NOT NULL,
    `idioma` VARCHAR(10) NOT NULL,
    `categoria` VARCHAR(50) NOT NULL,
    `cuerpo` TEXT NOT NULL,
    `estado` VARCHAR(191) NOT NULL DEFAULT 'pendiente',
    `variables` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `empresaId` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `messagetemplate` ADD CONSTRAINT `messagetemplate_empresaId_fkey` FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
