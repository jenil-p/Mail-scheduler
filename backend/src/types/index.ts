export interface ScheduleEmailInput {
  recipients: string[];
  subject: string;
  body: string;
  senderEmail: string;
  scheduledAt: string; // ISO 8601
  delayBetweenEmails?: number; // in ms
}

export interface RateLimitInfo {
  currentCount: number;
  maxAllowed: number;
  windowStart: number; // epoch ms
  windowEnd: number; // epoch ms
  /** Sliding window log: timestamps of sends in the current window */
  sendTimestamps?: number[];
}

export interface UserPayload {
  id: string;
  email: string;
  name: string;
  avatar?: string;
}

export interface AuthResponse {
  token: string;
  user: UserPayload;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
