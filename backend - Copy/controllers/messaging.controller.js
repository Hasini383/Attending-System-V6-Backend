import { 
  getClientState, 
  setQRCallback, 
  sendTextMessage, 
  sendAttendanceAlert, 
  getCurrentQR, 
  resetQR,
  logout as whatsappLogout 
} from '../services/whatsapp.service.js';
import Student from '../models/student.model.js';
import { DateTime } from 'luxon';

/**
 * Get WhatsApp connection status 
 */
export const getWhatsAppStatus = async (req, res) => {
  try {
    const status = getClientState();
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    console.error('Error getting WhatsApp status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Set QR code callback for WhatsApp authentication
 */
export const setQRCodeCallback = (callback) => {
  setQRCallback(callback);
};

/**
 * Get current QR code for WhatsApp authentication
 */
export const getQRCode = async (req, res) => {
  try {
    const { qr, timestamp } = getCurrentQR();
    
    if (!qr) {
      return res.status(404).json({
        success: false,
        message: 'No QR code available. Please try refreshing.'
      });
    }

    res.status(200).json({
      success: true,
      qrCode: qr,
      timestamp,
      expiresIn: 60 // QR codes typically expire in 60 seconds
    });
  } catch (error) {
    console.error('Error getting QR code:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Force refresh the QR code
 */
export const refreshQRCode = async (req, res) => {
  try {
    // Reset WhatsApp client
    await resetQR();
    
    // Wait briefly for new QR code
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Get new QR code
    const qrCode = getCurrentQR();
    
    if (!qrCode.qr) {
      return res.status(404).json({
        success: false,
        message: 'QR code not available. Please try again.'
      });
    }
    
    res.status(200).json({
      success: true,
      qrCode: qrCode.qr,
      timestamp: qrCode.timestamp,
      expiresIn: 60
    });
  } catch (error) {
    console.error('Error refreshing QR code:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to refresh QR code'
    });
  }
};

/**
 * Handle WhatsApp logout
 */
export const logoutWhatsApp = async (req, res) => {
  try {
    // First try to logout
    const logoutResult = await whatsappLogout();
    
    // Then reset the QR code, but don't throw if it fails
    try {
      await resetQR();
    } catch (resetError) {
      console.warn('Error during QR reset:', resetError);
    }
    
    res.status(200).json({
      success: true,
      message: logoutResult.message || 'WhatsApp logged out successfully',
      warning: logoutResult.warning
    });
  } catch (error) {
    console.error('Error during WhatsApp logout:', error);
    // Send success response even on error since we want the frontend to proceed
    res.status(200).json({
      success: true,
      message: 'WhatsApp session cleared',
      warning: error.message
    });
  }
};

/**
 * Send a WhatsApp message to a parent when their child scans a QR code
 * Used for attendance notifications
 */
export const sendQrCodeScanMessage = async (studentData) => {
  try {
    const {
      name,
      indexNumber,
      status,
      timestamp,
      parentPhone
    } = studentData;

    if (!parentPhone) {
      console.log('No parent phone number available for student:', indexNumber);
      return {
        status: 'failed',
        message: 'No parent phone number available'
      };
    }

    // Format time for Sri Lanka timezone
    const time = DateTime.fromJSDate(timestamp)
      .setZone('Asia/Colombo')
      .toFormat('hh:mm a');

    // Create message content
    const message = `Dear Parent,\n\nThis is to inform you that your child ${name} (${indexNumber}) has ${status === 'entered' ? 'entered' : 'left'} the school at ${time}.\n\nThank you,\nSchool Administration`;

    const result = await sendAttendanceAlert(
      parentPhone,
      studentData,
      status,
      timestamp
    );

    return {
      status: result.success ? 'sent' : 'failed',
      messageId: result.messageId,
      content: result.message,
      timestamp: new Date(),
      recipientPhone: parentPhone
    };
  } catch (error) {
    console.error('Error sending QR code scan message:', error);
    return {
      status: 'failed',
      message: error.message
    };
  }
};

/**
 * Send a manual WhatsApp message
 */
export const sendMessage = async (req, res) => {
  try {
    const { phoneNumber, message, type = 'test' } = req.body;
    
    if (!phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and message are required'
      });
    }

    // Format phone number to remove spaces and ensure proper format
    let formattedPhone = phoneNumber.replace(/\s+/g, '');
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }

    const result = await sendTextMessage(formattedPhone, message);
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || 'Failed to send message',
        code: result.code
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Message sent successfully',
      messageId: result.messageId,
      timestamp: result.timestamp
    });
  } catch (error) {
    console.error('Error in sendMessage:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message
    });
  }
};

/**
 * Send bulk WhatsApp messages to multiple students' parents
 */
export const handleBulkMessages = async (req, res) => {
  try {
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
    
    const students = await Student.find({ _id: { $in: studentIds } });
    
    if (!students || students.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No students found with the provided IDs'
      });
    }
    
    // Get list of phone numbers
    const phoneNumbers = students
      .filter(student => student.parent_telephone)
      .map(student => student.parent_telephone);

    const result = await sendBulkWhatsAppMessages(phoneNumbers, message);
    
    // Record messages for successful sends
    for (const student of students) {
      if (student.parent_telephone) {
        const successfulSend = result.results.successful.find(
          s => s.phone === student.parent_telephone
        );
        
        if (successfulSend) {
          student.messages = student.messages || [];
          student.messages.push({
            content: message,
            sentAt: new Date(),
            type: 'notification',
            status: 'sent',
            messageId: successfulSend.messageId,
            recipient: student.parent_telephone
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

/**
 * Test the WhatsApp connection by sending a test message
 */
export const testWhatsAppMessage = async (req, res) => {
  try {
    const { phoneNumber, studentId, customMessage } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }
    
    let messageResult;
    
    if (studentId) {
      // Send a test attendance message for a specific student
      const student = await Student.findById(studentId);
      
      if (!student) {
        return res.status(404).json({
          success: false,
          message: 'Student not found'
        });
      }
      
      messageResult = await whatsappService.sendAttendanceAlert(
        phoneNumber,
        student,
        'test scan',
        new Date()
      );

      // Record test message
      student.messages.push({
        content: `Test attendance alert sent at ${DateTime.now().toLocaleString(DateTime.DATETIME_FULL)}`,
        sentAt: new Date(),
        type: 'test',
        status: messageResult.success ? 'sent' : 'failed',
        messageId: messageResult.messageId,
        recipient: phoneNumber
      });
      
      await student.save();
      
    } else if (customMessage) {
      // Send custom message
      messageResult = await whatsappService.sendTextMessage(
        phoneNumber,
        customMessage
      );
    } else {
      // Send a default test message
      messageResult = await whatsappService.sendTextMessage(
        phoneNumber,
        '🔔 This is a test message from the Attending System.'
      );
    }
    
    if (!messageResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to send WhatsApp message',
        error: messageResult.error
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'WhatsApp test message sent successfully',
      messageId: messageResult.messageId
    });
  } catch (error) {
    console.error('Error in testWhatsAppMessage:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send test message',
      error: error.message
    });
  }
};

export default {
  getWhatsAppStatus,
  setQRCodeCallback,
  getQRCode,
  refreshQRCode,
  sendQrCodeScanMessage,
  testWhatsAppMessage,
  sendMessage,
  handleBulkMessages,
  logoutWhatsApp
};
