-- AlterTable
ALTER TABLE `businessconfig` ADD COLUMN `canalesAtencion` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `direccionTienda` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `enviosInfo` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `extras` JSON NULL,
    ADD COLUMN `metodosPago` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `palabrasClaveNegocio` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `politicasDevolucion` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `politicasGarantia` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `promocionesInfo` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `tiendaFisica` BOOLEAN NOT NULL DEFAULT false;
