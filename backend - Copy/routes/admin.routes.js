import express from 'express';
import multer from 'multer';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { protect } from '../middleware/authMiddleware.js';
import { validateAdminInput } from '../middleware/validationMiddleware.js';
import { validateStudentInput } from '../middleware/validationMiddleware.js';
import {
  registerAdmin,
  loginAdmin,
  getAdminDetails,
  getStudents,
  markStudentAttendance,
  updateStudent,
  deleteStudent,
  getScannedStudentsToday,
  getAllStudents,
  bulkImportStudents,
  getAttendanceReport,
  forgotPassword,
  resetPassword,
  updatePassword,
  updateProfile,
  registerStudent,
  getAttendanceByDate,
  generateStudentQRCode,
  getRecentAttendance,
  generateDailyReport,
  generateWeeklyReport,
  generateMonthlyReport,
  generateIndividualReport,
  getDailyReportPreview,
  getWeeklyReportPreview,
  getMonthlyReportPreview,
  getIndividualReportPreview,
  adminSendBulkMessages,
  logoutAdmin,
  clearStudentAttendanceHistory,
  deleteAttendanceRecord,
  getStudentAttendanceHistory
} from '../controllers/admin.controller.js';

import {
  getWhatsAppStatus,
  testWhatsAppMessage,
  sendMessage,
  sendQrCodeScanMessage
} from '../controllers/messaging.controller.js';

const router = express.Router();

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many login attempts. Please try again after 15 minutes.'
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: 'Too many requests. Please try again after 1 minute.'
});

// File storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const filetypes = /csv|xlsx|xls/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed!'));
    }
  } 
});
                            
// Authentication routes
router.post('/register', validateAdminInput, registerAdmin);
router.post('/login', loginLimiter, loginAdmin);
router.post('/logout', protect, logoutAdmin);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.post('/update-password', protect, updatePassword);
router.patch('/profile', protect, updateProfile);

// Admin routes
router.get('/me', protect, getAdminDetails);
router.get('/students', protect, getStudents);
router.get('/students/all', protect, getAllStudents);
router.get('/students/scanned-today', protect, getScannedStudentsToday);

// Attendance routes
router.get('/attendance/today', protect, getScannedStudentsToday);
router.get('/attendance/recent', protect, getRecentAttendance);
router.get('/attendance/report', protect, getAttendanceReport);
router.get('/attendance/:date', protect, getAttendanceByDate);
router.post('/attendance', protect, markStudentAttendance);

// Reports routes
router.get('/reports/daily/preview', protect, getDailyReportPreview);
router.get('/reports/weekly/preview', protect, getWeeklyReportPreview);
router.get('/reports/monthly/preview', protect, getMonthlyReportPreview);
router.get('/reports/individual/preview', protect, getIndividualReportPreview);

router.get('/reports/daily', protect, generateDailyReport);
router.get('/reports/weekly', protect, generateWeeklyReport);
router.get('/reports/monthly', protect, generateMonthlyReport);
router.get('/reports/individual', protect, generateIndividualReport);

// Student management
router.post('/students', protect, validateStudentInput, registerStudent);
router.put('/students/:id', protect, updateStudent);
router.delete('/students/:id', protect, deleteStudent);

// QR Code routes
router.get('/students/:id/qr-code', protect, (req, res) => generateStudentQRCode(req, res));

// Messaging routes
router.post('/messages', protect, apiLimiter, sendMessage);
router.post('/messages/bulk', protect, apiLimiter, adminSendBulkMessages);

// WhatsApp status and testing
router.get('/whatsapp/status', protect, getWhatsAppStatus);
router.post('/whatsapp/test', protect, apiLimiter, testWhatsAppMessage);

router.post(
  '/bulk-import',
  protect,
  upload.single('file'),
  (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        message: 'Please upload a file'
      });
    }
    next();
  },
  bulkImportStudents
);

// Student attendance history management
router.get('/students/:studentId/attendance', protect, getStudentAttendanceHistory);
router.delete('/students/:studentId/attendance/clear', protect, clearStudentAttendanceHistory);
router.delete('/students/:studentId/attendance/:recordId', protect, deleteAttendanceRecord);

export default router;
