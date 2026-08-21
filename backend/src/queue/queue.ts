import { Queue, QueueOptions } from "bullmq";
import Redis from "ioredis";
import { config } from "../config";

const connection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue("email-scheduler", {
  connection,
  defaultJobOptions: {
    // BullMQ will persist jobs to Redis — survives restarts
    removeOnComplete: {
      age: 24 * 3600, // keep completed jobs for 1 day
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // keep failed jobs for 7 days
    },
    attempts: 3, // retry up to 3 times
    backoff: {
      type: "exponential",
      delay: 5000, // 5s, then 10s, then 20s
    },
  },
} as QueueOptions);

export { connection as redisConnection };
