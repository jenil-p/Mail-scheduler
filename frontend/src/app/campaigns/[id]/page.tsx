"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  CampaignDetail,
  CampaignDraft,
  CampaignStatus,
} from "@/types";
import { api, ApiError } from "@/lib/api";
import { AuthGuard } from "@/components/campaigns/AuthGuard";
import { Header } from "@/components/Header";
import { CampaignStatusBadge, DraftStatusBadge } from "@/components/campaigns/CampaignStatusBadge";
import { LifecycleStepper } from "@/components/campaigns/LifecycleStepper";
import { EmailPreview } from "@/components/campaigns/EmailPreview";
import { ConfirmDialog } from "@/components/campaigns/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import {
  getAvailableActionsForStatus,
  getReviewDeadline,
  getMsUntilReviewDeadline,
  formatCountdown,
  getUnresolvedPolicyDescription,
  getStartConfirmMessage,
  CANCEL_CONFIRM_MESSAGE,
} from "@/lib/campaignLifecycle";
import {
  mapApiErrorCodeToMessage,
  mapGuardrailCodeToSentence,
  isDraftHardBlocked,
  getHardBlockExplanation,
} from "@/lib/campaignErrors";
import { nextPollDelayMs } from "@/lib/campaignPolling";

export default function CampaignDetailPage() {
  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : (params?.id as string);

  return (
    <AuthGuard>
      {(user, logout) => (
        <CampaignDetailView campaignId={id} user={user} onLogout={logout} />
      )}
    </AuthGuard>
  );
}

