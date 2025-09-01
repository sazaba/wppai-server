-- AlterTable
ALTER TABLE `businessconfig` ADD COLUMN `agentDisclaimers` TEXT NULL,
    ADD COLUMN `agentPrompt` TEXT NULL,
    ADD COLUMN `agentScope` TEXT NULL,
    ADD COLUMN `agentSpecialty` ENUM('generico', 'medico', 'dermatologia', 'nutricion', 'psicologia', 'odontologia') NOT NULL DEFAULT 'generico',
    ADD COLUMN `aiMode` ENUM('ecommerce', 'agente') NOT NULL DEFAULT 'ecommerce';
