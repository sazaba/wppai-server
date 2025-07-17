-- AlterTable
ALTER TABLE `conversation` MODIFY `estado` ENUM('pendiente', 'respondido', 'en_proceso', 'requiere_agente', 'cerrado') NOT NULL DEFAULT 'pendiente';