function CampaignDetailView({
  campaignId,
  user,
  onLogout,
}: {
  campaignId: string;
  user: any;
  onLogout: () => void;
}) {
  const router = useRouter();

  // Campaign State
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Active action loading states
  const [isStarting, setIsStarting] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Dialog states
  const [showStartConfirm, setShowStartConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [budgetWarning, setBudgetWarning] = useState<{
    needed: number;
    remaining: number;
  } | null>(null);

  // Sample Review State
  const [sampleDrafts, setSampleDrafts] = useState<CampaignDraft[]>([]);
  const [sampleInstruction, setSampleInstruction] = useState("");
  const [loadingSamples, setLoadingSamples] = useState(false);

  // Exception Review State
  const [flaggedDrafts, setFlaggedDrafts] = useState<CampaignDraft[]>([]);
  const [loadingFlagged, setLoadingFlagged] = useState(false);
  const [flaggedCursor, setFlaggedCursor] = useState<string | undefined>(undefined);
  const [hasMoreFlagged, setHasMoreFlagged] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editingIntro, setEditingIntro] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [resolvingDraftId, setResolvingDraftId] = useState<string | null>(null);
  const [isBulkResolving, setIsBulkResolving] = useState(false);

  // Review Countdown State
  const [countdownText, setCountdownText] = useState<string>("");

  // Polling Refs
  const isPollingRef = useRef(false);
  const hasPollErrorRef = useRef(false);
  const isHiddenRef = useRef(false);
  const stoppedRef = useRef(false);
  const requestCounterRef = useRef(0);

  // Load campaign data from API
  const fetchCampaign = useCallback(
    async (isBackground = false, isCancelled?: () => boolean) => {
      const requestId = ++requestCounterRef.current;
      if (!isBackground) {
        setInitialLoading(true);
        setLoadError(null);
      }
      try {
        const res = await api.getCampaign(campaignId);
        if (requestId !== requestCounterRef.current || isCancelled?.()) {
          return;
        }
        const data = res.data;
        if (data) {
          setCampaign(data);
          hasPollErrorRef.current = false;
          // Set instruction editor if not yet set
          setSampleInstruction((prev) => (prev ? prev : data.aiInstruction || ""));
        }
      } catch (err: any) {
        if (requestId !== requestCounterRef.current || isCancelled?.()) {
          return;
        }
        hasPollErrorRef.current = true;
        const isAuthOrNotFound =
          err instanceof ApiError && (err.status === 401 || err.status === 404);
        if (isAuthOrNotFound) {
          stoppedRef.current = true;
        }
        const msg =
          err instanceof ApiError
            ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
            : err.message || "Failed to load campaign";
        if (!isBackground || isAuthOrNotFound) {
          setLoadError(msg);
        }
      } finally {
        if (requestId === requestCounterRef.current && !isCancelled?.()) {
          if (!isBackground) {
            setInitialLoading(false);
          }
        }
      }
    },
    [campaignId]
  );

  // Initial load
  useEffect(() => {
    fetchCampaign(false);
  }, [fetchCampaign]);

  // Polling Effect: 5s base, 15s on hidden tab or error, stops on terminal states or unmount
  useEffect(() => {
    if (!campaign || stoppedRef.current) return;

    const { shouldPoll } = getAvailableActionsForStatus(
      campaign.status,
      campaign.aiEnabled
    );
    if (!shouldPoll) return;

    let cancelled = false;
    let timerId: NodeJS.Timeout | null = null;

    const handleVisibilityChange = () => {
      isHiddenRef.current = document.visibilityState === "hidden";
      if (!isHiddenRef.current && !cancelled && !stoppedRef.current) {
        // Tab became visible again; immediately refresh
        fetchCampaign(true, () => cancelled);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    const scheduleNextPoll = () => {
      if (cancelled || stoppedRef.current) return;
      const delay = nextPollDelayMs({
        hidden: isHiddenRef.current,
        hadError: hasPollErrorRef.current,
      });

      timerId = setTimeout(async () => {
        if (cancelled || stoppedRef.current) return;
        if (!isPollingRef.current) {
          isPollingRef.current = true;
          try {
            await fetchCampaign(true, () => cancelled);
          } finally {
            isPollingRef.current = false;
          }
        }
        if (cancelled || stoppedRef.current) return;
        scheduleNextPoll();
      }, delay);
    };

    scheduleNextPoll();

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [campaign?.status, campaign?.aiEnabled, fetchCampaign]);

  // Review Countdown Timer effect
  useEffect(() => {
    if (campaign?.status !== "EXCEPTION_REVIEW" || !campaign?.scheduledAt) {
      return;
    }

    const updateCountdown = () => {
      const ms = getMsUntilReviewDeadline(campaign.scheduledAt);
      setCountdownText(formatCountdown(ms));
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [campaign?.status, campaign?.scheduledAt]);

  // Load sample drafts when in SAMPLE_REVIEW
  const loadSamples = useCallback(async () => {
    setLoadingSamples(true);
    try {
      const res = await api.listDrafts(campaignId, { isSample: true, limit: 50 });
      setSampleDrafts(res.data || []);
    } catch (err: any) {
      // Do not log recipient details
      setActionError("Failed to load sample previews.");
    } finally {
      setLoadingSamples(false);
    }
  }, [campaignId]);

  useEffect(() => {
    if (campaign?.status === "SAMPLE_REVIEW") {
      loadSamples();
    }
  }, [campaign?.status, loadSamples]);

  // Load flagged drafts when in EXCEPTION_REVIEW
  const loadFlaggedDrafts = useCallback(
    async (cursor?: string) => {
      setLoadingFlagged(true);
      try {
        const res = await api.listDrafts(campaignId, {
          status: "FLAGGED",
          cursor,
          limit: 20,
        });
        const items = res.data || [];
        if (cursor) {
          setFlaggedDrafts((prev) => [...prev, ...items]);
        } else {
          setFlaggedDrafts(items);
        }
        setHasMoreFlagged(items.length === 20);
        if (items.length > 0) {
          setFlaggedCursor(items[items.length - 1].id);
        }
      } catch (err: any) {
        setActionError("Failed to load flagged drafts.");
      } finally {
        setLoadingFlagged(false);
      }
    },
    [campaignId]
  );

  useEffect(() => {
    if (campaign?.status === "EXCEPTION_REVIEW") {
      loadFlaggedDrafts();
    }
  }, [campaign?.status, loadFlaggedDrafts]);

  // ─── Actions ───

  // Start Campaign
  const handleStartCampaign = async () => {
    setIsStarting(true);
    setActionError(null);
    try {
      await api.startCampaign(campaignId);
      setShowStartConfirm(false);
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to start campaign";
      setActionError(msg);
      setShowStartConfirm(false);
    } finally {
      setIsStarting(false);
    }
  };

  // Pause Campaign
  const handlePauseCampaign = async () => {
    setIsPausing(true);
    setActionError(null);
    try {
      await api.pauseCampaign(campaignId);
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to pause campaign";
      setActionError(msg);
    } finally {
      setIsPausing(false);
    }
  };

  // Resume Campaign
  const handleResumeCampaign = async () => {
    setIsResuming(true);
    setActionError(null);
    try {
      await api.resumeCampaign(campaignId);
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to resume campaign";
      setActionError(msg);
    } finally {
      setIsResuming(false);
    }
  };

  // Cancel Campaign
  const handleCancelCampaign = async () => {
    setIsCancelling(true);
    setActionError(null);
    try {
      await api.cancelCampaign(campaignId);
      setShowCancelConfirm(false);
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to cancel campaign";
      setActionError(msg);
      setShowCancelConfirm(false);
    } finally {
      setIsCancelling(false);
    }
  };

  // Regenerate Samples
  const handleRegenerateSamples = async () => {
    setIsRegenerating(true);
    setActionError(null);
    try {
      await api.regenerateSamples(campaignId, sampleInstruction);
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to regenerate samples";
      setActionError(msg);
    } finally {
      setIsRegenerating(false);
    }
  };

  // Approve Samples (Full Generation)
  const handleApproveSamples = async (acknowledgeBudgetWarning = false) => {
    setIsApproving(true);
    setActionError(null);
    try {
      await api.approveSamples(campaignId, acknowledgeBudgetWarning);
      setBudgetWarning(null);
      await fetchCampaign(true);
    } catch (err: any) {
      if (err instanceof ApiError && err.code === "BUDGET_WARNING" && err.details) {
        setBudgetWarning({
          needed: err.details.needed,
          remaining: err.details.remaining,
        });
      } else {
        const msg =
          err instanceof ApiError
            ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
            : err.message || "Failed to approve samples";
        setActionError(msg);
      }
    } finally {
      setIsApproving(false);
    }
  };

  // Resolve Single Draft (Approve or Use Plain)
  const handleResolveDraft = async (
    draftId: string,
    action: { type: "approve" } | { type: "use_plain" }
  ) => {
    setResolvingDraftId(draftId);
    setActionError(null);
    try {
      await api.resolveDraft(campaignId, draftId, action);
      // Remove or update draft from local state
      setFlaggedDrafts((prev) => prev.filter((d) => d.id !== draftId));
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to resolve draft";
      setActionError(msg);
    } finally {
      setResolvingDraftId(null);
    }
  };

  // Save Edited Intro for Single Draft
  const handleSaveEditIntro = async (draftId: string) => {
    setIsSavingEdit(true);
    setActionError(null);
    try {
      const res = await api.resolveDraft(campaignId, draftId, {
        type: "edit",
        aiIntro: editingIntro,
      });

      if (res.data?.status === "APPROVED") {
        // Successfully resolved
        setFlaggedDrafts((prev) => prev.filter((d) => d.id !== draftId));
        setEditingDraftId(null);
        setActionSuccess("Sentence approved successfully.");
      } else {
        // Still flagged; update flag reasons in UI
        setFlaggedDrafts((prev) =>
          prev.map((d) =>
            d.id === draftId
              ? {
                  ...d,
                  aiIntro: editingIntro,
                  status: res.data?.status || "FLAGGED",
                  flagReasons: res.data?.flagReasons ?? [],
                }
              : d
          )
        );
        setActionError(
          "Sentence updated, but it still triggers guardrail violations. Please review the updated flags below."
        );
      }
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to save edited sentence";
      setActionError(msg);
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Bulk Resolve Drafts
  const handleBulkResolve = async (type: "approve" | "use_plain") => {
    setIsBulkResolving(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const res = await api.bulkResolveDrafts(campaignId, { type });
      const changed = res.data?.changed || 0;
      const skipped = res.data?.skippedHardBlocked || 0;

      if (type === "approve") {
        setActionSuccess(
          `Approved ${changed} draft(s). ${
            skipped > 0
              ? `${skipped} draft(s) were skipped because they contain hard-blocked violations.`
              : ""
          }`
        );
      } else {
        setActionSuccess(`Converted ${changed} draft(s) to plain template.`);
      }

      // Reload flagged drafts and campaign summary
      await loadFlaggedDrafts();
      await fetchCampaign(true);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Bulk resolution failed";
      setActionError(msg);
    } finally {
      setIsBulkResolving(false);
    }
  };

  // Initial Loading View
  if (initialLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header user={user} onLogout={onLogout} />
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="card p-8 animate-pulse space-y-4">
            <div className="h-6 w-1/3 bg-gray-200 rounded" />
            <div className="h-4 w-1/4 bg-gray-200 rounded" />
            <div className="h-24 bg-gray-100 rounded" />
          </div>
        </main>
      </div>
    );
  }

  // Not Found / Error View
  if (loadError || !campaign) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header user={user} onLogout={onLogout} />
        <main className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8 text-center">
          <div className="card p-12 max-w-lg mx-auto">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900">Campaign Not Found</h2>
            <p className="mt-2 text-sm text-gray-500">
              {loadError || "The requested campaign does not exist or you do not have permission to view it."}
            </p>
            <div className="mt-6">
              <Link href="/campaigns" className="btn-primary">
                Return to Campaigns
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const actions = getAvailableActionsForStatus(campaign.status, campaign.aiEnabled);

  // Draft counts calculations
  const totalDrafts = campaign.recipientCount || 0;
  const draftCounts = campaign.draftCounts || {
    PENDING: 0,
    GENERATING: 0,
    READY: 0,
    FLAGGED: 0,
    FALLBACK: 0,
    APPROVED: 0,
    HELD: 0,
    QUEUED: 0,
  };
  const completedDrafts =
    draftCounts.READY + draftCounts.APPROVED + draftCounts.FALLBACK + draftCounts.QUEUED;
  const draftPercent =
    totalDrafts > 0 ? Math.min(100, Math.round((completedDrafts / totalDrafts) * 100)) : 0;

  // Send counts calculations
  const sendCounts = campaign.sendCounts || {
    pending: 0,
    rate_limited: 0,
    sent: 0,
    failed: 0,
  };
  const totalSentOrFailed = sendCounts.sent + sendCounts.failed;
  const sendPercent =
    totalDrafts > 0
      ? Math.min(100, Math.round((totalSentOrFailed / totalDrafts) * 100))
      : 0;

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <Header user={user} onLogout={onLogout} />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Navigation Breadcrumb */}
        <div className="mb-4">
          <Link
            href="/campaigns"
            className="text-xs font-semibold text-gray-500 hover:text-gray-900 inline-flex items-center gap-1.5"
          >
            &larr; Back to campaigns
          </Link>
        </div>

        {/* Status Header */}
        <div className="card p-6 mb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight text-gray-900">
                  {campaign.name}
                </h1>
                <CampaignStatusBadge status={campaign.status} />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500">
                <span>
                  Recipients:{" "}
                  <strong className="text-gray-900 font-semibold">
                    {campaign.recipientCount.toLocaleString()}
                  </strong>
                </span>
                <span>
                  Scheduled:{" "}
                  <strong className="text-gray-900 font-semibold">
                    {new Date(campaign.scheduledAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </strong>
                </span>
                <span>
                  Mode:{" "}
                  <strong className="text-gray-900 font-semibold">
                    {campaign.aiEnabled ? "AI Personalized" : "Plain Template"}
                  </strong>
                </span>
                <span>
                  Policy:{" "}
                  <strong className="text-gray-900 font-semibold">
                    {campaign.onUnresolved === "FALLBACK_TO_PLAIN"
                      ? "Fallback to Plain"
                      : "Hold (Do Not Send)"}
                  </strong>
                </span>
              </div>
            </div>

            {/* Lifecycle Primary Action Button */}
            <div className="flex items-center gap-2">
              {actions.canStart && (
                <Button
                  variant="primary"
                  onClick={() => setShowStartConfirm(true)}
                  loading={isStarting}
                >
                  Start campaign
                </Button>
              )}

              {actions.canPause && (
                <Button
                  variant="secondary"
                  onClick={handlePauseCampaign}
                  loading={isPausing}
                >
                  Pause
                </Button>
              )}

              {actions.canResume && (
                <Button
                  variant="primary"
                  onClick={handleResumeCampaign}
                  loading={isResuming}
                >
                  Resume
                </Button>
              )}

              {actions.canCancel && (
                <Button
                  variant="danger"
                  onClick={() => setShowCancelConfirm(true)}
                  loading={isCancelling}
                >
                  Cancel campaign
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Error / Notice Banners */}
        {campaign.errorMessage && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 shadow-xs">
            <div className="flex items-start gap-3">
              <svg
                className="h-5 w-5 text-red-600 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
              <div>
                <h4 className="text-sm font-bold text-red-900">Campaign Notice</h4>
                <p className="text-sm text-red-800 mt-0.5">{campaign.errorMessage}</p>
              </div>
            </div>
          </div>
        )}

        {actionError && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <svg
                  className="h-5 w-5 text-amber-600 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p className="text-sm font-medium text-amber-900">{actionError}</p>
              </div>
              <button
                onClick={() => setActionError(null)}
                className="text-xs font-semibold text-amber-800 hover:text-amber-950"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {actionSuccess && (
          <div className="mb-6 rounded-xl border border-green-200 bg-green-50 p-4 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <svg
                  className="h-5 w-5 text-green-600 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-sm font-medium text-green-900">{actionSuccess}</p>
              </div>
              <button
                onClick={() => setActionSuccess(null)}
                className="text-xs font-semibold text-green-800 hover:text-green-950"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Stepper Timeline */}
        <LifecycleStepper
          status={campaign.status}
          aiEnabled={campaign.aiEnabled}
        />

        {/* Progress Bars & Execution Summary */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Draft Generation Progress */}
          <div className="card p-5">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                Draft Preparation
              </span>
              <span className="text-xs font-bold text-gray-900">
                {completedDrafts} / {totalDrafts} ({draftPercent}%)
              </span>
            </div>

            <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-primary-600 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${draftPercent}%` }}
              />
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              <div className="bg-gray-50 rounded p-1.5 border border-gray-100">
                <span className="text-gray-500 block">Pending</span>
                <span className="font-bold text-gray-900">{draftCounts.PENDING}</span>
              </div>
              <div className="bg-blue-50 rounded p-1.5 border border-blue-100">
                <span className="text-blue-600 block">Generating</span>
                <span className="font-bold text-blue-900">{draftCounts.GENERATING}</span>
              </div>
              <div className="bg-amber-50 rounded p-1.5 border border-amber-100">
                <span className="text-amber-700 block">Flagged</span>
                <span className="font-bold text-amber-900">{draftCounts.FLAGGED}</span>
              </div>
              <div className="bg-green-50 rounded p-1.5 border border-green-100">
                <span className="text-green-700 block">Ready / OK</span>
                <span className="font-bold text-green-900">
                  {draftCounts.READY + draftCounts.APPROVED + draftCounts.FALLBACK}
                </span>
              </div>
            </div>
          </div>

          {/* Send Dispatch Progress */}
          <div className="card p-5">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                Send Progress
              </span>
              <span className="text-xs font-bold text-gray-900">
                {sendCounts.sent} / {totalDrafts} ({sendPercent}%)
              </span>
            </div>

            <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-green-600 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${sendPercent}%` }}
              />
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              <div className="bg-yellow-50 rounded p-1.5 border border-yellow-100">
                <span className="text-yellow-700 block">Queue</span>
                <span className="font-bold text-yellow-900">{sendCounts.pending}</span>
              </div>
              <div className="bg-orange-50 rounded p-1.5 border border-orange-100">
                <span className="text-orange-700 block">Rate Limited</span>
                <span className="font-bold text-orange-900">{sendCounts.rate_limited}</span>
              </div>
              <div className="bg-green-50 rounded p-1.5 border border-green-100">
                <span className="text-green-700 block">Sent</span>
                <span className="font-bold text-green-900">{sendCounts.sent}</span>
              </div>
              <div className="bg-red-50 rounded p-1.5 border border-red-100">
                <span className="text-red-700 block">Failed</span>
                <span className="font-bold text-red-900">{sendCounts.failed}</span>
              </div>
            </div>

            <p className="mt-2.5 text-[11px] text-gray-500 italic">
              Sending is paced by the sender's hourly limit.
            </p>
          </div>
        </div>

        {/* ─── STATUS-SPECIFIC VIEWS ─── */}

        {/* 1. SAMPLING & GENERATING Active Views */}
        {(campaign.status === "SAMPLING" || campaign.status === "GENERATING") && (
          <div className="card p-8 text-center my-6">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-50">
              <svg
                className="h-8 w-8 animate-spin text-primary-600"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900">
              {campaign.status === "SAMPLING"
                ? "Generating AI Sample Drafts..."
                : "Personalizing All Campaign Drafts..."}
            </h3>
            <p className="mt-1 text-sm text-gray-500 max-w-md mx-auto">
              Our AI worker is crafting personalized email openings based on recipient data.
              This page updates automatically.
            </p>
            <div className="mt-5">
              <Button
                variant="secondary"
                onClick={handlePauseCampaign}
                loading={isPausing}
              >
                Pause generation
              </Button>
            </div>
          </div>
        )}

        {/* 2. SAMPLE_REVIEW View */}
        {campaign.status === "SAMPLE_REVIEW" && (
          <div className="space-y-6">
            <div className="card p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-gray-100 pb-4 mb-4 gap-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">
                    Sample Review & Instruction Tuning
                  </h3>
                  <p className="text-xs text-gray-500">
                    Review generated sample drafts below. You can tune your prompt instruction
                    and regenerate samples, or approve them to generate the entire campaign.
                  </p>
                </div>

                <Button
                  variant="primary"
                  onClick={() => handleApproveSamples(false)}
                  loading={isApproving}
                  className="shrink-0"
                >
                  Approve and generate
                </Button>
              </div>

              {/* Editable instruction textarea */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-semibold uppercase tracking-wider text-gray-700">
                    AI Instruction
                  </label>
                  <span
                    className={`text-xs ${
                      sampleInstruction.length > 500
                        ? "text-red-600 font-bold"
                        : "text-gray-500"
                    }`}
                  >
                    {sampleInstruction.length} / 500 characters
                  </span>
                </div>
                <textarea
                  value={sampleInstruction}
                  onChange={(e) => setSampleInstruction(e.target.value)}
                  rows={3}
                  maxLength={500}
                  className="input-field"
                  placeholder="Tune instruction for AI intro generation..."
                />
                <div className="flex justify-end pt-1">
                  <Button
                    variant="secondary"
                    onClick={handleRegenerateSamples}
                    loading={isRegenerating}
                    size="sm"
                  >
                    Regenerate samples
                  </Button>
                </div>
              </div>
            </div>

            {/* Sample Previews */}
            <div className="space-y-4">
              <h4 className="text-sm font-bold uppercase tracking-wider text-gray-700">
                Generated Sample Previews ({sampleDrafts.length})
              </h4>

              {loadingSamples ? (
                <div className="card p-8 text-center text-sm text-gray-500 animate-pulse">
                  Loading sample previews...
                </div>
              ) : sampleDrafts.length === 0 ? (
                <div className="card p-8 text-center text-sm text-gray-500">
                  No sample drafts available.
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {sampleDrafts.map((draft) => (
                    <div key={draft.id} className="card p-5 space-y-3">
                      <div className="flex items-center justify-between border-b border-gray-100 pb-2">
                        <span className="text-xs font-semibold text-gray-900">
                          To: {draft.recipientEmail}{" "}
                          {draft.recipientFirstName ? `(${draft.recipientFirstName})` : ""}
                        </span>
                        <DraftStatusBadge status={draft.status} />
                      </div>

                      <EmailPreview
                        subject={draft.subject}
                        body={draft.body}
                        aiIntro={draft.aiIntro}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. EXCEPTION_REVIEW View */}
        {campaign.status === "EXCEPTION_REVIEW" && (
          <div className="space-y-6">
            {/* Review Deadline Banner */}
            <div className="card p-5 bg-amber-50/50 border-amber-200">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <svg
                      className="h-5 w-5 text-amber-700"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <h3 className="text-base font-bold text-amber-950">
                      Exception Review Deadline: {countdownText}
                    </h3>
                  </div>
                  <p className="mt-1 text-xs text-amber-900">
                    Review deadline is 2 minutes prior to scheduled start time (
                    {getReviewDeadline(campaign.scheduledAt).toLocaleTimeString()}).{" "}
                    {getUnresolvedPolicyDescription(campaign.onUnresolved)}
                  </p>
                </div>

                {/* Bulk Action Buttons */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleBulkResolve("approve")}
                    loading={isBulkResolving}
                  >
                    Approve all approvable
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleBulkResolve("use_plain")}
                    loading={isBulkResolving}
                  >
                    Use plain email for all
                  </Button>
                </div>
              </div>
            </div>

            {/* Flagged Drafts List */}
            <div className="space-y-4">
              <h4 className="text-sm font-bold uppercase tracking-wider text-gray-700">
                Flagged Drafts Needing Review ({draftCounts.FLAGGED})
              </h4>

              {loadingFlagged && flaggedDrafts.length === 0 ? (
                <div className="card p-8 text-center text-sm text-gray-500 animate-pulse">
                  Loading flagged drafts...
                </div>
              ) : flaggedDrafts.length === 0 ? (
                <div className="card p-8 text-center text-sm text-gray-500">
                  No flagged drafts remaining. All drafts have been resolved!
                </div>
              ) : (
                <div className="space-y-4">
                  {flaggedDrafts.map((draft) => {
                    const isHardBlocked = isDraftHardBlocked(draft.flagReasons ?? []);
                    const hardBlockExplanation = getHardBlockExplanation(draft.flagReasons ?? []);
                    const isEditing = editingDraftId === draft.id;

                    return (
                      <div
                        key={draft.id}
                        className="card p-5 border-l-4 border-l-amber-500 space-y-4"
                      >
                        {/* Draft Header */}
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-gray-100 pb-3 gap-2">
                          <div>
                            <span className="font-semibold text-sm text-gray-900">
                              Recipient: {draft.recipientEmail}
                            </span>
                            {draft.recipientFirstName && (
                              <span className="text-xs text-gray-500 ml-2">
                                ({draft.recipientFirstName})
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {isHardBlocked && (
                              <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                                Hard Blocked
                              </span>
                            )}
                            <DraftStatusBadge status={draft.status} />
                          </div>
                        </div>

                        {/* Guardrail Flag Reasons */}
                        <div className="rounded-lg bg-amber-50 p-3 border border-amber-200">
                          <p className="text-xs font-bold uppercase tracking-wider text-amber-900 mb-1">
                            Flag Reasons:
                          </p>
                          <ul className="list-disc pl-5 space-y-0.5 text-xs text-amber-900">
                            {(draft.flagReasons ?? []).map((f, i) => (
                              <li key={i}>
                                <span className="font-semibold">[{f.code}] </span>
                                {mapGuardrailCodeToSentence(f.code)}
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* AI Sentence / Editing Section */}
                        {isEditing ? (
                          <div className="space-y-2 rounded-lg bg-gray-50 p-3.5 border border-gray-200">
                            <div className="flex justify-between items-center">
                              <label className="text-xs font-semibold text-gray-700">
                                Edit Intro Sentence
                              </label>
                              <span className="text-xs text-gray-500">
                                {editingIntro.length} characters
                              </span>
                            </div>
                            <textarea
                              value={editingIntro}
                              onChange={(e) => setEditingIntro(e.target.value)}
                              rows={2}
                              className="input-field"
                            />
                            <div className="flex justify-end gap-2 pt-1">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setEditingDraftId(null)}
                                disabled={isSavingEdit}
                              >
                                Cancel
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => handleSaveEditIntro(draft.id)}
                                loading={isSavingEdit}
                              >
                                Save & Re-evaluate
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg bg-purple-50/60 p-3 border border-purple-100">
                            <span className="text-xs font-semibold uppercase tracking-wider text-purple-900 block mb-1">
                              AI Intro Sentence:
                            </span>
                            <p className="text-sm font-medium text-purple-950 italic">
                              "{draft.aiIntro}"
                            </p>
                          </div>
                        )}

                        {/* Email Preview Accordion/Card */}
                        <EmailPreview
                          subject={draft.subject}
                          body={draft.body}
                        />

                        {/* Action Buttons for this row */}
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pt-2 border-t border-gray-100 gap-3">
                          <div className="text-xs text-gray-500 max-w-md">
                            {isHardBlocked && (
                              <span className="text-red-700 font-medium">
                                {hardBlockExplanation}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 self-end sm:self-auto">
                            {!isEditing && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  setEditingDraftId(draft.id);
                                  setEditingIntro(draft.aiIntro || "");
                                }}
                              >
                                Edit sentence
                              </Button>
                            )}

                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                handleResolveDraft(draft.id, { type: "use_plain" })
                              }
                              loading={resolvingDraftId === draft.id}
                            >
                              Use plain email
                            </Button>

                            <Button
                              variant="primary"
                              size="sm"
                              disabled={isHardBlocked}
                              onClick={() =>
                                handleResolveDraft(draft.id, { type: "approve" })
                              }
                              loading={resolvingDraftId === draft.id}
                              title={
                                isHardBlocked
                                  ? "Cannot approve draft with hard-blocked violations"
                                  : undefined
                              }
                            >
                              Approve
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Load more flagged */}
                  {hasMoreFlagged && (
                    <div className="text-center pt-2">
                      <Button
                        variant="secondary"
                        onClick={() => loadFlaggedDrafts(flaggedCursor)}
                        loading={loadingFlagged}
                      >
                        Load more flagged drafts
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 4. SCHEDULED & SENDING Info */}
        {(campaign.status === "SCHEDULED" || campaign.status === "SENDING") && (
          <div className="card p-6 text-center space-y-3">
            <h3 className="text-lg font-bold text-gray-900">
              {campaign.status === "SCHEDULED"
                ? "Campaign Scheduled"
                : "Campaign is Sending"}
            </h3>
            <p className="text-sm text-gray-600 max-w-lg mx-auto">
              {campaign.status === "SCHEDULED"
                ? `Emails are enqueued and will start sending automatically at ${new Date(
                    campaign.scheduledAt
                  ).toLocaleString()}.`
                : "Emails are currently being sent to recipients, throttled to respect the hourly provider rate limit."}
            </p>
          </div>
        )}

        {/* 5. PAUSED Notice */}
        {campaign.status === "PAUSED" && (
          <div className="card p-6 border-amber-300 bg-amber-50/20 text-center space-y-3">
            <h3 className="text-lg font-bold text-amber-950">
              Campaign Execution is Paused
            </h3>
            <p className="text-sm text-amber-900 max-w-lg mx-auto">
              Background generation has been stopped. Click "Resume" to continue generation,
              or "Cancel campaign" if you wish to terminate it.
            </p>
            <div className="pt-2">
              <Button
                variant="primary"
                onClick={handleResumeCampaign}
                loading={isResuming}
              >
                Resume Campaign
              </Button>
            </div>
          </div>
        )}

        {/* 6. COMPLETED or CANCELLED Read-Only Info */}
        {(campaign.status === "COMPLETED" || campaign.status === "CANCELLED") && (
          <div className="card p-6 text-center space-y-2">
            <h3 className="text-lg font-bold text-gray-900">
              {campaign.status === "COMPLETED"
                ? "Campaign Finished"
                : "Campaign Cancelled"}
            </h3>
            <p className="text-sm text-gray-500">
              This campaign is in a terminal state and is read-only.
            </p>
          </div>
        )}
      </main>

      {/* Start Campaign Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showStartConfirm}
        onClose={() => setShowStartConfirm(false)}
        onConfirm={handleStartCampaign}
        title="Start Campaign"
        message={getStartConfirmMessage({
          aiEnabled: campaign.aiEnabled,
          recipientCount: campaign.recipientCount,
          scheduledAtFormatted: new Date(campaign.scheduledAt).toLocaleString(),
        })}
        confirmLabel="Confirm and Start"
        loading={isStarting}
      />

      {/* Cancel Campaign Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={handleCancelCampaign}
        title="Cancel Campaign"
        message={CANCEL_CONFIRM_MESSAGE}
        confirmLabel="Yes, Cancel Campaign"
        variant="danger"
        loading={isCancelling}
      />

      {/* Budget Warning Dialog (409 BUDGET_WARNING) */}
      <ConfirmDialog
        isOpen={budgetWarning !== null}
        onClose={() => setBudgetWarning(null)}
        onConfirm={() => handleApproveSamples(true)}
        title="Daily Generation Budget Warning"
        message={
          budgetWarning ? (
            <div>
              <p className="mb-2">
                This campaign requires <strong>{budgetWarning.needed}</strong> AI
                generations, but only <strong>{budgetWarning.remaining}</strong> remain in
                today's daily quota.
              </p>
              <p className="text-xs text-gray-500">
                If you continue, drafts beyond the quota limit will automatically fall back
                to the plain email template without an AI intro.
              </p>
            </div>
          ) : (
            ""
          )
        }
        confirmLabel="Continue Anyway"
        variant="primary"
        loading={isApproving}
      />
    </div>
  );
}
