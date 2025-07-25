/*
  Warnings:

  - Added the required column `displayPhoneNumber` to the `whatsappaccount` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `whatsappaccount` ADD COLUMN `displayPhoneNumber` VARCHAR(191) NOT NULL;
