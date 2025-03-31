import Admin from '../models/admin.model.js';
import Student from '../models/student.model.js';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import csvParser from 'csv-parser';
import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';
import { 
  getClientState, 
  sendTextMessage, 
  sendAttendanceAlert, 
  sendBulkMessages 
} from '../services/whatsapp.service.js';
import { DateTime } from 'luxon';
import { generateStylishQRCode } from '../utils/qrGenerator.js';

// Load environment variables
dotenv.config();

// Create Attendance reference from Student model since there's no separate Attendance model
const Attendance = Student;

// Helper function to get date range
const getDateRange = (date = new Date()) => {
  const startOfDay = DateTime.fromJSDate(new Date(date)).startOf('day').toJSDate();
  const endOfDay = DateTime.fromJSDate(new Date(date)).endOf('day').toJSDate();
  return { startOfDay, endOfDay };
};

// Set up file upload storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Save files to 'uploads' folder
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Save file with a unique name
  }
});

const upload = multer({ storage: storage });

// Helper function to handle the CSV file parsing
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const students = [];
    const stream = fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (data) => {
        students.push(data); // Push each student row
      })
      .on('end', () => {
        resolve(students); // Return parsed student data
      })
      .on('error', (err) => {
        reject(err);
      });
  });
};

// Helper function to handle Excel file parsing
const parseExcel = (filePath) => {
  return new Promise((resolve, reject) => {
    try {
      const workbook = xlsx.readFile(filePath); // Read Excel file
      const sheet = workbook.Sheets[workbook.SheetNames[0]]; // Use the first sheet
      const students = xlsx.utils.sheet_to_json(sheet); // Convert sheet data to JSON
      resolve(students); // Return parsed student data
    } catch (err) {
      reject(err);
    }
  });
};

// Bulk import endpoint to upload CSV or Excel files
export const bulkImportStudents = async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = path.join(__dirname, '..', 'uploads', file.filename);
  let students = [];

  try {
    if (file.mimetype === 'text/csv') {
      students = await parseCSV(filePath); // Parse CSV
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      students = await parseExcel(filePath); // Parse Excel file
    } else {
      return res.status(400).json({ error: 'Invalid file format. Only CSV and Excel files are allowed.' });
    }

    // Validate student data (assuming students should have 'name' and 'studentId' fields)
    const invalidStudents = students.filter(student => !student.name || !student.studentId);
    if (invalidStudents.length > 0) {
      return res.status(400).json({
        error: 'Some student records are missing required fields (name/studentId).',
        invalidRecords: invalidStudents,
      });
    }

    // Save valid students to the database
    await Student.insertMany(students);

    res.status(200).json({
      message: `${students.length} students imported successfully!`,
      importedRecords: students,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error occurred while processing the file.' });
  } finally {
    // Optional: Delete the uploaded file after processing
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error('Error deleting file:', err);
      }
    });
  }
};

export const registerStudent = async (req, res) => {
  try {
    const { name, address, student_email, parent_email, parent_telephone, indexNumber, age } = req.body;

    // Validate the input
    if (!name || !address || !student_email || !parent_email || !parent_telephone || !indexNumber || !age) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Create a new student instance
    const newStudent = new Student({
      name,
      address,
      student_email,
      parent_email,
      parent_telephone,
      indexNumber,
      age
    });

    // Save the student to the database
    await newStudent.save()
      .then(async (savedStudent) => {
        // Generate a comprehensive QR code with complete student details
        const qrCodeData = JSON.stringify({
          id: savedStudent._id,
          name: savedStudent.name,
          indexNumber: savedStudent.indexNumber,
          email: savedStudent.student_email,
          address: savedStudent.address,
          age: savedStudent.age,
          timestamp: new Date().toISOString(),
          secureHash: crypto.createHash('sha256')
            .update(`${savedStudent._id}${savedStudent.indexNumber}${process.env.JWT_SECRET || 'qrattend-secret'}`)
            .digest('hex').substring(0, 16)
        });

        try {
          // Generate a stylish QR code with a dinosaur logo in the center
          const qrCode = await generateStylishQRCode(qrCodeData, {
            errorCorrectionLevel: 'H',
            margin: 1,
            color: {
              dark: '#000000',  // Black QR code
              light: '#FFFFFF'  // White background
            },
            width: 400
          });
          
          // Update the saved student with the QR code
          savedStudent.qrCode = qrCode;
          await savedStudent.save();

          // Respond with the student data and QR code URL
          res.status(201).json({
            message: 'Student registered successfully',
            student: {
              name: savedStudent.name,
              indexNumber: savedStudent.indexNumber,
              email: savedStudent.student_email,
              _id: savedStudent._id
            },
            qrCode
          });
        } catch (qrError) {
          console.error('Error generating QR code:', qrError);
          res.status(500).json({ message: 'Error generating QR code', error: qrError });
        }
      })
      .catch((err) => {
        console.error('Error saving student:', err);
        res.status(500).json({ message: 'Error saving student to database', error: err });
      });
  } catch (error) {
    console.error('Error registering student:', error);
    res.status(500).json({ message: 'Error registering student', error });
  }
};

export const registerAdmin = async (req, res) => {
  const { name, email, password, role } = req.body;

  // Validate input
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Please provide all required fields.' });
  }

  // Check if admin exists
  const existingAdmin = await Admin.findOne({ email });
  if (existingAdmin) {
    return res.status(400).json({ message: 'Admin already exists.' });
  }

  // Create a new admin instance
  const newAdmin = new Admin({
    name,
    email,
    password,
    role,
  });

  try {
    // Save the new admin
    await newAdmin.save();
    res.status(201).json({ message: 'Admin registered successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error registering admin.' });
  }
};

export const loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  // Validate input
  if (!email || !password) {
    return res.status(400).json({ message: 'Please provide both email and password.' });
  }

  try {
    // Find the admin by email and explicitly select the password field
    const admin = await Admin.findOne({ email }).select('+password');
    if (!admin) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Compare the password
    const isMatch = await admin.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Generate a JWT token
    const token = jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET, {
      expiresIn: '1h',  // The token will expire in 1 hour
    });

    // Handle successful login
    await admin.handleSuccessfulLogin();

    // Respond with the token and admin details (excluding password)
    res.status(200).json({
      message: 'Login successful',
      token,
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error logging in admin.' });
  }
};

export const logoutAdmin = async (req, res) => {
  try {
    // Get the token from the request
    const token = req.headers.authorization?.split(' ')[1];
    
    // In a real blacklist implementation, you would store this token in a 
    // blacklist database or Redis cache with an expiry time matching the token's TTL
    
    // For now, log the logout action
    console.log(`Admin logout: ${req.user?.name || 'Unknown user'} at ${new Date().toISOString()}`);
    
    return res.status(200).json({
      status: 'success',
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Error in logout:', error);
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred during logout',
      error: error.message
    });
  }
};

export const getAdminDetails = async (req, res) => {
  const adminId = req.admin.id; // assuming you attach the admin's id to the request in a middleware

  try {
    const admin = await Admin.findById(adminId).select('-password'); // Exclude password from response
    if (!admin) {
      return res.status(404).json({ message: 'Admin not found' });
    }

    res.status(200).json(admin);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching admin details.' });
  }
};

export const createStudent = async (req, res) => {
  const { name, indexNumber } = req.body;
  const newStudent = new Student({ name, indexNumber });

  try {
    await newStudent.save();
    res.status(201).json({ message: 'Student created successfully', student: newStudent });
  } catch (err) {
    res.status(500).json({ message: 'Error creating student', error: err });
  }
}

export const getStudents = async (req, res) => {
  try {
    const students = await Student.find();
    res.status(200).json({ students });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching students', error: err });
  }
};

export const updateStudent = async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;

  try {
    // Find the student first to get the current data
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Update the student with the new data
    const updatedStudent = await Student.findByIdAndUpdate(
      id, 
      updateData, 
      { new: true, runValidators: true }
    );
    
    res.status(200).json({ 
      message: 'Student updated successfully', 
      student: updatedStudent 
    });
  } catch (err) {
    console.error('Error updating student:', err);
    res.status(500).json({ message: 'Error updating student', error: err });
  }
};

