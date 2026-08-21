import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "8000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  // Database
  databaseUrl: process.env.DATABASE_URL!,

  // Redis
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
  },

  // Google OAuth
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL!,
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET!,
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },

  // Frontend
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",

  // Queue / Worker
  worker: {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || "5", 10),
    minDelayMs: parseInt(process.env.MIN_DELAY_MS || "2000", 10),
    maxEmailsPerHour: parseInt(process.env.MAX_EMAILS_PER_HOUR || "200", 10),
  },
};
