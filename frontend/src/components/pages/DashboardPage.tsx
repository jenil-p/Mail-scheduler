"use client";

import React, { useState, useCallback } from "react";
import { User, EmailJob, EmailStatus } from "@/types";
import { useJobs } from "@/hooks/useJobs";
import { Header } from "@/components/Header";
import { ComposeModal } from "@/components/ComposeModal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";

interface DashboardPageProps {
  user: User;
  onLogout: () => void;
}

export function DashboardPage({ user, onLogout }: DashboardPageProps) {
  const [showCompose, setShowCompose] = useState(false);
  const [activeTabRaw, setActiveTabRaw] = useState<"pending" | "sent">("pending");

  const {
    jobs,
    stats,
    loading,
    page,
    totalPages,
    setTab,
    refresh,
    handlePageChange,
  } = useJobs();

  // Sync the active tab
  const handleTabChange = useCallback(
    (tab: "pending" | "sent") => {
      setActiveTabRaw(tab);
      setTab(tab);
    },
    [setTab]
  );

  // Filter jobs based on active tab
  const filteredJobs = jobs.filter((job) => {
    if (activeTabRaw === "pending") {
      return job.status === "pending" || job.status === "rate_limited";
    }
    return job.status === "sent" || job.status === "failed";
  });

  const scheduledColumns = [
    {
      key: "recipient",
      header: "Recipient",
      render: (job: EmailJob) => (
        <span className="font-medium text-gray-900">{job.recipientEmail}</span>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      render: (job: EmailJob) => (
        <span className="text-gray-600 max-w-[200px] truncate block">
          {job.subject}
        </span>
      ),
    },
    {
      key: "scheduledAt",
      header: "Scheduled At",
      render: (job: EmailJob) => (
        <span className="text-gray-500">
          {new Date(job.scheduledAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (job: EmailJob) => <Badge status={job.status} />,
    },
  ];

  const sentColumns = [
    {
      key: "recipient",
      header: "Recipient",
      render: (job: EmailJob) => (
        <span className="font-medium text-gray-900">{job.recipientEmail}</span>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      render: (job: EmailJob) => (
        <span className="text-gray-600 max-w-[200px] truncate block">
          {job.subject}
        </span>
      ),
    },
    {
      key: "sentAt",
      header: "Sent At",
      render: (job: EmailJob) => (
        <span className="text-gray-500">
          {job.sentAt ? new Date(job.sentAt).toLocaleString() : "-"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (job: EmailJob) => <Badge status={job.status} />,
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Header user={user} onLogout={onLogout} />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Stats Cards */}
        {stats && (
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              label="Scheduled"
              value={stats.pending}
              color="blue"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <StatCard
              label="Sent"
              value={stats.sent}
              color="green"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <StatCard
              label="Failed"
              value={stats.failed}
              color="red"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              }
            />
            <StatCard
              label="Rate Limited"
              value={stats.rateLimited}
              color="orange"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
          </div>
        )}

        {/* Tabs & Compose Button */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            <TabButton
              active={activeTabRaw === "pending"}
              onClick={() => handleTabChange("pending")}
              label="Scheduled"
              count={stats?.pending}
            />
            <TabButton
              active={activeTabRaw === "sent"}
              onClick={() => handleTabChange("sent")}
              label="Sent"
              count={stats?.sent}
            />
          </div>
          <Button onClick={() => setShowCompose(true)}>
            <svg
              className="mr-2 h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Compose New Email
          </Button>
        </div>

        {/* Table */}
        <Table
          columns={activeTabRaw === "pending" ? scheduledColumns : sentColumns}
          data={filteredJobs}
          loading={loading}
          emptyMessage={
            activeTabRaw === "pending"
              ? "No scheduled emails"
              : "No sent emails"
          }
          emptyDescription={
            activeTabRaw === "pending"
              ? "Click 'Compose New Email' to schedule your first email."
              : "Sent emails will appear here once you've scheduled and sent some."
          }
          pagination={{
            page,
            totalPages,
            onPageChange: handlePageChange,
          }}
        />
      </main>

      {/* Compose Modal */}
      <ComposeModal
        isOpen={showCompose}
        onClose={() => setShowCompose(false)}
        onSuccess={refresh}
      />
    </div>
  );
}

// ─── Sub-components ───

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color: "blue" | "green" | "red" | "orange";
  icon: React.ReactNode;
}) {
  const colorClasses = {
    blue: "bg-blue-50 text-blue-600 ring-blue-100",
    green: "bg-green-50 text-green-600 ring-green-100",
    red: "bg-red-50 text-red-600 ring-red-100",
    orange: "bg-orange-50 text-orange-600 ring-orange-100",
  };

  return (
    <div className="card flex items-center gap-4 p-4">
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-lg ring-1 ${colorClasses[color]}`}
      >
        {icon}
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <p className="text-xl font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
        active
          ? "bg-white text-gray-900 shadow-sm"
          : "text-gray-500 hover:text-gray-700"
      }`}
    >
      {label}
      {count !== undefined && (
        <span
          className={`inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium ${
            active ? "bg-primary-50 text-primary-700" : "bg-gray-200 text-gray-600"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