export const deleteStudent = async (req, res) => {
  const { id } = req.params;

  try {
    const student = await Student.findByIdAndDelete(id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    res.status(200).json({ message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting student', error: err });
  }
};

export const getAllStudents = async (req, res) => {
  try {
    // Fetch all students
    const students = await Student.find();
    
    // Process each student to ensure lastAttendance is set correctly
    const processedStudents = await Promise.all(students.map(async (student) => {
      // Convert to plain object so we can modify it
      const studentObj = student.toObject();
      
      // If the student has attendance records but lastAttendance is not set
      if (studentObj.attendanceHistory && studentObj.attendanceHistory.length > 0 && !studentObj.lastAttendance) {
        // Find the most recent attendance record
        const sortedAttendance = [...studentObj.attendanceHistory].sort(
          (a, b) => DateTime.fromJSDate(b.date).ts - DateTime.fromJSDate(a.date).ts
        );
        
        // Set lastAttendance to the date of the most recent record
        if (sortedAttendance.length > 0) {
          // Update the student in the database
          await Student.findByIdAndUpdate(
            studentObj._id, 
            { lastAttendance: sortedAttendance[0].date }
          );
          
          // Update the object we're returning
          studentObj.lastAttendance = sortedAttendance[0].date;
        }
      }
      
      return studentObj;
    }));
    
    res.status(200).json({
      message: "All students fetched successfully.",
      students: processedStudents,
    });
  } catch (error) {
    console.error('Error fetching all students:', error);
    res.status(500).json({ message: 'Error fetching all students', error });
  }
};

export const getScannedStudentsToday = async (req, res) => {
  try {
    // Get today's date range (from start of day to current time)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    
    // Get all active students first
    const allStudents = await Student.find({ status: 'active' })
      .select('_id name firstName lastName indexNumber status email student_email parent_email parent_telephone class attendanceHistory')
      .sort('indexNumber')
      .lean();
    
    // Set today's date boundaries
    const endOfDay = new Date(today);
    endOfDay.setUTCHours(23, 59, 59, 999);
    
    // Create a map of student attendance
    const studentAttendanceMap = {};
    
    // Process each student's attendance history to find today's records
    allStudents.forEach(student => {
      const studentId = student._id.toString();
      
      // Filter attendance records for today
      const todayAttendance = (student.attendanceHistory || []).filter(record => {
        const recordDate = new Date(record.date);
        return recordDate >= today && recordDate <= endOfDay;
      });
      
      if (todayAttendance.length > 0) {
        // Sort by timestamp descending to get the latest record first
        todayAttendance.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Start with the latest record as the base
        studentAttendanceMap[studentId] = {
          status: todayAttendance[0].status,
          timestamp: todayAttendance[0].date
        };
        
        // Find entry and exit times from all of today's records
        todayAttendance.forEach(record => {
          // Track entry time (from 'entered' record or explicitly set entryTime)
          if (record.status === 'entered' || record.entryTime) {
            if (!studentAttendanceMap[studentId].entryTime) {
              studentAttendanceMap[studentId].entryTime = record.entryTime || record.date;
            }
          }
          
          // Track leave time (from 'left' record or explicitly set leaveTime)
          if (record.status === 'left' || record.leaveTime) {
            if (!studentAttendanceMap[studentId].leaveTime) {
              studentAttendanceMap[studentId].leaveTime = record.leaveTime || record.date;
            }
          }
        });
      }
    });
    
    // Process students with their attendance status
    const students = allStudents.map(student => {
      const studentId = student._id.toString();
      const attendance = studentAttendanceMap[studentId];
      
      if (!attendance) {
        // Student has no attendance record for today
      return {
          ...student,
          status: 'absent',
          entryTime: null,
          leaveTime: null
        };
      }
      
      return {
        ...student,
        status: attendance.status,
        entryTime: attendance.entryTime || attendance.timestamp,
        leaveTime: attendance.leaveTime
      };
    });

    // Calculate statistics
    const totalCount = students.length;
    const presentCount = students.filter(s => s.status === 'entered').length;
    const leftCount = students.filter(s => s.status === 'left').length;
    const absentCount = students.filter(s => s.status === 'absent').length;

    res.status(200).json({
      status: 'success',
      message: 'Today\'s attendance data retrieved successfully',
      students,
      totalCount,
      presentCount,
      leftCount,
      absentCount
    });
  } catch (error) {
    console.error('Error in getScannedStudentsToday:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to retrieve today\'s attendance data',
      error: error.message 
    });
  }
};

export const getAttendanceReport = async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ message: 'Date parameter is required' });
    }

    const { startOfDay, endOfDay } = getDateRange(new Date(date));

    try {
      // Get all students first
      const allStudents = await Student.find().lean();
      
      // Get attendance records for the specified date
      const attendanceRecords = await Student.aggregate([
        {
          $unwind: {
            path: "$attendanceHistory",
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $match: {
            "attendanceHistory.date": {
              $gte: startOfDay,
              $lt: endOfDay
            }
          }
        },
        {
          $group: {
            _id: "$_id",
            name: { $first: "$name" },
            indexNumber: { $first: "$indexNumber" },
            student_email: { $first: "$student_email" },
            records: { $push: "$attendanceHistory" }
          }
        }
      ]);

      // Create a map of students who have attendance records
      const attendanceMap = new Map(attendanceRecords.map(record => [record._id.toString(), record]));

      // Process all students to include both present and absent
      const processedStudents = allStudents.map(student => {
        const attendance = attendanceMap.get(student._id.toString());
        
        if (attendance) {
          // Student has attendance records for this day
          const records = attendance.records || [];
          const entryRecord = records.find(r => r.status === 'entered' || r.status === 'present');
          const leaveRecord = records.find(r => r.status === 'left');
          const lateRecord = records.find(r => r.status === 'late');

          return {
            ...student,
            attendanceHistory: [{
              status: lateRecord ? 'late' : (entryRecord ? 'present' : 'absent'),
              date: startOfDay,
              entryTime: entryRecord?.timestamp || null,
              leaveTime: leaveRecord?.timestamp || null
            }]
          };
        } else {
          // Student was absent
          return {
            ...student,
            attendanceHistory: [{
              status: 'absent',
              date: startOfDay,
              entryTime: null,
              leaveTime: null
            }]
          };
        }
      });

      // Create Excel report
      const excelBuffer = await createExcelReport(processedStudents, 'daily');

      // Set response headers
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_report_${date}.xlsx`);
      
      return res.send(excelBuffer);
    } catch (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({ 
        message: 'Error fetching student data', 
        error: dbError.message 
      });
    }
  } catch (error) {
    console.error('Error generating attendance report:', error);
    return res.status(500).json({ 
      message: 'Error generating attendance report', 
      error: error.message 
    });
  }
};

// Helper function to format time like in Dashboard
const formatTime = (time) => {
  if (!time) return 'N/A';
  
  try {
    // Try parsing as Date object first
    if (time instanceof Date) {
      return DateTime.fromJSDate(time)
        .setZone('Asia/Colombo')
        .toLocaleString(DateTime.TIME_WITH_SECONDS);
    }
    
    // Then try as ISO string
    const parsedTime = DateTime.fromISO(time);
    if (parsedTime.isValid) {
      return parsedTime.setZone('Asia/Colombo').toLocaleString(DateTime.TIME_WITH_SECONDS);
    }
    
    // Last resort, try as JS Date constructor
    return DateTime.fromJSDate(new Date(time))
      .setZone('Asia/Colombo')
      .toLocaleString(DateTime.TIME_WITH_SECONDS);
  } catch (e) {
    console.warn(`Invalid time format: ${time}`);
    return 'N/A';
  }
};

// Helper function to normalize status
const normalizeStatus = (status) => {
  if (!status) return 'Unknown';
  
  const statusLower = status.toLowerCase();
  
  if (statusLower === 'entered') return 'Present';
  if (statusLower === 'present') return 'Present';
  if (statusLower === 'left') return 'Left';
  if (statusLower === 'late') return 'Late';
  if (statusLower === 'absent') return 'Absent';
  
  return status.charAt(0).toUpperCase() + status.slice(1);
};

// Helper function to create Excel report
const createExcelReport = (data, reportType) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Attendance Report', {
    properties: {
      tabColor: { argb: '1E88E5' },
      defaultRowHeight: 25,
      defaultColWidth: 15
    }
  });

  // Add title
  const titleRow = worksheet.addRow(['Attendance Report']);
  titleRow.font = { bold: true, size: 16 };
  titleRow.alignment = { horizontal: 'center' };
  worksheet.mergeCells('A1:G1');

  // Add date range
  const dateRangeRow = worksheet.addRow([`Generated on: ${DateTime.now().setZone('Asia/Colombo').toLocaleString(DateTime.DATETIME_FULL)}`]);
  dateRangeRow.font = { italic: true };
  dateRangeRow.alignment = { horizontal: 'center' };
  worksheet.mergeCells('A2:G2');

  // Add headers based on report type
  let headers;
  switch (reportType) {
    case 'daily':
      headers = ['Student Name', 'Index Number', 'Email', 'Status', 'Entry Time', 'Leave Time', 'Duration'];
      break;
    case 'weekly':
      headers = ['Student Name', 'Index Number', 'Email', 'Week', 'Days Present', 'Days Absent', 'Attendance Rate'];
      break;
    case 'monthly':
      headers = ['Student Name', 'Index Number', 'Email', 'Month', 'Attendance Rate', 'Average Duration', 'Late Days'];
      break;
    case 'individual':
      headers = ['Date', 'Status', 'Entry Time', 'Leave Time', 'Duration'];
      break;
    default:
      headers = ['Student Name', 'Index Number', 'Email', 'Status', 'Entry Time', 'Leave Time', 'Duration'];
  }

  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
    fgColor: { argb: '1E88E5' }
  };
  headerRow.font = { color: { argb: 'FFFFFF' } };

  // Add data rows if we have data
  if (data && data.length > 0) {
    data.forEach((row, index) => {
      // Process student data similar to DashboardPage
      // Normalize email
      const studentEmail = row.student_email || 
                          row.email || 
                          (row.attendanceHistory && row.attendanceHistory[0]?.student?.student_email) ||
                          (row.attendanceHistory && row.attendanceHistory[0]?.student?.email) ||
                          (row.attendanceHistory && row.attendanceHistory[0]?.email) || 
                          'N/A';
      
      // Format times
      const formattedEntryTime = formatTime(row.entryTime);
      const formattedLeaveTime = formatTime(row.leaveTime);
      
      // Calculate duration
      let duration = 'N/A';
      if (row.entryTime && row.leaveTime) {
        try {
          const entryTime = row.entryTime instanceof Date 
            ? row.entryTime 
            : new Date(row.entryTime);
            
          const leaveTime = row.leaveTime instanceof Date 
            ? row.leaveTime 
            : new Date(row.leaveTime);
          
          if (!isNaN(entryTime.getTime()) && !isNaN(leaveTime.getTime())) {
            const durationMs = leaveTime.getTime() - entryTime.getTime();
            if (durationMs > 0) {
              const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
              const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
              
              duration = `${durationHours}h ${durationMinutes}m`;
            }
          }
        } catch (e) {
          console.warn('Error calculating duration');
        }
      }
      
      // Normalize status 
      const displayStatus = normalizeStatus(row.status);
      
      // Create row data based on headers
      const rowData = headers.map(header => {
        switch (header) {
          case 'Student Name':
            const name = row.name || 
                        (row.firstName && row.lastName ? `${row.firstName} ${row.lastName}` : null) || 
                        row.firstName || 
                        'N/A';
            return name;
          case 'Index Number':
            return (row.indexNumber || 'N/A').toUpperCase();
          case 'Email':
            return studentEmail;
          case 'Date':
            if (row.date) {
              if (row.date instanceof Date) {
                return DateTime.fromJSDate(row.date).setZone('Asia/Colombo').toFormat('MMM d, yyyy');
              } 
              return DateTime.fromISO(row.date).setZone('Asia/Colombo').toFormat('MMM d, yyyy');
            }
            return 'N/A';
          case 'Status':
            return displayStatus;
          case 'Entry Time':
            return formattedEntryTime;
          case 'Leave Time':
            return formattedLeaveTime;
          case 'Duration':
            return duration;
          case 'Week':
            return row.week || 'N/A';
          case 'Month':
            return row.month || 'N/A';
          case 'Days Present':
            return row.daysPresent || 0;
          case 'Days Absent':
            return row.daysAbsent || 0;
          case 'Attendance Rate':
            return typeof row.attendanceRate === 'number' ? `${row.attendanceRate.toFixed(1)}%` : 'N/A';
          case 'Average Duration':
            return row.averageDuration || 'N/A';
          case 'Late Days': 
            return row.lateDays || 0;
          default:
            return row[header] || 'N/A';
        }
      });

      const dataRow = worksheet.addRow(rowData);
      
      // Add alternating row colors
      if (index % 2 === 0) {
        dataRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'F8F9FA' }
        };
      }

      // Format cells based on column type
      headers.forEach((header, colIndex) => {
        const cell = dataRow.getCell(colIndex + 1);
        
        // Format status cells with colors
        if (header === 'Status' && cell.value) {
          const status = String(cell.value).toLowerCase();
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
            fgColor: {
              argb: status.includes('present') ? 'E8F5E9' :
                    status.includes('absent') ? 'FFEBEE' :
                    status.includes('late') ? 'FFF3E0' :
                    status.includes('left') ? 'E3F2FD' :
                    'F5F5F5'
            }
          };
        }
      });
    });

    // Add summary section
    worksheet.addRow([]);
    worksheet.addRow(['Summary']);
    
    const totalRecords = data.length;
    
    // Count statuses like in DashboardPage
    const presentCount = data.filter(row => 
      (row.status?.toLowerCase() === 'present' || row.status?.toLowerCase() === 'entered')
    ).length;
    
    const leftCount = data.filter(row => 
      row.status?.toLowerCase() === 'left'
    ).length;
    
    const absentCount = data.filter(row => 
      row.status?.toLowerCase() === 'absent'
    ).length;
    
    const lateCount = data.filter(row => 
      row.status?.toLowerCase() === 'late'
    ).length;

    worksheet.addRow(['Total Records', totalRecords]);
    worksheet.addRow(['Present', presentCount]);
    worksheet.addRow(['Left', leftCount]);
    worksheet.addRow(['Absent', absentCount]);
    worksheet.addRow(['Late', lateCount]);
      } else {
    // Add a message when no data is available
    worksheet.addRow(['No attendance records found for the specified period']);
    worksheet.mergeCells('A4:G4');
  }

  // Set column widths
  worksheet.columns.forEach(column => {
    column.width = 20; // Wider columns for better readability
  });

  // Add borders to all cells
  worksheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
    cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
      
    cell.alignment = {
      vertical: 'middle',
        horizontal: cell.value === 'N/A' ? 'center' : 'left',
        wrapText: true
      };
    });
  });

  return workbook.xlsx.writeBuffer();
};
export const markStudentAttendance = async (req, res) => {
  try {
    const { studentId, status, date, adminNote, scanLocation, deviceInfo, sendNotification } = req.body;

    if (!studentId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID is required'
      });
    }

    // Find the student
    const student = await Student.findById(studentId);
    
    if (!student) {
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }

    // Valid status values
    const validStatus = ['entered', 'left', 'present', 'absent'];
    
    if (!validStatus.includes(status)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Must be one of: entered, left, present, absent'
      });
    }

    // Mark attendance with the provided status
    await student.markAttendance(
      status, 
      req.user?._id || null, 
      deviceInfo || 'Manual entry by admin',
      scanLocation || 'Admin Portal'
    );

    // If notification is requested, send WhatsApp message
    if (sendNotification !== false && student.parent_telephone) {
      try {
        // Include additional info
        const attendanceData = {
          id: student._id,
          name: student.name,
          indexNumber: student.indexNumber,
          status,
          timestamp: new Date(),
          entryTime: new Date(),
          student_email: student.student_email,
          parent_telephone: student.parent_telephone,
          parent_email: student.parent_email,
          address: student.address
        };

        // Use the messaging service to send notification
        await sendAttendanceNotification(student._id, status, new Date(), adminNote);
        
        console.log(`WhatsApp notification sent to ${student.parent_telephone}`);
      } catch (notificationError) {
        console.error('Error sending WhatsApp notification:', notificationError);
        // Continue even if notification fails
      }
    }

    return res.status(200).json({
      status: 'success',
      message: `Student ${status === 'entered' ? 'checked in' : status === 'left' ? 'checked out' : 'marked as ' + status} successfully`,
      data: {
      student: {
        id: student._id,
        name: student.name,
        indexNumber: student.indexNumber,
          status: student.status,
          lastAttendance: student.lastAttendance
        }
      }
    });
  } catch (error) {
    console.error('Error marking student attendance:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to mark attendance',
      error: error.message
    });
  }
};

// Auto checkout settings defaults
let autoCheckoutSettings = {
  enabled: false,
  time: '18:30',
  sendNotification: true,
  lastRun: null
};

// Configure auto checkout settings
export const configureAutoCheckout = async (req, res) => {
  try {
    const { enabled, time, sendNotification } = req.body;
    
    // Validate time format (HH:MM)
    if (time && !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
        return res.status(400).json({ 
        status: 'error',
        message: 'Invalid time format. Must be in HH:MM format (24-hour)'
      });
    }
    
    // Update settings
    autoCheckoutSettings = {
      ...autoCheckoutSettings,
      enabled: enabled !== undefined ? enabled : autoCheckoutSettings.enabled,
      time: time || autoCheckoutSettings.time,
      sendNotification: sendNotification !== undefined ? sendNotification : autoCheckoutSettings.sendNotification
    };
    
    return res.status(200).json({
      status: 'success',
      message: 'Auto checkout settings updated successfully',
      data: autoCheckoutSettings
    });
  } catch (error) {
    console.error('Error configuring auto checkout:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to configure auto checkout',
      error: error.message
    });
  }
};

// Get auto checkout settings
export const getAutoCheckoutSettings = async (req, res) => {
  try {
    return res.status(200).json({
      status: 'success',
      data: autoCheckoutSettings
    });
  } catch (error) {
    console.error('Error getting auto checkout settings:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get auto checkout settings',
      error: error.message
    });
  }
};

// Run auto checkout for all students who haven't checked out
export const runAutoCheckout = async (req, res) => {
  try {
    // Get current date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get all students who checked in today but didn't check out
    const students = await Student.find({
      'attendanceHistory.date': {
        $gte: today
      },
      'attendanceHistory.status': 'entered',
      'attendanceHistory.leaveTime': null
    });
    
    console.log(`Found ${students.length} students who need auto checkout`);
    
    let processed = 0;
    let failed = 0;
    
    // Process each student
    for (const student of students) {
      try {
        // Find today's attendance record
        const todayRecord = student.attendanceHistory.find(record => {
          const recordDate = new Date(record.date);
          recordDate.setHours(0, 0, 0, 0);
          return recordDate.getTime() === today.getTime() && 
                 record.status === 'entered' && 
                 !record.leaveTime;
        });
        
        if (todayRecord) {
          // Mark the student as left
          await student.markAttendance(
            'left',
            req.user?._id || null,
            'Auto checkout system',
            'Auto Checkout'
          );
          
          // Send notification if enabled
          if (autoCheckoutSettings.sendNotification && student.parent_telephone) {
            try {
              await sendAttendanceNotification(
                student._id, 
                'left', 
                new Date(),
                'Automatically checked out by system at end of day'
              );
            } catch (notificationError) {
              console.error(`Error sending auto checkout notification to ${student.name}:`, notificationError);
            }
          }
          
          processed++;
        }
      } catch (studentError) {
        console.error(`Error processing auto checkout for student ${student.name}:`, studentError);
        failed++;
      }
    }
    
    // Update last run timestamp
    autoCheckoutSettings.lastRun = new Date();
    
    return res.status(200).json({
      status: 'success',
      message: `Auto checkout completed: ${processed} students processed, ${failed} failed`,
      data: {
        processed,
        failed,
        timestamp: new Date()
      }
    });
  } catch (error) {
    console.error('Error running auto checkout:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to run auto checkout',
      error: error.message
    });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Email is required'
      });
    }
    
    console.log(`Processing password reset request for email: ${email}`);
    
    const admin = await Admin.findOne({ email });

    if (!admin) {
      // Don't reveal if the user exists or not for security reasons
      console.log(`Password reset requested for non-existent email: ${email}`);
      return res.status(200).json({ 
        status: 'success',
        message: 'If a user with that email exists, a password reset link has been sent.'
      });
    }

    const resetToken = admin.createPasswordResetToken();
    await admin.save();

    // URL that would be sent in the email
    const resetURL = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;
    
    console.log(`Password reset token generated for admin: ${admin.name}`);
    console.log(`Reset URL (for development): ${resetURL}`);

    // In a real application, you would send this token via email
    // For development purposes, we're returning it directly
    // Example email sending code is commented out below:
    
    /*
    await sendEmail({
      email: admin.email,
      subject: 'Your password reset token (valid for 10 min)',
      message: `Forgot your password? Submit a request with your new password to: ${resetURL}.\nIf you didn't forget your password, please ignore this email!`
    });
    */

    res.status(200).json({
      status: 'success',
      message: 'If a user with that email exists, a password reset link has been sent.',
      // Only include the token in development mode
      ...(process.env.NODE_ENV === 'development' && { 
        resetToken,
        resetURL
      })
    });
  } catch (error) {
    console.error('Error in forgot password:', error);
    
    // If there was an error, reset the token fields
    if (req.body.email) {
      try {
        const admin = await Admin.findOne({ email: req.body.email });
        if (admin) {
          admin.passwordResetToken = undefined;
          admin.passwordResetExpires = undefined;
          await admin.save();
        }
      } catch (err) {
        console.error('Error cleaning up reset token after failure:', err);
      }
    }
    
    res.status(500).json({ 
      status: 'error',
      message: 'Error processing forgot password request. Please try again later.',
      ...(process.env.NODE_ENV === 'development' && { error: error.message })
    });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    
    if (!token) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Reset token is required' 
      });
    }
    
    if (!password) {
      return res.status(400).json({ 
        status: 'error',
        message: 'New password is required' 
      });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Password must be at least 8 characters long' 
      });
    }

    console.log(`Processing password reset with token: ${token.substring(0, 8)}...`);

    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const admin = await Admin.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() }
    });

    if (!admin) {
      console.log(`Invalid or expired reset token: ${token.substring(0, 8)}...`);
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid or expired reset token' 
      });
    }

    admin.password = password;
    admin.passwordResetToken = undefined;
    admin.passwordResetExpires = undefined;
    await admin.save();

    console.log(`Password reset successful for admin: ${admin.name}`);

    res.status(200).json({ 
      status: 'success',
      message: 'Password reset successful. You can now log in with your new password.' 
    });
  } catch (error) {
    console.error('Error in reset password:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Error resetting password. Please try again later.',
      ...(process.env.NODE_ENV === 'development' && { error: error.message })
    });
  }
};

