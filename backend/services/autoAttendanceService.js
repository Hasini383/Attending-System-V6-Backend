import { logInfo, logWarning, logError } from '../utils/terminal.js';
import Student from '../models/student.model.js';
import { sendTextMessage } from './whatsapp.service.js';

/**
 * Automatically mark students as having left at 6:30 PM
 * Finds all students who entered but didn't scan the QR code to leave
 * Runs daily at 7:00 PM via the scheduler service
 */
export const autoMarkLeaveAttendance = async () => {
  try {
    logInfo('Starting automatic leave attendance marking process...');
    
    // Get today's date at midnight for comparison
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Find all students who have marked attendance today but haven't left
    const students = await Student.find({
      'attendanceHistory.date': {
        $gte: today,
        $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
      },
      'attendanceHistory.status': { $in: ['entered', 'present'] },
      'attendanceHistory.leaveTime': null
    });

    if (!students.length) {
      logInfo('No students found who need automatic leave marking');
      return;
    }

    logInfo(`Found ${students.length} students who need automatic leave marking`);

    // Set leave time to 6:30 PM
    const leaveTime = new Date();
    leaveTime.setHours(18, 30, 0, 0);

    // Process each student
    for (const student of students) {
      try {
        // Find today's attendance record that doesn't have a leave time
        const todayAttendanceIndex = student.attendanceHistory.findIndex(
          record => record.date.toDateString() === today.toDateString() &&
                   ['entered', 'present'].includes(record.status) &&
                   !record.leaveTime
        );

        if (todayAttendanceIndex === -1) {
          logWarning(`No eligible attendance record found for student: ${student.name}`);
          continue;
        }

        // Update the student's attendance record
        student.attendanceHistory[todayAttendanceIndex].leaveTime = leaveTime;
        student.attendanceHistory[todayAttendanceIndex].status = 'left';
        
        // Update lastAttendance field
        student.lastAttendance = leaveTime;
        
        // Recalculate attendance percentage
        const totalRecords = student.attendanceHistory.length;
        const presentRecords = student.attendanceHistory.filter(record => 
          record.status === 'present' || record.status === 'entered'
        ).length;
        
        student.attendancePercentage = totalRecords > 0 
          ? (presentRecords / totalRecords) * 100 
          : 0;
        
        await student.save();

        // Prepare message for parent notification
        const messageText = `🏫 Automated Attendance Update

Dear Parent, 
Your child ${student.name} (Index: ${student.indexNumber}) did not scan the QR code when leaving today.
The system has automatically marked their departure time as 6:30 PM.
Please remind your child to properly scan both when arriving and leaving.

Thank you.`;

        // Send notification to parent via WhatsApp
        if (student.parent_telephone) {
          const result = await sendTextMessage(student.parent_telephone, messageText);
          
          if (result.success) {
            logInfo(`Successfully sent automatic leave notification to parent of ${student.name}`);
          } else {
            logWarning(`Failed to send message to parent of ${student.name}: ${result.error}`);
          }
        } else {
          logWarning(`No parent telephone found for student: ${student.name}`);
        }
        
        logInfo(`Successfully marked leave attendance for student: ${student.name}`);
      } catch (error) {
        logError(`Error processing student ${student.name}: ${error.message}`);
      }
    }

    logInfo('Completed automatic leave attendance marking process');
  } catch (error) {
    logError(`Error in autoMarkLeaveAttendance: ${error.message}`);
    throw error;
  }
}; 