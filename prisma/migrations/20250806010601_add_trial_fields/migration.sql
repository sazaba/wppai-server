-- AlterTable
ALTER TABLE `empresa` ADD COLUMN `conversationsUsed` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `trialEnd` DATETIME(3) NULL,
    ADD COLUMN `trialStart` DATETIME(3) NULL;
