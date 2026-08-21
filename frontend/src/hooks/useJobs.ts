"use client";

import { useState, useCallback, useEffect } from "react";
import { EmailJob, EmailStatus, StatsResponse } from "@/types";
import { api } from "@/lib/api";

export function useJobs() {
  const [jobs, setJobs] = useState<EmailJob[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [activeTab, setActiveTab] = useState<EmailStatus | undefined>(undefined);

  const fetchJobs = useCallback(async (status?: EmailStatus, pageNum = 1) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getJobs(status, pageNum);
      if (response.success && response.data) {
        setJobs(response.data.jobs);
        setPage(response.data.pagination.page);
        setTotalPages(response.data.pagination.totalPages);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const response = await api.getStats();
      if (response.success && response.data) {
        setStats(response.data);
      }
    } catch {
      // Silently fail for stats
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    fetchStats();
  }, [fetchJobs, fetchStats]);

  // Refresh both jobs and stats
  const refresh = useCallback(() => {
    fetchJobs(undefined, page);
    fetchStats();
  }, [page, fetchJobs, fetchStats]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStats();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const handleTabChange = (tab: EmailStatus | undefined) => {
    setActiveTab(tab);
    setPage(1);
  };

  const handlePageChange = (newPage: number) => {
    fetchJobs(undefined, newPage);
  };

  const setTab = (tab: "pending" | "sent") => {
    handleTabChange(tab as EmailStatus);
  };

  return {
    jobs,
    stats,
    loading,
    error,
    page,
    totalPages,
    activeTab,
    setTab,
    refresh,
    handlePageChange,
  };
}
