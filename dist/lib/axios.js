"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// lib/axios.ts
const axios_1 = __importDefault(require("axios"));
const instance = axios_1.default.create({
    baseURL: process.env.NEXT_PUBLIC_API_URL,
});
instance.interceptors.request.use((config) => {
    if (typeof window !== 'undefined') {
        const token = localStorage.getItem('token'); // ⚠️ puede estar vacío si se carga muy pronto
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
    }
    return config;
});
exports.default = instance;
