/*
  Warnings:

  - Added the required column `imageId` to the `productimage` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `productimage` ADD COLUMN `imageId` VARCHAR(128) NOT NULL,
    MODIFY `provider` ENUM('local', 's3', 'r2', 'external', 'cloudflare_image') NOT NULL DEFAULT 'external',
    ALTER COLUMN `updatedAt` DROP DEFAULT;

-- RenameIndex
ALTER TABLE `productimage` RENAME INDEX `productimage_productId_fkey` TO `productimage_productId_idx`;
