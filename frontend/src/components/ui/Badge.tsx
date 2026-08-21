"use client";

import React from "react";
import { EmailStatus } from "@/types";

interface BadgeProps {
  status: EmailStatus;
}

const statusConfig: Record<EmailStatus, { label: string; classes: string }> = {
  pending: {
    label: "Pending",
    classes: "bg-yellow-50 text-yellow-700 ring-yellow-600/20",
  },
  sent: {
    label: "Sent",
    classes: "bg-green-50 text-green-700 ring-green-600/20",
  },
  failed: {
    label: "Failed",
    classes: "bg-red-50 text-red-700 ring-red-600/20",
  },
  rate_limited: {
    label: "Rate Limited",
    classes: "bg-orange-50 text-orange-700 ring-orange-600/20",
  },
};

export function Badge({ status }: BadgeProps) {
  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset ${config.classes}`}
    >
      {config.label}
    </span>
  );
}
