import express from 'express';
import { connectDB } from '../config/database.js';
import adminRoutes from '../routes/admin.routes.js';
import cors from 'cors';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import compression from 'compression';
import { logError, logInfo } from '../utils/terminal.js';

const app = express();

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',  
  'http://127.0.0.1:3000',  
  process.env.CLIENT_URL
].filter(Boolean);

// Security middleware
app.use(helmet());
app.use(compression());
app.use(cors({ 
  origin: allowedOrigins,
  credentials: true 
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Error handling middleware
app.use((err, req, res, next) => {
  logError(`Admin API Error: ${err.message}`);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    path: req.path
  });
});

// Database connection with retry
let retries = 5;
while (retries) {
  try {
    await connectDB();
    logInfo('Admin API: Database connected');
    break;
  } catch (error) {
    retries--;
    if (retries === 0) {
      logError(`Admin API: Database connection failed - ${error.message}`);
      process.exit(1);
    }
    logInfo(`Admin API: Retrying database connection... (${retries} attempts left)`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// Routes with monitoring
app.use((req, res, next) => {
  logInfo(`Admin API: ${req.method} ${req.path}`);
  next();
});

app.use('/api/admin', adminRoutes);

export default app;
