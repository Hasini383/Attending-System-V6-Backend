import express from 'express';
import { connectDB } from '../config/database.js';
import mongoose from 'mongoose';
import cors from 'cors';

const app = express();

app.use(cors());

app.get('/api/health', async (req, res) => {
  await connectDB();
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    environment: process.env.NODE_ENV,
    version: process.version
  });
});

export default app;
