-- AlterTable
ALTER TABLE `whatsappaccount` MODIFY `businessId` VARCHAR(64) NULL,
    MODIFY `displayPhoneNumber` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `whatsappaccount_wabaId_idx` ON `whatsappaccount`(`wabaId`);
