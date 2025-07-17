/*
  Warnings:

  - You are about to alter the column `estado` on the `conversation` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Enum(EnumId(0))`.
  - You are about to alter the column `from` on the `message` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Enum(EnumId(1))`.

*/
-- AlterTable
ALTER TABLE `conversation` MODIFY `estado` ENUM('pendiente', 'respondido', 'en_proceso', 'requiere_agente') NOT NULL DEFAULT 'pendiente';

-- AlterTable
ALTER TABLE `message` MODIFY `from` ENUM('client', 'bot') NOT NULL;
