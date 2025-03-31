import express from 'express';
import { connectDB } from '../config/database.js';
import reportsRoutes from '../routes/reports.routes.js';
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
  credentials: true,
  exposedHeaders: ['Content-Disposition'] // For file downloads
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Error handling middleware
app.use((err, req, res, next) => {
  logError(`Reports API Error: ${err.message}`);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    path: req.path
  });
});

// Database connection with health check
try {
  await connectDB();
  logInfo('Reports API: Database connected');
  
  // Periodic health check
  setInterval(async () => {
    try {
      await mongoose.connection.db.admin().ping();
    } catch (error) {
      logError(`Reports API: Database health check failed - ${error.message}`);
      await connectDB();
    }
  }, 30000);
} catch (error) {
  logError(`Reports API: Database connection failed - ${error.message}`);
  process.exit(1);
}

// Routes with monitoring
app.use((req, res, next) => {
  logInfo(`Reports API: ${req.method} ${req.path}`);
  next();
});

app.use('/api/reports', reportsRoutes);

export default app;
