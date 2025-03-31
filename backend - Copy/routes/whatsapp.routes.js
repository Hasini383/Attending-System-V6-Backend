import express from "express";
import {
  getWhatsAppStatus,
  getQRCode,
  refreshQRCode,
  sendMessage,
  handleBulkMessages,
  testWhatsAppMessage,
  logoutWhatsApp
} from "../controllers/messaging.controller.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Update route order to ensure QR endpoints are registered first
router.get("/qr", protect, getQRCode);
router.post("/qr/refresh", protect, refreshQRCode);
router.get("/status", protect, getWhatsAppStatus);
router.post("/send", protect, sendMessage);
router.post("/bulk", protect, handleBulkMessages);
router.post("/test", protect, testWhatsAppMessage);

// Add logout route
router.post("/logout", protect, logoutWhatsApp);

export default router;
