// ─── User & Auth ───

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

// ─── Email Jobs ───

export type EmailStatus = "pending" | "sent" | "failed" | "rate_limited";

export interface EmailJob {
  id: string;
  userId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  senderEmail: string;
  scheduledAt: string;
  status: EmailStatus;
  sentAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── API Responses ───

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface JobsResponse {
  jobs: EmailJob[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface StatsResponse {
  pending: number;
  sent: number;
  failed: number;
  rateLimited: number;
  total: number;
}

// ─── Schedule Request ───

export interface ScheduleRequest {
  recipients: string[];
  subject: string;
  body: string;
  senderEmail: string;
  scheduledAt: string;
  delayBetweenEmails?: number;
}

// ─── UI State ───

export type TabType = "scheduled" | "sent";
