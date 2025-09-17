"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadImageMem = void 0;
// server/src/middleware/upload.ts
const multer_1 = __importDefault(require("multer"));
const storage = multer_1.default.memoryStorage();
exports.uploadImageMem = (0, multer_1.default)({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB
        files: 1,
    },
});
