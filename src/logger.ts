import fs from 'fs';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { getConfig } from './config';

function getLoggerConfig(): { NODE_ENV: string; LOG_LEVEL: string } {
  try {
    const config = getConfig();
    return {
      NODE_ENV: config.NODE_ENV,
      LOG_LEVEL: config.LOG_LEVEL,
    };
  } catch {
    return {
      NODE_ENV: process.env.NODE_ENV || 'production',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    };
  }
}

const config = getLoggerConfig();

const logDir = path.resolve(process.cwd(), 'logs');

const transports: winston.transport[] = [];

if (config.NODE_ENV === 'production') {
  // Ensure log directory exists (synchronous)
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.error('Failed to create log directory:', err);
  }

  // Daily rotate file
  transports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level: config.LOG_LEVEL,
      zippedArchive: true,
      createSymlink: true,
      symlinkName: 'bot-current.log',
      format: winston.format.json(),
    })
  );
} else {
  // In development, just stdout with pretty format
}

transports.push(
  new winston.transports.Console({
    format: config.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            // Safely stringify meta, converting bigint to string to avoid TypeError
            const metaString = Object.keys(meta).length
              ? JSON.stringify(meta, (_, value) =>
                  typeof value === 'bigint' ? value.toString() : value
                )
              : '';
            return `${timestamp} [${level.toUpperCase()}] ${message} ${metaString}`;
          })
        ),
    level: config.LOG_LEVEL,
  })
);

const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true })
  ),
  transports,
  exceptionHandlers: transports,
  rejectionHandlers: transports,
});

export type Logger = typeof logger;

export default logger;
