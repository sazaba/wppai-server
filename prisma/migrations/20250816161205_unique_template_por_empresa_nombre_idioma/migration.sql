/*
  Warnings:

  - A unique constraint covering the columns `[empresaId,nombre,idioma]` on the table `messagetemplate` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX `messagetemplate_empresaId_nombre_idioma_key` ON `messagetemplate`(`empresaId`, `nombre`, `idioma`);
