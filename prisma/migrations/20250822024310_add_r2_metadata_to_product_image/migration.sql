/*
  Cambios:
  - url: de TEXT NOT NULL DEFAULT ''  ->  VARCHAR(2048) NOT NULL DEFAULT ''
  - updatedAt: NOT NULL con default y on update para no romper tablas con datos
  - Se elimina el RENAME INDEX problemático
*/

-- AlterTable
ALTER TABLE `productimage`
    ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `height` INTEGER NULL,
    ADD COLUMN `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `mediaCachedAt` DATETIME(3) NULL,
    ADD COLUMN `mimeType` VARCHAR(64) NULL,
    ADD COLUMN `objectKey` VARCHAR(255) NULL,
    ADD COLUMN `provider` ENUM('local', 's3', 'r2', 'external') NOT NULL DEFAULT 'r2',
    ADD COLUMN `sizeBytes` INTEGER NULL,
    ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0,
    -- ✅ Default + on update para no romper si ya hay filas
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ADD COLUMN `whatsappMediaId` VARCHAR(128) NULL,
    ADD COLUMN `width` INTEGER NULL,
    -- ✅ MySQL no permite DEFAULT en TEXT; usamos VARCHAR con default
    MODIFY `url` VARCHAR(2048) NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX `productimage_provider_objectKey_idx` ON `productimage`(`provider`, `objectKey`);

-- CreateIndex
CREATE INDEX `productimage_whatsappMediaId_idx` ON `productimage`(`whatsappMediaId`);
