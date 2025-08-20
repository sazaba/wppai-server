import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import * as ctrl from '../controllers/product.controller'

const r = Router()

// Protege todo el grupo de rutas:
r.use(verificarJWT)

r.post('/', ctrl.createProduct)
r.post('/:id/images', ctrl.addImage)
r.get('/', ctrl.listProducts)
r.get('/:id', ctrl.getProduct)
r.put('/:id', ctrl.updateProduct)
r.delete('/:id', ctrl.deleteProduct)
r.delete('/:id/images/:imageId', ctrl.deleteImage)

export default r