export const updatePassword = async (req, res) => {
  try {
    if (!req.admin || !req.admin._id) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    const { currentPassword, newPassword } = req.body;
    const admin = await Admin.findById(req.admin._id).select('+password');

    if (!admin) {
      return res.status(404).json({ message: 'Admin not found' });
    }

    const isMatch = await admin.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    admin.password = newPassword;
    await admin.save();

    res.status(200).json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({ message: 'Error updating password', error });
  }
};

export const updateProfile = async (req, res) => {
  try {
    if (!req.admin || !req.admin._id) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    const { name, email } = req.body;
    const admin = await Admin.findById(req.admin._id);

    if (!admin) {
      return res.status(404).json({ message: 'Admin not found' });
    }

    admin.name = name || admin.name;
    admin.email = email || admin.email;

    await admin.save();

    res.status(200).json({
      message: 'Profile updated successfully',
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: 'Error updating profile', error });
  }
};

export const getAttendanceByDate = async (req, res) => {
  try {
    // Get date from params, expecting YYYY-MM-DD format
    const { date } = req.params;
    
    if (!date) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Date parameter is required in YYYY-MM-DD format' 
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid date format. Please use YYYY-MM-DD format' 
      });
    }

    const { startOfDay, endOfDay } = getDateRange(date);
    logInfo(`Fetching attendance records for date: ${date}`);

    const students = await Student.find({
      "attendanceHistory": {
        $elemMatch: {
          date: {
            $gte: startOfDay,
            $lt: endOfDay
          }
        }
      }
    }).select('name indexNumber student_email attendanceHistory');

    if (!students || students.length === 0) {
      logInfo(`No attendance records found for date: ${date}`);
      return res.status(200).json({
        status: 'success',
        message: "No attendance records found for the specified date",
        data: {
          students: [],
          stats: {
            totalCount: 0,
            presentCount: 0,
            absentCount: 0,
            lateCount: 0
          }
        }
      });
    }

    const processedStudents = students.map(student => {
      const dateAttendance = student.attendanceHistory.find(record => {
        const recordDate = DateTime.fromJSDate(record.date);
        const targetDate = DateTime.fromJSDate(startOfDay);
        return recordDate.hasSame(targetDate, 'day');
      });

      return {
        id: student._id,
        name: student.name,
        indexNumber: student.indexNumber.toUpperCase(), // Ensure uppercase as per memory
        email: student.student_email,
        status: dateAttendance?.status || 'absent',
        entryTime: dateAttendance?.entryTime || null,
        leaveTime: dateAttendance?.leaveTime || null
      };
    });

    const stats = processedStudents.reduce((acc, student) => {
      acc.totalCount++;
      switch(student.status) {
        case 'present':
          acc.presentCount++;
          break;
        case 'late':
          acc.lateCount++;
          break;
        case 'absent':
          acc.absentCount++;
          break;
      }
      return acc;
    }, { totalCount: 0, presentCount: 0, absentCount: 0, lateCount: 0 });

    logSuccess(`Successfully fetched ${stats.totalCount} attendance records for date: ${date}`);
    res.status(200).json({
      status: 'success',
      message: "Attendance records fetched successfully",
      data: {
        students: processedStudents,
        stats
      }
    });

  } catch (error) {
    logError(`Error fetching attendance by date: ${error.message}`);
    res.status(500).json({ 
      status: 'error',
      message: 'Error fetching attendance records',
      error: error.message 
    });
  }
};
// Send a message to a student via WhatsApp
export const sendMessageToStudent = async (req, res) => {
  try {
    const { studentId, message, phoneNumber } = req.body;
    
    // Check WhatsApp client status
    const clientState = getClientState();
    if (!clientState.isReady) {
      return res.status(503).json({
        success: false,
        message: 'WhatsApp service not ready',
        error: clientState.error || 'Please scan the QR code to connect WhatsApp'
      });
    }
    
    if (!studentId && !phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either studentId or phoneNumber is required' 
      });
    }
    
    let student = null;
    let recipient = phoneNumber;
    
    // If studentId is provided, get student data
    if (studentId) {
      student = await Student.findById(studentId);
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found' });
      }
      
      // Use student's parent phone number if no specific phone is provided
      if (!phoneNumber && student.parent_telephone) {
        recipient = student.parent_telephone;
      }
    }
    
    if (!recipient) {
      return res.status(400).json({ 
        success: false, 
        message: 'No recipient phone number available' 
      });
    }

    // Send the message using sendTextMessage
    const result = await sendTextMessage(recipient, message);
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to send WhatsApp message',
        error: result.error
      });
    }

    // If we have a student, record the message
    if (student) {
      student.messages = student.messages || [];
      student.messages.push({
        content: message,
        sentAt: new Date(),
        type: 'manual',
        status: 'sent',
        messageId: result.messageId,
        recipient: recipient,
        sentBy: req.admin ? req.admin._id : null
      });
      await student.save();
    }

    return res.status(200).json({
      success: true,
      message: 'WhatsApp message sent successfully',
      messageId: result.messageId,
      recipient: recipient,
      student: student ? {
        _id: student._id,
        name: student.name,
        indexNumber: student.indexNumber
      } : null
    });
  } catch (error) {
    console.error('WhatsApp Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send WhatsApp message',
      error: error.message
    });
  }
};
// Send bulk messages to multiple students
export const adminSendBulkMessages = async (req, res) => {
  try {
    // Check WhatsApp client status first
    const clientState = getClientState();
    if (!clientState.isReady) {
      return res.status(503).json({
        success: false,
        message: 'WhatsApp service not ready',
        error: clientState.error || 'Please scan the QR code to connect WhatsApp'
      });
    }
    
    const { studentIds, message } = req.body;
    
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'At least one student ID is required' 
      });
    }
    
    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message content is required'
      });
    }
    
    // Find all selected students
    const selectedStudents = await Student.find({ _id: { $in: studentIds } });
    
    if (!selectedStudents || selectedStudents.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No students found with the provided IDs'
      });
    }
    
    // Get list of phone numbers
    const phoneNumbers = selectedStudents
      .filter(student => student.parent_telephone)
      .map(student => student.parent_telephone);

    if (phoneNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid phone numbers found for the selected students'
      });
    }

    // Send bulk messages
    const result = await sendBulkMessages(phoneNumbers, message);
    
    // Record messages for successful sends
    for (const student of selectedStudents) {
      if (student.parent_telephone) {
        const successfulSend = result.results.successful.find(
          s => s.phone === student.parent_telephone
        );
        
        if (successfulSend) {
          student.messages = student.messages || [];
          student.messages.push({
            content: message,
            sentAt: new Date(),
            type: 'notification', // Changed from 'bulk' to 'notification'
            status: 'sent',
            messageId: successfulSend.messageId,
            recipient: student.parent_telephone,
            sentBy: req.admin ? req.admin._id : null
          });
          await student.save();
        }
      }
    }
    
    return res.status(200).json({
      success: true,
      message: 'Bulk messages sent successfully',
      summary: result.summary,
      results: result.results
    });
  } catch (error) {
    console.error('Error sending bulk messages:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send bulk messages',
      error: error.message
    });
  }
};
// Send an attendance notification to a student's parent
export const sendAttendanceNotification = async (studentId, status, timestamp) => {
  try {
    // Check WhatsApp client status
    const clientState = getClientState();
    if (!clientState.isReady) {
      console.log('WhatsApp service not ready');
      return { 
        success: false, 
        error: 'WhatsApp service not ready',
        code: 'CLIENT_NOT_READY'
      };
    }
    
    // Find student by ID
    const student = await Student.findById(studentId);
    if (!student) {
      console.log(`Student not found with ID: ${studentId}`);
      return { 
        success: false, 
        error: 'Student not found',
        code: 'STUDENT_NOT_FOUND' 
      };
    }
    
    // Check if parent phone number exists
    if (!student.parent_telephone) {
      console.log(`No parent phone number available for student: ${student.name} (${student.indexNumber})`);
      return { 
        success: false, 
        error: 'No parent phone number available',
        code: 'NO_PHONE_NUMBER' 
      };
    }
    
    // Format status for display
    const displayStatus = status === 'entered' ? 'Entered School' : 
                         status === 'left' ? 'Left School' : 
                         status.charAt(0).toUpperCase() + status.slice(1);
    
    // Get current time if timestamp not provided
    const scanTime = timestamp || new Date();
    
    // Create student data object for WhatsApp message
    const studentData = {
      name: student.name,
      indexNumber: student.indexNumber,
      student_email: student.student_email,
      address: student.address,
      parent_telephone: student.parent_telephone,
      status: status,
      timestamp: scanTime
    };
    
    // Clean phone number
    const phoneNumber = student.parent_telephone.replace(/\s+/g, '');
    
    // Send WhatsApp message
    console.log(`Sending attendance notification to ${phoneNumber} for ${student.name}'s attendance (${displayStatus})`);
    
    // Send WhatsApp message with student data
    const result = await sendAttendanceAlert(
      phoneNumber,
      studentData,
      status,
      scanTime
    );
    
    // Log result for debugging
    if (result.success) {
      console.log(`WhatsApp notification sent successfully to ${phoneNumber} for ${student.name}'s attendance`);
    } else {
      console.error(`Failed to send WhatsApp notification to ${phoneNumber}:`, result.error || 'Unknown error');
    }
    
    return result;
  } catch (error) {
    console.error('Error sending attendance notification:', error);
    return { 
      success: false, 
      error: error.message,
      code: 'NOTIFICATION_ERROR'
    };
  }
};

