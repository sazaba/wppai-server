import multer from 'multer'

const storage = multer.memoryStorage()

const fileFilter: multer.Options['fileFilter'] = (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif']
    if (ok.includes(file.mimetype)) return cb(null, true)
    cb(new Error('Tipo de archivo no permitido. Sube una imagen.'))
}

export const uploadImageMem = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter,
})
