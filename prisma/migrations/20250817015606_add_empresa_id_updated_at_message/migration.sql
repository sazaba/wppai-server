/* SAFE MIGRATION FOR EXISTING ROWS (MySQL) */

/* 1) Agregar columnas nuevas.
   - `empresaId` como NULL primero (permitir backfill)
   - `updatedAt` con DEFAULT + ON UPDATE para no romper filas existentes
*/
ALTER TABLE `message`
  ADD COLUMN `caption` TEXT NULL,
  ADD COLUMN `empresaId` INT NULL,
  ADD COLUMN `externalId` VARCHAR(191) NULL,
  ADD COLUMN `mediaId` VARCHAR(128) NULL,
  ADD COLUMN `mediaType` ENUM('image','video','audio','document') NULL,
  ADD COLUMN `mediaUrl` TEXT NULL,
  ADD COLUMN `mimeType` VARCHAR(64) NULL,
  ADD COLUMN `transcription` TEXT NULL,
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

/* 2) Backfill de empresaId desde conversation */
UPDATE `message` m
JOIN `conversation` c ON c.id = m.conversationId
SET m.empresaId = c.empresaId
WHERE m.empresaId IS NULL;

/* 3) Volver empresaId a NOT NULL */
ALTER TABLE `message`
  MODIFY `empresaId` INT NOT NULL;

/* 4) Índices */
CREATE UNIQUE INDEX `message_externalId_key` ON `message`(`externalId`);
CREATE INDEX `message_empresaId_conversationId_timestamp_idx` ON `message`(`empresaId`, `conversationId`, `timestamp`);
CREATE INDEX `message_mediaId_idx` ON `message`(`mediaId`);

/* 5) FK hacia empresa (si no existe ya) */
ALTER TABLE `message`
  ADD CONSTRAINT `message_empresaId_fkey`
  FOREIGN KEY (`empresaId`) REFERENCES `empresa`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
