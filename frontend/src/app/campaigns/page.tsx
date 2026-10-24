"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CampaignListItem } from "@/types";
import { api, ApiError } from "@/lib/api";
import { mapApiErrorCodeToMessage } from "@/lib/campaignErrors";
import { AuthGuard } from "@/components/campaigns/AuthGuard";
import { Header } from "@/components/Header";
import { CampaignStatusBadge } from "@/components/campaigns/CampaignStatusBadge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

const PAGE_SIZE = 20;

export default function CampaignsPage() {
  return (
    <AuthGuard>
      {(user, logout) => <CampaignsList user={user} onLogout={logout} />}
    </AuthGuard>
  );
}

function CampaignsList({
  user,
  onLogout,
}: {
  user: any;
  onLogout: () => void;
}) {
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const loadInitialCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCampaigns(PAGE_SIZE);
      const items = res.data || [];
      setCampaigns(items);
      setHasMore(items.length === PAGE_SIZE);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to load campaigns";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitialCampaigns();
  }, [loadInitialCampaigns]);

  const handleLoadMore = async () => {
    if (loadingMore || campaigns.length === 0) return;
    const lastCampaign = campaigns[campaigns.length - 1];
    setLoadingMore(true);
    try {
      const res = await api.listCampaigns(PAGE_SIZE, lastCampaign.id);
      const newItems = res.data || [];
      setCampaigns((prev) => [...prev, ...newItems]);
      setHasMore(newItems.length === PAGE_SIZE);
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to load more campaigns";
      setError(msg);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header user={user} onLogout={onLogout} />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Page Header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              Campaigns
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage your personalized AI and plain scheduled email campaigns
            </p>
          </div>
          <Link
            href="/campaigns/new"
            className="btn-primary inline-flex items-center gap-2 self-start sm:self-auto"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New campaign
          </Link>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <svg
                  className="h-5 w-5 text-red-600 shrink-0"
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
                <p className="text-sm font-medium text-red-800">{error}</p>
              </div>
              <button
                onClick={loadInitialCampaigns}
                className="text-xs font-semibold text-red-700 hover:text-red-900 underline"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="card overflow-hidden">
            <div className="divide-y divide-gray-100 p-6 space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center justify-between animate-pulse">
                  <div className="h-4 w-1/4 bg-gray-200 rounded" />
                  <div className="h-4 w-1/6 bg-gray-200 rounded" />
                  <div className="h-4 w-1/6 bg-gray-200 rounded" />
                  <div className="h-4 w-1/12 bg-gray-200 rounded" />
                  <div className="h-4 w-16 bg-gray-200 rounded" />
                </div>
              ))}
            </div>
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            description="Create your first email campaign to personalize emails or send plain bulk messages."
            action={
              <Link href="/campaigns/new" className="btn-primary">
                New campaign
              </Link>
            }
          />
        ) : (
          <div className="space-y-4">
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead>
                    <tr>
                      <th className="table-header px-6 py-3.5">Name</th>
                      <th className="table-header px-6 py-3.5">Status</th>
                      <th className="table-header px-6 py-3.5">Scheduled Time</th>
                      <th className="table-header px-6 py-3.5 text-right">Recipients</th>
                      <th className="table-header px-6 py-3.5">Notice</th>
                      <th className="table-header px-6 py-3.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {campaigns.map((c) => (
                      <tr
                        key={c.id}
                        className="hover:bg-gray-50/80 transition-colors"
                      >
                        <td className="px-6 py-4">
                          <Link
                            href={`/campaigns/${c.id}`}
                            className="font-semibold text-gray-900 hover:text-primary-600 block"
                          >
                            {c.name}
                          </Link>
                          <span className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
                            {c.aiEnabled ? (
                              <span className="inline-flex items-center gap-1 text-purple-700 font-medium">
                                <svg
                                  className="h-3 w-3"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M13 10V3L4 14h7v7l9-11h-7z"
                                  />
                                </svg>
                                AI Personalized
                              </span>
                            ) : (
                              <span>Plain template</span>
                            )}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <CampaignStatusBadge status={c.status} />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {new Date(c.scheduledAt).toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 text-right">
                          {c.recipientCount.toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-xs text-gray-500 max-w-xs">
                          {c.errorMessage ? (
                            <span
                              className="text-red-700 font-medium block truncate"
                              title={c.errorMessage}
                            >
                              {c.errorMessage}
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                          <Link
                            href={`/campaigns/${c.id}`}
                            className="btn-ghost text-xs text-primary-600 hover:text-primary-700 font-semibold"
                          >
                            View &rarr;
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Load More Button */}
            {hasMore && (
              <div className="pt-2 flex justify-center">
                <Button
                  variant="secondary"
                  onClick={handleLoadMore}
                  loading={loadingMore}
                >
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
