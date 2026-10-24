"use client";

import React from "react";
import { CampaignStatus, DraftStatus } from "@/types/campaigns";

interface CampaignStatusBadgeProps {
  status: CampaignStatus;
}

const statusConfig: Record<
  CampaignStatus,
  { label: string; bg: string; text: string; ring: string; dot?: string }
> = {
  DRAFT: {
    label: "Draft",
    bg: "bg-gray-50",
    text: "text-gray-700",
    ring: "ring-gray-600/20",
  },
  SAMPLING: {
    label: "Sampling",
    bg: "bg-blue-50",
    text: "text-blue-700",
    ring: "ring-blue-600/20",
    dot: "bg-blue-500 animate-pulse",
  },
  SAMPLE_REVIEW: {
    label: "Sample Review",
    bg: "bg-purple-50",
    text: "text-purple-700",
    ring: "ring-purple-600/20",
  },
  GENERATING: {
    label: "Generating",
    bg: "bg-indigo-50",
    text: "text-indigo-700",
    ring: "ring-indigo-600/20",
    dot: "bg-indigo-500 animate-pulse",
  },
  EXCEPTION_REVIEW: {
    label: "Exception Review",
    bg: "bg-amber-50",
    text: "text-amber-800",
    ring: "ring-amber-600/20",
  },
  SCHEDULED: {
    label: "Scheduled",
    bg: "bg-sky-50",
    text: "text-sky-700",
    ring: "ring-sky-600/20",
  },
  SENDING: {
    label: "Sending",
    bg: "bg-yellow-50",
    text: "text-yellow-800",
    ring: "ring-yellow-600/20",
    dot: "bg-yellow-500 animate-ping",
  },
  PAUSED: {
    label: "Paused",
    bg: "bg-stone-100",
    text: "text-stone-700",
    ring: "ring-stone-600/20",
  },
  COMPLETED: {
    label: "Completed",
    bg: "bg-green-50",
    text: "text-green-700",
    ring: "ring-green-600/20",
  },
  CANCELLED: {
    label: "Cancelled",
    bg: "bg-red-50",
    text: "text-red-700",
    ring: "ring-red-600/20",
  },
};

export function CampaignStatusBadge({ status }: CampaignStatusBadgeProps) {
  const config = statusConfig[status] || {
    label: status,
    bg: "bg-gray-50",
    text: "text-gray-700",
    ring: "ring-gray-600/20",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${config.bg} ${config.text} ${config.ring}`}
    >
      {config.dot && (
        <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      )}
      {config.label}
    </span>
  );
}

interface DraftStatusBadgeProps {
  status: DraftStatus;
}

const draftStatusConfig: Record<
  DraftStatus,
  { label: string; bg: string; text: string; ring: string }
> = {
  PENDING: {
    label: "Pending",
    bg: "bg-gray-100",
    text: "text-gray-700",
    ring: "ring-gray-600/20",
  },
  GENERATING: {
    label: "Generating",
    bg: "bg-blue-50",
    text: "text-blue-700",
    ring: "ring-blue-600/20",
  },
  READY: {
    label: "Ready",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    ring: "ring-emerald-600/20",
  },
  FLAGGED: {
    label: "Flagged",
    bg: "bg-amber-50",
    text: "text-amber-700",
    ring: "ring-amber-600/20",
  },
  FALLBACK: {
    label: "Plain Fallback",
    bg: "bg-slate-100",
    text: "text-slate-700",
    ring: "ring-slate-600/20",
  },
  APPROVED: {
    label: "Approved",
    bg: "bg-green-50",
    text: "text-green-700",
    ring: "ring-green-600/20",
  },
  HELD: {
    label: "Held",
    bg: "bg-orange-50",
    text: "text-orange-700",
    ring: "ring-orange-600/20",
  },
  QUEUED: {
    label: "Queued",
    bg: "bg-cyan-50",
    text: "text-cyan-700",
    ring: "ring-cyan-600/20",
  },
};

export function DraftStatusBadge({ status }: DraftStatusBadgeProps) {
  const config = draftStatusConfig[status] || {
    label: status,
    bg: "bg-gray-50",
    text: "text-gray-700",
    ring: "ring-gray-600/20",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${config.bg} ${config.text} ${config.ring}`}
    >
      {config.label}
    </span>
  );
}
