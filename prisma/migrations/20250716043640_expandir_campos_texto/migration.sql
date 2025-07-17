/*
  Warnings:

  - You are about to alter the column `nombre` on the `businessconfig` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(100)`.
  - You are about to alter the column `horarios` on the `businessconfig` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(100)`.

*/
-- AlterTable
ALTER TABLE `businessconfig` MODIFY `nombre` VARCHAR(100) NOT NULL,
    MODIFY `descripcion` TEXT NOT NULL,
    MODIFY `servicios` TEXT NOT NULL,
    MODIFY `faq` TEXT NOT NULL,
    MODIFY `horarios` VARCHAR(100) NOT NULL,
    MODIFY `escalarPalabrasClave` TEXT NOT NULL,
    ALTER COLUMN `escalarPorReintentos` DROP DEFAULT,
    ALTER COLUMN `escalarSiNoConfia` DROP DEFAULT;
