import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import * as ctrl from '../controllers/product.controller'
import { uploadImageMem } from '../middleware/upload'

const r = Router()

// Protege todo el grupo de rutas:
r.use(verificarJWT)

// CRUD productos
r.post('/', ctrl.createProduct)
r.get('/', ctrl.listProducts)
r.get('/:id', ctrl.getProduct)
r.put('/:id', ctrl.updateProduct)
r.delete('/:id', ctrl.deleteProduct)

// IMÁGENES
// Subida por URL (tu endpoint anterior, lo dejamos igual)
r.post('/:id/images', ctrl.addImage)

// Subida real a R2 (nuevo, campo 'file')
r.post('/:id/images/upload', uploadImageMem.single('file'), ctrl.uploadProductImageR2)

// 🔴 NUEVO: stream de imagen (proxy R2) — tiene que existir para GET
r.get('/:id/images/:file', ctrl.streamProductImage)

// Listar imágenes de un producto
r.get('/:id/images', ctrl.listProductImages)

// Marcar imagen como principal
r.put('/:id/images/:imageId/primary', ctrl.setPrimaryImage)

// Eliminar imagen (con borrado en R2 si aplica)
r.delete('/:id/images/:imageId', ctrl.deleteImage)

export default r