/**
 * Generate a stylish QR code for a student with pixel art dinosaur logo
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const generateStudentQRCode = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find student by ID
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    // Generate QR code data with secure hash
    const qrCodeData = JSON.stringify({
      id: student._id,
      name: student.name,
      indexNumber: student.indexNumber,
      email: student.student_email,
      timestamp: new Date().toISOString(),
      secureHash: crypto.createHash('sha256')
        .update(`${student._id}${student.indexNumber}${process.env.JWT_SECRET || 'qrattend-secret'}`)
        .digest('hex').substring(0, 16)
    });
    
    // Generate stylish QR code with dinosaur logo
    const qrCode = await generateStylishQRCode(qrCodeData, {
      errorCorrectionLevel: 'H',
      margin: 1,
      color: {
        dark: '#000000',  // Black QR code
        light: '#FFFFFF'  // White background
      },
      width: 400
    });
    
    // Convert base64 data URL to buffer
    const base64Data = qrCode.replace(/^data:image\/png;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Set appropriate headers and send QR code image
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="qrcode-${student.indexNumber}.png"`);
    return res.send(imageBuffer);
  } catch (error) {
    console.error('Error generating student QR code:', error);
    return res.status(500).json({ message: 'Failed to generate QR code', error: error.message });
  }
};

// Utility functions for logging
const logInfo = (message) => {
  console.log(`INFO: ${message}`);
};

const logSuccess = (message) => {
  console.log(`SUCCESS: ${message}`);
};

const logError = (message) => {
  console.error(`ERROR: ${message}`);
};

// Get most recent attendance entries
export const getRecentAttendance = async (req, res) => {
  try {
    // Get today's date range in Sri Lanka timezone
    const now = DateTime.now().setZone('Asia/Colombo');
    const startOfDay = now.startOf('day').toJSDate();
    const endOfDay = now.endOf('day').toJSDate();

    console.log('Fetching attendance for:', {
      startOfDay,
      endOfDay,
      currentTime: now.toJSDate()
    });

    // Find students with attendance records for today
    const students = await Student.find({
      "attendanceHistory": {
        $elemMatch: {
          date: {
            $gte: startOfDay,
            $lte: endOfDay
          }
        }
      }
    })
    .select('name indexNumber student_email attendanceHistory status messages')
    .lean();

    // Process attendance records
    const processedRecords = students.map(student => {
      // Find today's attendance records
      const todayRecords = student.attendanceHistory.filter(record => {
        const recordDate = new Date(record.date);
        return recordDate >= startOfDay && recordDate <= endOfDay;
      });

      // Get the most recent record
      const latestRecord = todayRecords.length > 0 
        ? todayRecords.reduce((latest, current) => {
            return new Date(current.date) > new Date(latest.date) ? current : latest;
          })
        : null;

      // Format the record for display
      return {
        _id: student._id,
        name: student.name,
        indexNumber: student.indexNumber,
        email: student.student_email,
        status: latestRecord?.status || 'absent',
        entryTime: latestRecord?.entryTime || null,
        leaveTime: latestRecord?.leaveTime || null,
        timestamp: latestRecord?.date || null,
        // Include message status if available
        messageStatus: student.messages?.length > 0 
          ? student.messages[student.messages.length - 1].status 
          : null
      };
    });

    // Sort by most recent activity
    const sortedRecords = processedRecords.sort((a, b) => {
      const timeA = a.timestamp || new Date(0);
      const timeB = b.timestamp || new Date(0);
      return new Date(timeB) - new Date(timeA);
    });

    // Calculate statistics
    const stats = {
      totalCount: processedRecords.length,
      presentCount: processedRecords.filter(r => r.status === 'entered' || r.status === 'present').length,
      absentCount: processedRecords.filter(r => r.status === 'absent').length,
      leftCount: processedRecords.filter(r => r.status === 'left').length
    };

    // Check if we have any attendance records for today
    if (sortedRecords.length === 0) {
      return res.status(200).json({
        status: 'success',
        message: 'No attendance records for today',
        students: [],
        stats: {
          totalCount: 0,
          presentCount: 0,
          absentCount: 0,
          leftCount: 0
        },
        timestamp: now.toJSDate()
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Recent attendance records retrieved successfully',
      students: sortedRecords,
      stats,
      timestamp: now.toJSDate()
    });
  } catch (error) {
    console.error('Error in getRecentAttendance:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve recent attendance records',
      error: error.message
    });
  }
};

// Report generation functions
export const generateDailyReport = async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Date parameter is required' 
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid date format. Please use YYYY-MM-DD format' 
      });
    }

    // Convert date to Date object and timezone
    const targetDate = DateTime.fromISO(date).setZone('Asia/Colombo').startOf('day').toJSDate();
    const endOfDay = DateTime.fromISO(date).setZone('Asia/Colombo').endOf('day').toJSDate();

    console.log(`Generating daily report for ${date} from ${targetDate} to ${endOfDay}`);

    // Get all students with their attendance history
    const students = await Student.find().lean();
    
    // Process student records similar to DashboardPage
    const processedStudents = students.map(student => {
      // Find attendance record for the specific date
      const dateAttendance = student.attendanceHistory?.find(record => {
        if (!record || !record.date) return false;
        
        // Parse the record date
        let recordDate;
        try {
          recordDate = new Date(record.date);
          if (isNaN(recordDate.getTime())) return false;
        } catch (e) {
          return false;
        }
        
        return recordDate >= targetDate && recordDate <= endOfDay;
      });

      // Parse times safely like in Dashboard
      let entryTimeObj = null;
      let leaveTimeObj = null;
      
      if (dateAttendance?.entryTime) {
        try {
          const parsedEntry = DateTime.fromISO(dateAttendance.entryTime);
          if (parsedEntry.isValid) {
            entryTimeObj = parsedEntry.toJSDate();
          }
        } catch (e) {
          console.warn(`Invalid entry time format for student ${student.indexNumber}:`, dateAttendance.entryTime);
        }
      }
      
      if (dateAttendance?.leaveTime) {
        try {
          const parsedLeave = DateTime.fromISO(dateAttendance.leaveTime);
          if (parsedLeave.isValid) {
            leaveTimeObj = parsedLeave.toJSDate();
          }
        } catch (e) {
          console.warn(`Invalid leave time format for student ${student.indexNumber}:`, dateAttendance.leaveTime);
        }
      }
      
      // Normalize status for display like in Dashboard
      const status = dateAttendance?.status?.toLowerCase() || 'absent';
      
      // Handle student name combining all possible variations like Dashboard
      let studentName;
      
      if (student.name) {
        studentName = student.name;
      } else if (student.firstName && student.lastName) {
        studentName = `${student.firstName} ${student.lastName}`;
      } else if (student.firstName) {
        studentName = student.firstName;
      } else {
        studentName = student.indexNumber || 'Unknown';
      }
      
      const studentEmail = student.student_email || 
                           student.email || 
                           (dateAttendance?.student?.student_email) ||
                           (dateAttendance?.student?.email) ||
                           'N/A';

      return {
        name: studentName,
        indexNumber: student.indexNumber || 'N/A',
        student_email: studentEmail,
        status: status,
        entryTime: entryTimeObj,
        leaveTime: leaveTimeObj,
        date: targetDate
      };
    });

    console.log(`Processed ${processedStudents.length} student records for report`);

    // Create Excel report
    const excelBuffer = await createExcelReport(processedStudents, 'daily');

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=daily_report_${date}.xlsx`);
    
    return res.send(excelBuffer);
  } catch (error) {
    console.error('Error generating daily report:', error);
    return res.status(500).json({ 
      status: 'error',
      message: 'Error generating daily report', 
      error: error.message 
    });
  }
};

export const generateWeeklyReport = async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Date parameter is required' 
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid date format. Please use YYYY-MM-DD format' 
      });
    }

    // Get the week's start and end dates
    const targetDate = DateTime.fromISO(date);
    const weekStart = targetDate.startOf('week').toJSDate();
    const weekEnd = targetDate.endOf('week').toJSDate();

    // Get all students with attendance records for the week
    const students = await Student.find({
      "attendanceHistory": {
        $elemMatch: {
          date: {
            $gte: weekStart,
            $lte: weekEnd
          }
        }
      }
    }).select('name indexNumber student_email attendanceHistory').lean();

    if (!students || students.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'No attendance records found for the specified week'
      });
    }

    // Process student records
    const processedStudents = students.map(student => {
      const weekAttendance = student.attendanceHistory.filter(record => {
        const recordDate = DateTime.fromJSDate(record.date);
        return recordDate >= weekStart && recordDate <= weekEnd;
      });

      const daysPresent = weekAttendance.filter(r => r.status === 'present' || r.status === 'entered').length;
      const daysAbsent = weekAttendance.filter(r => r.status === 'absent').length;
      const daysLate = weekAttendance.filter(r => r.status === 'late').length;
      const totalDays = 5; // Assuming 5 working days per week

      return {
        name: student.name || 'N/A',
        indexNumber: student.indexNumber || 'N/A',
        student_email: student.student_email || 'N/A',
        weekStart: weekStart,
        weekEnd: weekEnd,
        daysPresent,
        daysAbsent,
        daysLate,
        attendanceRate: (daysPresent / totalDays) * 100
      };
    });

    // Create Excel report
    const excelBuffer = await createExcelReport(processedStudents, 'weekly');

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=weekly_report_${date}.xlsx`);
    
    return res.send(excelBuffer);
  } catch (error) {
    console.error('Error generating weekly report:', error);
    return res.status(500).json({ 
      status: 'error',
      message: 'Error generating weekly report', 
      error: error.message 
    });
  }
};

export const generateMonthlyReport = async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Date parameter is required' 
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid date format. Please use YYYY-MM-DD format' 
      });
    }

    // Get the month's start and end dates
    const targetDate = DateTime.fromISO(date);
    const monthStart = targetDate.startOf('month').toJSDate();
    const monthEnd = targetDate.endOf('month').toJSDate();

    // Get all students with attendance records for the month
    const students = await Student.find({
      "attendanceHistory": {
        $elemMatch: {
          date: {
            $gte: monthStart,
            $lte: monthEnd
          }
        }
      }
    }).select('name indexNumber student_email attendanceHistory').lean();

    if (!students || students.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'No attendance records found for the specified month'
      });
    }

    // Process student records
    const processedStudents = students.map(student => {
      const monthAttendance = student.attendanceHistory.filter(record => {
        const recordDate = DateTime.fromJSDate(record.date);
        return recordDate >= monthStart && recordDate <= monthEnd;
      });

      const daysPresent = monthAttendance.filter(r => r.status === 'present' || r.status === 'entered').length;
      const daysAbsent = monthAttendance.filter(r => r.status === 'absent').length;
      const daysLate = monthAttendance.filter(r => r.status === 'late').length;
      const totalDays = monthAttendance.length;

      // Calculate average duration
      const totalDuration = monthAttendance.reduce((sum, record) => {
        if (record.entryTime && record.leaveTime) {
          return sum + DateTime.fromJSDate(record.leaveTime)
            .diff(DateTime.fromJSDate(record.entryTime), 'hours')
            .toObject()
            .hours;
        }
        return sum;
      }, 0);

      return {
        name: student.name || 'N/A',
        indexNumber: student.indexNumber || 'N/A',
        student_email: student.student_email || 'N/A',
        month: targetDate.toFormat('MMMM yyyy'),
        daysPresent,
        daysAbsent,
        daysLate,
        attendanceRate: (daysPresent / totalDays) * 100,
        averageDuration: daysPresent > 0 ? totalDuration / daysPresent : 0
      };
    });

    // Create Excel report
    const excelBuffer = await createExcelReport(processedStudents, 'monthly');

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=monthly_report_${date}.xlsx`);
    
    return res.send(excelBuffer);
  } catch (error) {
    console.error('Error generating monthly report:', error);
    return res.status(500).json({ 
      status: 'error',
      message: 'Error generating monthly report', 
      error: error.message 
    });
  }
};

export const generateIndividualReport = async (req, res) => {
  try {
    const { studentId, date } = req.query;
    
    if (!studentId || !date) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Both studentId and date parameters are required' 
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid date format. Please use YYYY-MM-DD format' 
      });
    }

    // Get the month's start and end dates
    const targetDate = DateTime.fromISO(date);
    const monthStart = targetDate.startOf('month').toJSDate();
    const monthEnd = targetDate.endOf('month').toJSDate();

    // Get student with attendance records for the month
    const student = await Student.findOne({
      _id: studentId,
      "attendanceHistory": {
        $elemMatch: {
          date: {
            $gte: monthStart,
            $lte: monthEnd
          }
        }
      }
    }).select('name indexNumber student_email attendanceHistory').lean();

    if (!student) {
      return res.status(404).json({
        status: 'error',
        message: 'Student not found or no attendance records for the specified month'
      });
    }

    // Process attendance records
    const monthAttendance = student.attendanceHistory.filter(record => {
      const recordDate = DateTime.fromJSDate(record.date);
      return recordDate >= monthStart && recordDate <= monthEnd;
    });

    const processedRecords = monthAttendance.map(record => ({
      name: student.name || 'N/A',
      indexNumber: student.indexNumber || 'N/A',
      student_email: student.student_email || 'N/A',
      date: record.date,
      status: record.status || 'absent',
      entryTime: record.entryTime || null,
      leaveTime: record.leaveTime || null,
      duration: record.entryTime && record.leaveTime ? 
        DateTime.fromJSDate(record.leaveTime)
          .diff(DateTime.fromJSDate(record.entryTime), 'hours')
          .toObject()
          .hours : null
    }));

    // Create Excel report
    const excelBuffer = await createExcelReport(processedRecords, 'individual');

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=individual_report_${student.indexNumber}_${date}.xlsx`);
    
    return res.send(excelBuffer);
  } catch (error) {
    console.error('Error generating individual report:', error);
    return res.status(500).json({ 
      status: 'error',
      message: 'Error generating individual report', 
      error: error.message 
    });
  }
};

// Helper function to process student data consistently
const processStudentData = (student) => {
  // Parse dates safely
  let entryTimeObj = null;
  let leaveTimeObj = null;
  
  if (student.entryTime) {
    try {
      const parsedEntry = DateTime.fromISO(student.entryTime);
      if (parsedEntry.isValid) {
        entryTimeObj = parsedEntry.toJSDate();
      }
    } catch (e) {
      console.warn(`Invalid entry time format for student ${student.indexNumber}:`, student.entryTime);
    }
  }
  
  if (student.leaveTime) {
    try {
      const parsedLeave = DateTime.fromISO(student.leaveTime);
      if (parsedLeave.isValid) {
        leaveTimeObj = parsedLeave.toJSDate();
      }
    } catch (e) {
      console.warn(`Invalid leave time format for student ${student.indexNumber}:`, student.leaveTime);
    }
  }
  
  // Normalize status for display
  let displayStatus;
  let normalizedStatus = student.status?.toLowerCase() || 'unknown';
  
  if (normalizedStatus === 'entered') {
    displayStatus = 'Present';
    normalizedStatus = 'present';
  } else if (normalizedStatus === 'left') {
    displayStatus = 'Left';
  } else if (normalizedStatus === 'late') {
    displayStatus = 'Late';
  } else if (normalizedStatus === 'absent') {
    displayStatus = 'Absent';
  } else {
    displayStatus = student.status || 'Unknown';
  }
  
  // Handle student name combining all possible variations
  let studentName;
  if (student.name) {
    studentName = student.name;
  } else if (student.firstName && student.lastName) {
    studentName = `${student.firstName} ${student.lastName}`;
  } else if (student.firstName) {
    studentName = student.firstName;
  } else if (student.attendanceHistory && student.attendanceHistory[0]?.student?.name) {
    studentName = student.attendanceHistory[0].student.name;
  } else {
    studentName = student.indexNumber || 'Unknown';
  }
  
  // Normalize email address with all possible sources
  const studentEmail = student.student_email || 
                       student.email || 
                       (student.attendanceHistory && student.attendanceHistory[0]?.student?.student_email) ||
                       (student.attendanceHistory && student.attendanceHistory[0]?.student?.email) ||
                       (student.attendanceHistory && student.attendanceHistory[0]?.email) || 
                       'N/A';
  
  return {
    ...student,
    id: student.id || student._id,
    name: studentName,
    indexNumber: student.indexNumber?.toUpperCase() || 'N/A',
    student_email: studentEmail,
    status: normalizedStatus,
    displayStatus: displayStatus,
    entryTime: entryTimeObj,
    leaveTime: leaveTimeObj,
    timestamp: student.timestamp || student.updatedAt || new Date().toISOString()
  };
};

// Preview controllers
export const getDailyReportPreview = async (req, res) => {
  try {
    const { startDate, endDate, limit = 10, includeAllStudents = false, showAbsentStudents = true } = req.query;
    
    // Validate dates
    const start = DateTime.fromFormat(startDate, 'yyyy-MM-dd');
    const end = DateTime.fromFormat(endDate, 'yyyy-MM-dd');
    
    if (!start.isValid || !end.isValid) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid date format',
        error: 'invalid_date_format'
      });
    }
    
    // Calculate start and end of day
    const startOfDay = start.startOf('day').toJSDate();
    const endOfDay = end.endOf('day').toJSDate();
    
    console.log(`Getting daily report preview for date range: ${startDate} to ${endDate}`);
    console.log(`Converted date range: ${startOfDay} to ${endOfDay}`);
    
    // Find students with attendance history for the specified date
    const students = await Student.find({
      "attendanceHistory.date": {
        $gte: startOfDay,
        $lte: endOfDay
      }
    })
    .select('name indexNumber student_email attendanceHistory status')
    .sort({ indexNumber: 1 })
    .limit(Number(limit));
    
    // If no students with attendance found, get any students
    if (!students || students.length === 0) {
      const anyStudents = await Student.find()
        .select('name indexNumber student_email attendanceHistory status')
        .sort({ indexNumber: 1 })
        .limit(Number(limit));
        
      if (!anyStudents || anyStudents.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: 'No students found',
          error: 'no_students'
        });
      }
      
      // For students without attendance, mark them as absent but include their full attendance history
      const previewData = anyStudents.map(student => ({
        name: student.name,
        indexNumber: student.indexNumber,
        status: 'Absent',
        entryTime: null,
        leaveTime: null,
        student_email: student.student_email,
        date: startOfDay,
        attendanceHistory: student.attendanceHistory || [] // Include full attendance history
      }));
      
      // Set headers to preserve MongoDB format
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('MongoDB-Date-Format', 'true');
      
      res.status(200).json({
        success: true,
        message: 'Preview data for daily report',
        data: previewData
      });
      return;
    }
    
    // Process student data with MongoDB format preservation
    const previewData = students.map(student => {
      // Find attendance record for the specific date
      const attendanceRecord = student.attendanceHistory.find(record => {
        const recordDate = new Date(record.date);
        return recordDate >= startOfDay && recordDate <= endOfDay;
      });
      
      let status = 'Absent';
      let entryTime = null;
      let leaveTime = null;
      
      if (attendanceRecord) {
        // Set status based on attendance record
        status = attendanceRecord.status === 'entered' ? 'Present' : 
                attendanceRecord.status === 'left' ? 'Left' : 
                attendanceRecord.status === 'late' ? 'Late' : 'Absent';
        
        entryTime = attendanceRecord.entryTime;
        leaveTime = attendanceRecord.leaveTime;
                
        console.log(`Found record for ${student.name}:`, {
          status: attendanceRecord.status,
          entryTime: attendanceRecord.entryTime,
          leaveTime: attendanceRecord.leaveTime
        });
      }
      
      // Return the full attendance record data
      return {
        name: student.name,
        indexNumber: student.indexNumber,
        status,
        entryTime,
        leaveTime,
        student_email: student.student_email,
        date: startOfDay,
        attendanceHistory: student.attendanceHistory || [] // Include full attendance history
      };
    });
    
    // Log the full attendance history for debugging
    console.log("Full attendance history for students:");
    previewData.forEach(student => {
      console.log(`${student.name} (${student.indexNumber}): ${student.attendanceHistory.length} attendance records`);
      student.attendanceHistory.forEach((record, index) => {
        console.log(`Record ${index+1}: Date: ${record.date}, Status: ${record.status}, Entry: ${record.entryTime}, Leave: ${record.leaveTime}`);
      });
    });
    
    // Set headers to preserve MongoDB format
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('MongoDB-Date-Format', 'true');
    
    res.status(200).json({
      success: true,
      message: 'Preview data for daily report',
      data: previewData
    });
  } catch (error) {
    console.error('Error generating daily report preview:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error generating preview', 
      error: error.message 
    });
  }
};

export const getWeeklyReportPreview = async (req, res) => {
  try {
    const { startDate, endDate, limit = 20 } = req.query;
    
    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid date format',
        error: 'invalid_date_format'
      });
    }
    
    // Set time to start and end of day
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    
    // Calculate total days in date range
    const totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
    
    // Find students with attendance records in the date range
    const students = await Student.find({
      'attendanceHistory.date': {
        $gte: start,
        $lte: end
      }
    })
    .select('name indexNumber student_email attendanceHistory status')
    .sort({ indexNumber: 1 })
    .limit(parseInt(limit));
    
    if (!students || students.length === 0) {
      // If no students with attendance, get a sample of students
      const anyStudents = await Student.find()
        .select('name indexNumber student_email status')
        .sort({ indexNumber: 1 })
        .limit(parseInt(limit));
        
      if (!anyStudents || anyStudents.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No students found',
          error: 'no_students'
        });
      }
      
      // Return students with zero attendance
      const previewData = anyStudents.map(student => ({
        name: student.name,
        indexNumber: student.indexNumber,
        email: student.student_email,
          daysPresent: 0,
        daysAbsent: totalDays,
        attendanceRate: 0
      }));
      
      // Set headers to preserve MongoDB format
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('MongoDB-Date-Format', 'true');
      
      return res.status(200).json({
        success: true,
        message: 'Weekly attendance preview data',
        students: previewData
      });
    }
    
    // Process student data to calculate weekly attendance stats
    const processedStudents = students.map(student => {
      // Filter attendance records within the date range
      const recordsInRange = student.attendanceHistory.filter(record => {
        const recordDate = new Date(record.date);
        return recordDate >= start && recordDate <= end;
      });
      
      // Count unique days present using Set to avoid duplicates
      const uniqueDaysPresent = new Set();
      
      recordsInRange.forEach(record => {
        if (record.status === 'entered' || record.status === 'left' || record.status === 'late') {
          // Use date string as key for the Set
          const dateString = new Date(record.date).toISOString().split('T')[0];
          uniqueDaysPresent.add(dateString);
        }
      });
      
      const daysPresent = uniqueDaysPresent.size;
      const daysAbsent = totalDays - daysPresent;
      const attendanceRate = totalDays > 0 ? (daysPresent / totalDays) * 100 : 0;
      
      return {
        name: student.name,
        indexNumber: student.indexNumber,
        email: student.student_email || 'N/A',
        daysPresent,
        daysAbsent,
        attendanceRate
      };
    });
    
    // Set headers to preserve MongoDB format
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('MongoDB-Date-Format', 'true');
    
    res.status(200).json({
      success: true,
      message: 'Weekly attendance preview data',
      students: processedStudents
    });
  } catch (error) {
    console.error('Error generating weekly report preview:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error generating preview', 
      error: error.message 
    });
  }
};

export const getMonthlyReportPreview = async (req, res) => {
  try {
    const { startDate, endDate, limit = 20 } = req.query;
    
    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid date format',
        error: 'invalid_date_format'
      });
    }
    
    // Set time to start and end of day
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    
    // Calculate total days in date range
    const totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
    
    // Find students with attendance records in the date range
    const students = await Student.find({
      'attendanceHistory.date': {
        $gte: start,
        $lte: end
      }
    })
    .select('name indexNumber student_email attendanceHistory status')
    .sort({ indexNumber: 1 })
    .limit(parseInt(limit));
    
    if (!students || students.length === 0) {
      // If no students with attendance, get a sample of students
      const anyStudents = await Student.find()
        .select('name indexNumber student_email status')
        .sort({ indexNumber: 1 })
        .limit(parseInt(limit));
        
      if (!anyStudents || anyStudents.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No students found',
          error: 'no_students'
        });
      }
      
      // Return students with zero attendance
      const previewData = anyStudents.map(student => ({
        name: student.name,
        indexNumber: student.indexNumber,
        email: student.student_email,
        month: new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
          daysPresent: 0,
        daysAbsent: totalDays,
        attendanceRate: 0,
        lateDays: 0
      }));
      
      // Set headers to preserve MongoDB format
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('MongoDB-Date-Format', 'true');
      
      return res.status(200).json({
        success: true,
        message: 'Monthly attendance preview data',
        students: previewData
      });
    }
    
    // Get month and year from the date range for display
    const month = start.toLocaleString('default', { month: 'long', year: 'numeric' });
    
    // Process student data to calculate monthly attendance stats
    const processedStudents = students.map(student => {
      // Filter attendance records within the date range
      const recordsInRange = student.attendanceHistory.filter(record => {
        const recordDate = new Date(record.date);
        return recordDate >= start && recordDate <= end;
      });
      
      // Count unique days present and late days
      const uniqueDaysPresent = new Set();
      let lateDays = 0;
      
      recordsInRange.forEach(record => {
        if (record.status === 'entered' || record.status === 'left') {
          // Use date string as key for the Set
          const dateString = new Date(record.date).toISOString().split('T')[0];
          uniqueDaysPresent.add(dateString);
        }
        
        if (record.status === 'late') {
          lateDays++;
          // Also count late days as present
          const dateString = new Date(record.date).toISOString().split('T')[0];
          uniqueDaysPresent.add(dateString);
        }
      });
      
      const daysPresent = uniqueDaysPresent.size;
      const daysAbsent = totalDays - daysPresent;
      const attendanceRate = totalDays > 0 ? (daysPresent / totalDays) * 100 : 0;
      
      return {
        name: student.name,
        indexNumber: student.indexNumber,
        month,
        daysPresent,
        daysAbsent,
        attendanceRate,
        lateDays
      };
    });
    
    // Set headers to preserve MongoDB format
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('MongoDB-Date-Format', 'true');
    
    res.status(200).json({
      success: true,
      message: 'Monthly attendance preview data',
      students: processedStudents
    });
  } catch (error) {
    console.error('Error generating monthly report preview:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error generating preview', 
      error: error.message 
    });
  }
};

export const getIndividualReportPreview = async (req, res) => {
  try {
    const { studentId, startDate, endDate, limit = 20 } = req.query;
    
    if (!studentId) {
      return res.status(400).json({ 
        success: false,
        message: 'Student ID is required',
        error: 'missing_student_id'
      });
    }
    
    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid date format',
        error: 'invalid_date_format'
      });
    }
    
    // Set time to start and end of day
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    
    // Find the student
    const student = await Student.findById(studentId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
        error: 'student_not_found'
      });
    }
    
    // Filter attendance records for the date range
    const attendanceRecords = student.attendanceHistory
      .filter(record => {
        const recordDate = new Date(record.date);
        return recordDate >= start && recordDate <= end;
      })
      .map(record => {
        // Format the record for display
      return {
          date: record.date,
          status: record.status === 'entered' ? 'Present' : 
                 record.status === 'left' ? 'Left' : 
                 record.status === 'late' ? 'Late' : 'Absent',
          entryTime: record.entryTime,
          leaveTime: record.leaveTime,
          scanLocation: record.scanLocation || 'Main Entrance'
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, parseInt(limit));
    
    // Set headers to preserve MongoDB format
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('MongoDB-Date-Format', 'true');
    
    res.status(200).json({
      success: true,
      message: 'Individual student attendance records',
      student: {
        _id: student._id,
        name: student.name,
        indexNumber: student.indexNumber,
        email: student.student_email,
        attendanceRecords: attendanceRecords
      }
    });
  } catch (error) {
    console.error('Error generating individual report preview:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error generating preview', 
      error: error.message 
    });
  }
};

export const clearStudentAttendanceHistory = async (req, res) => {
  try {
    const { studentId } = req.params;
    
    if (!studentId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID is required'
      });
    }

    // Find the student
    const student = await Student.findById(studentId);
    
    if (!student) {
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }

    // Save original count for response
    const originalCount = student.attendanceHistory.length;
    
    // Use the new model method to clear attendance history
    await student.clearAttendanceHistory();
    
    return res.status(200).json({
      status: 'success',
      message: `Successfully cleared ${originalCount} attendance records`,
      data: {
        student: {
          id: student._id,
          name: student.name,
          indexNumber: student.indexNumber,
          attendanceHistory: [],
          attendanceCount: 0
        }
      }
    });
  } catch (error) {
    console.error('Error clearing student attendance history:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to clear attendance history',
      error: error.message
    });
  }
};

export const deleteAttendanceRecord = async (req, res) => {
  try {
    const { studentId, recordId } = req.params;
    
    if (!studentId || !recordId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID and attendance record ID are required'
      });
    }

    // Find the student
    const student = await Student.findById(studentId);
    
    if (!student) {
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }
    
    // Use the new model method to delete the record
    try {
      const { deletedRecord, updatedStudent } = await student.deleteAttendanceRecord(recordId);
      
      return res.status(200).json({
        status: 'success',
        message: 'Successfully deleted attendance record',
        data: {
          deletedRecord: {
            id: deletedRecord._id,
            date: deletedRecord.date,
            status: deletedRecord.status
          },
          student: {
            id: updatedStudent._id,
            name: updatedStudent.name,
            indexNumber: updatedStudent.indexNumber,
            attendanceCount: updatedStudent.attendanceCount,
            attendancePercentage: updatedStudent.attendancePercentage,
            attendanceHistoryCount: updatedStudent.attendanceHistory.length
          }
        }
      });
    } catch (modelError) {
      return res.status(404).json({
        status: 'error',
        message: modelError.message
      });
    }
  } catch (error) {
    console.error('Error deleting attendance record:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to delete attendance record',
      error: error.message
    });
  }
};

export const getStudentAttendanceHistory = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { startDate, endDate, limit, offset, sortBy, sortOrder } = req.query;
    
    if (!studentId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID is required'
      });
    }

    // Find the student
    const student = await Student.findById(studentId);
    
    if (!student) {
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }
    
    // Use the new model method to get filtered attendance history
    const { records, totalRecords, stats } = student.getFilteredAttendanceHistory({
      startDate,
      endDate,
      limit,
      offset,
      sortBy,
      sortOrder
    });
    
    // Return the attendance history
    return res.status(200).json({
      status: 'success',
      data: {
        student: {
          id: student._id,
          name: student.name,
          indexNumber: student.indexNumber,
          email: student.student_email
        },
        attendanceHistory: records,
        totalRecords,
        stats
      }
    });
  } catch (error) {
    console.error('Error fetching student attendance history:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch attendance history',
      error: error.message
    });
  }
};