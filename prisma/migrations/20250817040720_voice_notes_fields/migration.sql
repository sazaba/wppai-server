-- AlterTable
ALTER TABLE `message` ADD COLUMN `durationSec` INTEGER NULL,
    ADD COLUMN `isVoiceNote` BOOLEAN NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `message_empresaId_externalId_idx` ON `message`(`empresaId`, `externalId`);
