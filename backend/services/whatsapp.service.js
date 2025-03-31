import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

/**
 * WhatsApp Web client instance
 * Used for sending automated notifications to parents
 */
let client = new Client({
  authStrategy: new LocalAuth({
    dataPath: 'whatsapp-session'
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Internal state tracking
let qrCallback = null;
let isClientReady = false;
let clientError = null;
let currentQR = null;

// Start client initialization
client.initialize();

// Handle QR code generation
client.on('qr', (qr) => {
  console.log('New QR code generated');
  currentQR = qr;
  qrcode.generate(qr, { small: true });
  
  if (qrCallback) {
    qrCallback(qr);
  }
});

// Add error handling for client initialization
client.on('loading_screen', (percent, message) => {
  console.log('Loading:', percent, message);
});

client.on('authenticated', () => {
  console.log('WhatsApp client authenticated');
  currentQR = null; // Clear QR code after authentication
});

// Handle client ready state
client.on('ready', () => {
  console.log('WhatsApp client is ready!');
  isClientReady = true;
  clientError = null;
});

// Handle authentication failures
client.on('auth_failure', (error) => {
  console.error('WhatsApp authentication failed:', error);
  clientError = error;
  isClientReady = false;
  // Reset client state on auth failure
  client.destroy().then(() => client.initialize()).catch(console.error);
});

// Handle disconnections
client.on('disconnected', (reason) => {
  console.log('WhatsApp client disconnected:', reason);
  isClientReady = false;
});

/**
 * Set callback function for QR code scanning
 */
export const setQRCallback = (callback) => {
  qrCallback = callback;
};

/**
 * Get current QR code
 */
export const getCurrentQR = () => {
  return {
    qr: currentQR,
    timestamp: new Date()
  };
};

/**
 * Reset QR code and initialize new client
 */
export const resetQR = async () => {
  try {
    currentQR = null;
    isClientReady = false;
    
    if (client) {
      // Clean up existing client
      await client.destroy().catch(() => {});
      
      // Create and initialize new client
      client = new Client({
        authStrategy: new LocalAuth({
          dataPath: 'whatsapp-session'
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
          ]
        }
      });

      await client.initialize().catch(() => {});
    }
    
    return {
      success: true,
      message: 'WhatsApp connection reset successfully'
    };
  } catch (error) {
    console.error('Error resetting QR code:', error);
    // Return success even on error since we've reset the state
    return {
      success: true,
      message: 'WhatsApp state reset',
      warning: error.message
    };
  }
};

/**
 * Handle WhatsApp logout with proper cleanup
 */
export const logout = async () => {
  try {
    // Reset internal state first
    currentQR = null;
    isClientReady = false;
    clientError = null;

    if (client) {
      try {
        // Try to close any active page/browser sessions
        const pages = await client.pupPage?.browser()?.pages();
        if (pages) {
          await Promise.all(pages.map(page => page.close().catch(() => {})));
        }
      } catch (error) {
        console.warn('Error closing browser pages:', error);
      }

      try {
        // Try graceful logout first
        await client.logout().catch(() => {});
      } catch (error) {
        console.warn('Graceful logout failed:', error);
      }

      try {
        // Force destroy the client
        await client.destroy().catch(() => {});
      } catch (error) {
        console.warn('Error destroying client:', error);
      }

      // Create a new client instance
      client = new Client({
        authStrategy: new LocalAuth({
          dataPath: 'whatsapp-session'
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
          ]
        }
      });

      // Initialize the new client
      await client.initialize().catch(() => {});
    }

    return {
      success: true,
      message: 'WhatsApp session cleared successfully'
    };
  } catch (error) {
    console.error('Error during WhatsApp logout:', error);
    // Even if there's an error, we want to consider it successful
    // as long as we've cleared the state
    return {
      success: true,
      message: 'WhatsApp state reset successfully',
      warning: error.message
    };
  }
};

/**
 * Get current connection state of WhatsApp client
 */
export const getClientState = () => {
  return {
    isReady: isClientReady,
    error: clientError,
    qrCode: currentQR, // Add QR code to status
    timestamp: new Date()
  };
};

/**
 * Format phone number for WhatsApp API
 * Removes non-numeric characters and handles country codes
 */
const formatPhoneNumber = (phoneNumber) => {
  let formatted = phoneNumber.trim();
  if (formatted.startsWith('+')) {
    formatted = formatted.substring(1);
  }
  formatted = formatted.replace(/\D/g, '');
  
  return formatted;
};

/**
 * Send a text message via WhatsApp
 * Returns success status and message details
 */
export const sendTextMessage = async (phoneNumber, message) => {
  try {
    console.log(`Attempting to send WhatsApp message to ${phoneNumber}`);
    
    if (!isClientReady) {
      console.log('WhatsApp client not ready, current state:', clientError || 'No specific error');
      return {
        success: false,
        error: 'WhatsApp client not ready',
        code: 'CLIENT_NOT_READY'
      };
    }

    const formattedNumber = formatPhoneNumber(phoneNumber);
    if (!formattedNumber) {
      console.log(`Invalid phone number format: ${phoneNumber}`);
      return {
        success: false,
        error: 'Invalid phone number format',
        code: 'INVALID_PHONE'
      };
    }

    const chatId = `${formattedNumber}@c.us`;
    
    try {
      const result = await client.sendMessage(chatId, message);
      console.log('WhatsApp message sent successfully:', result.id._serialized);
      
      return {
        success: true,
        messageId: result.id._serialized,
        timestamp: result.timestamp,
        message: message
      };
    } catch (sendError) {
      console.error('Error in WhatsApp send operation:', sendError);
      return {
        success: false,
        error: sendError.message,
        code: 'SEND_ERROR',
        details: sendError.stack
      };
    }
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    return {
      success: false,
      error: error.message,
      code: 'GENERAL_ERROR',
      details: error.stack
    };
  }
};

/**
 * Send an attendance notification to parent
 * Formats a detailed message with student's attendance status
 */
export const sendAttendanceAlert = async (phoneNumber, student, status, timestamp) => {
  try {
    if (!phoneNumber) {
      console.log('No phone number provided for attendance alert');
      return {
        success: false,
        error: 'No phone number provided',
        code: 'MISSING_PHONE'
      };
    }

    const formattedTime = new Date(timestamp).toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Colombo' // Sri Lanka timezone
    });

    // Format readable status
    const displayStatus = status === 'entered' ? 'Entered School' : 
                          status === 'left' ? 'Left School' : 
                          status.charAt(0).toUpperCase() + status.slice(1);

    // Get student details with fallbacks
    const studentName = student.name || 'Student';
    const indexNumber = student.indexNumber || student.index || '';
    const email = student.student_email || student.email || 'N/A';
    const parentPhone = student.parent_telephone || student.parentPhone || phoneNumber;
    const address = student.address || 'N/A';

    // Create the message
    const message = `🏫 *Attendance Update*\n\n` +
      `Student: *${studentName}*\n` +
      `Index Number: *${indexNumber}*\n` +
      `Status: *${displayStatus}*\n` +
      `Time: *${formattedTime}*\n\n` +
      `Additional Details:\n` +
      `Email: ${email}\n` +
      `Parent Phone: ${parentPhone}\n` +
      `Address: ${address}`;

    // Log the message for debugging
    console.log('Sending WhatsApp attendance alert:', {
      to: phoneNumber,
      studentName,
      status: displayStatus,
      time: formattedTime
    });

    // Send the message
    const result = await sendTextMessage(phoneNumber, message);

    // Log the result
    if (result.success) {
      console.log('Successfully sent attendance alert:', {
        messageId: result.messageId,
        student: studentName,
        status: displayStatus,
        timestamp: formattedTime
      });
    } else {
      console.error('Failed to send attendance alert:', {
        error: result.error,
        student: studentName,
        status: displayStatus
      });
    }

    return {
      ...result,
      message
    };
  } catch (error) {
    console.error('Error in sendAttendanceAlert:', error);
    return {
      success: false,
      error: error.message,
      code: 'ALERT_ERROR'
    };
  }
};

/**
 * Send a bulk message to multiple recipients
 * @param {Array<string>} phoneNumbers - List of phone numbers
 * @param {string} message - Message to send
 * @returns {Promise<Object>} Result with success and failure counts
 */
export const sendBulkMessages = async (phoneNumbers, message) => {
  const results = {
    successful: [],
    failed: []
  };

  for (const phone of phoneNumbers) {
    try {
      const result = await sendTextMessage(phone, message);
      
      if (result.success) {
        results.successful.push({
          phone,
          messageId: result.messageId
        });
      } else {
        results.failed.push({
          phone,
          error: result.error
        });
      }
    } catch (error) {
      results.failed.push({
        phone,
        error: error.message
      });
    }
  }

  return {
    success: true,
    summary: {
      total: phoneNumbers.length,
      successful: results.successful.length,
      failed: results.failed.length
    },
    results
  };
};
