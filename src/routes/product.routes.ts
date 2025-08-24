// server/src/routes/product.routes.ts
import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import * as ctrl from '../controllers/product.controller'
import { uploadImageMem } from '../middleware/upload'

const r = Router()

// 🔓 Público: necesario para <img> sin Authorization
r.get('/:id/images/:file', ctrl.streamProductImagePublic)

// 🔐 A partir de aquí, todo requiere JWT
r.use(verificarJWT)

// CRUD productos
r.post('/', ctrl.createProduct)
r.get('/', ctrl.listProducts)
r.get('/:id', ctrl.getProduct)
r.put('/:id', ctrl.updateProduct)
r.delete('/:id', ctrl.deleteProduct)

// IMÁGENES (protegidas para gestionar)
r.post('/:id/images', ctrl.addImage)
r.post('/:id/images/upload', uploadImageMem.single('file'), ctrl.uploadProductImageR2)
r.get('/:id/images', ctrl.listProductImages)
r.put('/:id/images/:imageId/primary', ctrl.setPrimaryImage)
r.delete('/:id/images/:imageId', ctrl.deleteImage)

export default r
