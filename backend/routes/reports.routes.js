import express from 'express';
import rateLimit from 'express-rate-limit';
import { protect, restrictTo } from '../middleware/authMiddleware.js';
import {
  generateDailyAttendanceReport,
  generateStudentSummaryReport,
  generateMonthlyAnalysisReport,
  generateWeeklyAttendanceReport,
  generateIndividualStudentReport
} from '../controllers/report.controller.js';
import Student from '../models/student.model.js';
import { parseMongoDate } from '../utils/dateUtils.js';
import { 
  getDailyReportPreview, 
  getWeeklyReportPreview, 
  getMonthlyReportPreview, 
  getIndividualReportPreview 
} from '../controllers/admin.controller.js';

const router = express.Router();

const handleMongodbFormat = (req, res, next) => {
  req.preserveMongoFormat = req.headers['preserve-mongodb-format'] === 'true';
  req.timeFormat = req.headers['time-format'] || 'default';
  
  if (req.preserveMongoFormat && !req.query.preserveFormat) {
    req.query.preserveFormat = true;
  }
  
  if (req.timeFormat === 'preserve-null' && !req.query.handleTimestamps) {
    req.query.handleTimestamps = true;
  }
  
  next();
};

const reportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, 
  max: 20, 
  message: 'Too many report generation requests. Please try again later.'
});

// Daily report endpoints
router.get(
  '/dailyAttendanceReport',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  reportLimiter,
  generateDailyAttendanceReport
);

// Use the implementation from admin.controller.js with a wrapper to handle the date parameter
router.get(
  '/daily/preview',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  async (req, res) => {
    try {
      // Convert single date parameter to startDate and endDate parameters
      const { date } = req.query;
      
      if (!date) {
        return res.status(400).json({ 
          success: false, 
          message: 'Date is required',
          error: 'missing_date'
        });
      }
      
      // Set startDate and endDate to the same date for daily report
      req.query.startDate = date;
      req.query.endDate = date;
      
      // Call the original controller function
      await getDailyReportPreview(req, res);
    } catch (error) {
      console.error('Error in daily report preview wrapper:', error);
      res.status(500).json({
        success: false,
        message: 'Error generating preview',
        error: error.message
      });
    }
  }
);

// Weekly report endpoints
router.get(
  '/weeklyAttendanceReport',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  reportLimiter,
  generateWeeklyAttendanceReport
);

// Use the implementation from admin.controller.js
router.get(
  '/weekly/preview',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  getWeeklyReportPreview
);

// Monthly report endpoints
router.get(
  '/monthlyAttendanceReport',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  reportLimiter,
  generateMonthlyAnalysisReport
);

// Use the implementation from admin.controller.js
router.get(
  '/monthly/preview',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  getMonthlyReportPreview
);

// Individual student report endpoints
router.get(
  '/individualStudentReport',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  reportLimiter,
  generateIndividualStudentReport
);

// Use the implementation from admin.controller.js
router.get(
  '/individual/preview',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  getIndividualReportPreview
);

// Student summary report
router.get(
  '/summary',
  protect,
  restrictTo('admin'),
  handleMongodbFormat,
  reportLimiter,
  generateStudentSummaryReport
);

export default router;
