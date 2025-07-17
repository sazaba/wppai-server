-- AlterTable
ALTER TABLE `message` MODIFY `from` ENUM('client', 'bot', 'agent') NOT NULL;
