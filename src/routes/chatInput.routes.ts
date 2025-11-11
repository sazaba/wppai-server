import { Router } from "express";
import { verificarJWT } from '../middleware/auth.middleware'
import {
    getChatInputState,
    getChatInputMeta,
    getChatInputStaff,
    getChatInputServices,
} from "../controllers/chatInput.controller";

const router = Router();

router.get("/chat-input/state/:conversationId", verificarJWT, getChatInputState);
router.get("/chat-input/meta/:conversationId", verificarJWT, getChatInputMeta);
router.get("/chat-input/staff", verificarJWT, getChatInputStaff);
router.get("/api/chat-input/services", verificarJWT, getChatInputServices);

export default router;
