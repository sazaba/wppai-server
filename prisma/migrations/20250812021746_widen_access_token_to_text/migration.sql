/*
  Warnings:

  - You are about to alter the column `phoneNumberId` on the `whatsappaccount` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(64)`.
  - You are about to alter the column `businessId` on the `whatsappaccount` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(64)`.
  - You are about to alter the column `wabaId` on the `whatsappaccount` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(64)`.
  - You are about to alter the column `displayPhoneNumber` on the `whatsappaccount` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(32)`.

*/
-- AlterTable
ALTER TABLE `whatsappaccount` MODIFY `phoneNumberId` VARCHAR(64) NOT NULL,
    MODIFY `accessToken` TEXT NOT NULL,
    MODIFY `businessId` VARCHAR(64) NOT NULL,
    MODIFY `wabaId` VARCHAR(64) NOT NULL,
    MODIFY `displayPhoneNumber` VARCHAR(32) NOT NULL;
