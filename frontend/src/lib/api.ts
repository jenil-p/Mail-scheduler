import { ApiResponse, AuthResponse, JobsResponse, ScheduleRequest, StatsResponse } from "@/types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private getToken(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    return data;
  }

  // ─── Auth ───

  async googleLogin(accessToken: string): Promise<ApiResponse<AuthResponse>> {
    return this.request<AuthResponse>("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ accessToken }),
    });
  }

  async getMe() {
    return this.request("/api/auth/me");
  }

  // ─── Schedule ───

  async scheduleEmails(data: ScheduleRequest) {
    return this.request("/api/schedule", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ─── Jobs ───

  async getJobs(status?: string, page = 1, limit = 20) {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    params.set("page", String(page));
    params.set("limit", String(limit));

    return this.request<JobsResponse>(`/api/jobs?${params.toString()}`);
  }

  async getStats() {
    return this.request<StatsResponse>("/api/jobs/stats");
  }
}

export const api = new ApiClient(API_BASE);
