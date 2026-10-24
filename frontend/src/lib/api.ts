import {
  ApiResponse,
  AuthResponse,
  JobsResponse,
  ScheduleRequest,
  StatsResponse,
  CampaignListItem,
  CampaignDetail,
  CreateCampaignPayload,
  DryRunResponseData,
  CreateCampaignSuccessData,
  CampaignDraft,
  ResolveDraftPayload,
  ResolveDraftResponseData,
  BulkResolvePayload,
  BulkResolveResponseData,
  ApproveSamplesResponseData,
  CampaignStatusTransitionData,
} from "@/types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export class ApiError extends Error {
  public status: number;
  public code?: string;
  public details?: any;

  constructor(message: string, status: number, code?: string, details?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        response.statusText || "Request failed with non-JSON response",
        response.status
      );
    }

    if (!response.ok) {
      const errObj =
        typeof data?.error === "object" && data?.error !== null ? data.error : null;
      const message =
        errObj?.message ||
        (typeof data?.error === "string" ? data.error : data?.message || "Request failed");
      const code = errObj?.code || (typeof data?.error === "string" ? data.error : undefined);
      const details = errObj?.details;

      throw new ApiError(message, response.status, code, details);
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

  // ─── Campaigns (Phase 7b) ───

  async listCampaigns(
    limit = 20,
    cursor?: string
  ): Promise<ApiResponse<CampaignListItem[]>> {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);

    return this.request<CampaignListItem[]>(`/api/campaigns?${params.toString()}`);
  }

  async getCampaign(id: string): Promise<ApiResponse<CampaignDetail>> {
    return this.request<CampaignDetail>(`/api/campaigns/${encodeURIComponent(id)}`);
  }

  async createCampaign(
    payload: CreateCampaignPayload
  ): Promise<ApiResponse<CreateCampaignSuccessData | DryRunResponseData>> {
    return this.request<CreateCampaignSuccessData | DryRunResponseData>(
      "/api/campaigns",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
  }

  async startCampaign(
    id: string
  ): Promise<ApiResponse<CampaignStatusTransitionData>> {
    return this.request<CampaignStatusTransitionData>(
      `/api/campaigns/${encodeURIComponent(id)}/start`,
      { method: "POST" }
    );
  }

  async regenerateSamples(
    id: string,
    aiInstruction?: string | null
  ): Promise<ApiResponse<CampaignStatusTransitionData>> {
    return this.request<CampaignStatusTransitionData>(
      `/api/campaigns/${encodeURIComponent(id)}/samples/regenerate`,
      {
        method: "POST",
        body: JSON.stringify({ aiInstruction }),
      }
    );
  }

  async approveSamples(
    id: string,
    acknowledgeBudgetWarning?: boolean
  ): Promise<ApiResponse<ApproveSamplesResponseData>> {
    return this.request<ApproveSamplesResponseData>(
      `/api/campaigns/${encodeURIComponent(id)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ acknowledgeBudgetWarning }),
      }
    );
  }

  async pauseCampaign(
    id: string
  ): Promise<ApiResponse<CampaignStatusTransitionData>> {
    return this.request<CampaignStatusTransitionData>(
      `/api/campaigns/${encodeURIComponent(id)}/pause`,
      { method: "POST" }
    );
  }

  async resumeCampaign(
    id: string
  ): Promise<ApiResponse<CampaignStatusTransitionData>> {
    return this.request<CampaignStatusTransitionData>(
      `/api/campaigns/${encodeURIComponent(id)}/resume`,
      { method: "POST" }
    );
  }

  async cancelCampaign(
    id: string
  ): Promise<ApiResponse<CampaignStatusTransitionData>> {
    return this.request<CampaignStatusTransitionData>(
      `/api/campaigns/${encodeURIComponent(id)}/cancel`,
      { method: "POST" }
    );
  }

  async listDrafts(
    id: string,
    params?: {
      status?: string;
      isSample?: boolean;
      cursor?: string;
      limit?: number;
    }
  ): Promise<ApiResponse<CampaignDraft[]>> {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.isSample !== undefined)
      searchParams.set("isSample", String(params.isSample));
    if (params?.cursor) searchParams.set("cursor", params.cursor);
    if (params?.limit) searchParams.set("limit", String(params.limit));

    const qs = searchParams.toString();
    return this.request<CampaignDraft[]>(
      `/api/campaigns/${encodeURIComponent(id)}/drafts${qs ? `?${qs}` : ""}`
    );
  }

  async resolveDraft(
    id: string,
    draftId: string,
    action: ResolveDraftPayload
  ): Promise<ApiResponse<ResolveDraftResponseData>> {
    return this.request<ResolveDraftResponseData>(
      `/api/campaigns/${encodeURIComponent(id)}/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(action),
      }
    );
  }

  async bulkResolveDrafts(
    id: string,
    payload: BulkResolvePayload
  ): Promise<ApiResponse<BulkResolveResponseData>> {
    return this.request<BulkResolveResponseData>(
      `/api/campaigns/${encodeURIComponent(id)}/drafts/bulk`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
  }
}

export const api = new ApiClient(API_BASE);
