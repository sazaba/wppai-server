// server/src/middleware/upload.ts
import multer from 'multer'

const storage = multer.memoryStorage()

export const uploadImageMem = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB
        files: 1,
    },
})
