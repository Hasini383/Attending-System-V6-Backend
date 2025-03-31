import express from 'express';
import rateLimit from 'express-rate-limit';
import { validateStudentInput } from '../middleware/validationMiddleware.js';
import { protect, restrictTo } from '../middleware/authMiddleware.js';
import {
  downloadQRCode,
  searchQRCode,
  markAttendance,
  getStudentProfile,
  updateStudentProfile,
  getAttendanceHistory,
  getDashboardStats
} from '../controllers/students.controller.js';

const router = express.Router();

const qrLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, 
  message: 'Too many QR code requests. Please try again later.'
});

const attendanceLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, 
  message: 'Too many attendance attempts. Please try again later.'
});

// Student registration and profile routes
router.get('/profile', protect, restrictTo('admin'), getStudentProfile);
router.patch('/profile', protect, restrictTo('admin'), validateStudentInput, updateStudentProfile);

// QR Code routes
router.get('/download-qr-code', qrLimiter, downloadQRCode);
router.get('/search-qr', qrLimiter, searchQRCode);

// Attendance routes
router.post('/mark-attendance', attendanceLimiter, markAttendance); 
router.get('/attendance-history', protect, restrictTo('admin'), getAttendanceHistory);
router.get('/dashboard-stats', protect, restrictTo('admin'), getDashboardStats);

export default router;
