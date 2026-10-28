"use client";

import React, { useState, useRef, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { AuthGuard } from "@/components/campaigns/AuthGuard";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  CampaignFormState,
  getFormFingerprint,
  isDryRunValidForCurrentForm,
  canCreateCampaign,
  isCsvFileWithinLimit,
  MAX_CSV_SIZE_BYTES,
  validateRequestSize,
} from "@/lib/campaignGating";
import { mapApiErrorCodeToMessage } from "@/lib/campaignErrors";
import { DryRunResponseData, CreateCampaignSuccessData } from "@/types";

export default function NewCampaignPage() {
  return (
    <AuthGuard>
      {(user, logout) => <NewCampaignForm user={user} onLogout={logout} />}
    </AuthGuard>
  );
}

function NewCampaignForm({
  user,
  onLogout,
}: {
  user: any;
  onLogout: () => void;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form State
  const [form, setForm] = useState<CampaignFormState>({
    name: "",
    subjectTemplate: "",
    bodyTemplate: "",
    linkUrl: "",
    unsubscribeUrl: "",
    aiEnabled: false,
    aiInstruction: "",
    onUnresolved: "FALLBACK_TO_PLAIN",
    scheduledAt: "",
    csv: "",
  });

  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  // Validation & Submission State
  const [isValidating, setIsValidating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResponseData | null>(null);

  // Detect local timezone
  const localTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "Local Time";
    }
  }, []);

  // Set default schedule time to 1 hour from now formatted for datetime-local
  useEffect(() => {
    const defaultDate = new Date(Date.now() + 60 * 60 * 1000);
    const isoString = new Date(defaultDate.getTime() - defaultDate.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setForm((prev) => (prev.scheduledAt ? prev : { ...prev, scheduledAt: isoString }));
  }, []);

  // Update a form field
  const updateField = <K extends keyof CampaignFormState>(
    field: K,
    value: CampaignFormState[K]
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setApiError(null);
  };

  // CSV file selection handler
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCsvError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!isCsvFileWithinLimit(file.size)) {
      setCsvError(
        `File size (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds the 1 MB limit. Please upload a smaller CSV.`
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = (event.target?.result as string) || "";
      setForm((prev) => ({ ...prev, csv: text }));
      setCsvFileName(file.name);
    };
    reader.onerror = () => {
      setCsvError("Failed to read CSV file.");
    };
    reader.readAsText(file, "UTF-8");
  };

  // Check if current form is validated with 0 errors
  const isDryRunValid = isDryRunValidForCurrentForm(validatedFingerprint, form);
  const isCreateEnabled = canCreateCampaign({
    validatedFingerprint,
    currentForm: form,
    dryRunResult,
    isValidating,
    isCreating,
  });

  // Execute Dry-Run Validation
  const handleValidate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsValidating(true);
    setApiError(null);

    const currentFingerprint = getFormFingerprint(form);

    try {
      const scheduledIso = form.scheduledAt
        ? new Date(form.scheduledAt).toISOString()
        : "";

      const payload = {
        name: form.name,
        subjectTemplate: form.subjectTemplate,
        bodyTemplate: form.bodyTemplate,
        linkUrl: form.linkUrl,
        unsubscribeUrl: form.unsubscribeUrl,
        aiEnabled: form.aiEnabled,
        aiInstruction: form.aiEnabled ? form.aiInstruction : null,
        reviewMode: "SAMPLE" as const,
        onUnresolved: form.onUnresolved,
        scheduledAt: scheduledIso,
        csv: form.csv,
        dryRun: true,
      };

      const sizeCheck = validateRequestSize(payload);
      if (!sizeCheck.valid) {
        setApiError(sizeCheck.error);
        setIsValidating(false);
        return;
      }

      const res = await api.createCampaign(payload);

      setDryRunResult(res.data as DryRunResponseData);
      setValidatedFingerprint(currentFingerprint);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 422 && err.details) {
        // Validation failed with structured details
        setDryRunResult({
          errors: err.details.errors || [
            { code: err.code || "VALIDATION_FAILED", message: err.message },
          ],
          warnings: err.details.warnings || [],
          rejected: err.details.rejected || [],
          rejectedCount: err.details.rejectedCount || 0,
          headerMapping: err.details.headerMapping || {},
          extraColumns: err.details.extraColumns || [],
        });
        setValidatedFingerprint(currentFingerprint);
      } else {
        const msg =
          err instanceof ApiError
            ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
            : err.message || "Validation failed";
        setApiError(msg);
        setDryRunResult(null);
        setValidatedFingerprint(null);
      }
    } finally {
      setIsValidating(false);
    }
  };

  // Create Campaign (non-dry-run)
  const handleCreate = async () => {
    if (!isCreateEnabled || isCreating) return;

    setIsCreating(true);
    setApiError(null);

    try {
      const scheduledIso = new Date(form.scheduledAt).toISOString();

      const payload = {
        name: form.name,
        subjectTemplate: form.subjectTemplate,
        bodyTemplate: form.bodyTemplate,
        linkUrl: form.linkUrl,
        unsubscribeUrl: form.unsubscribeUrl,
        aiEnabled: form.aiEnabled,
        aiInstruction: form.aiEnabled ? form.aiInstruction : null,
        reviewMode: "SAMPLE" as const,
        onUnresolved: form.onUnresolved,
        scheduledAt: scheduledIso,
        csv: form.csv,
        dryRun: false,
      };

      const sizeCheck = validateRequestSize(payload);
      if (!sizeCheck.valid) {
        setApiError(sizeCheck.error);
        setIsCreating(false);
        return;
      }

      const res = await api.createCampaign(payload);

      const successData = res.data as CreateCampaignSuccessData;
      if (successData?.campaignId) {
        router.push(`/campaigns/${successData.campaignId}`);
      } else {
        router.push("/campaigns");
      }
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? mapApiErrorCodeToMessage(err.code, err.details, err.message)
          : err.message || "Failed to create campaign";
      setApiError(msg);
      setIsCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <Header user={user} onLogout={onLogout} />

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Navigation Breadcrumb */}
        <div className="mb-6">
          <Link
            href="/campaigns"
            className="text-xs font-semibold text-gray-500 hover:text-gray-900 inline-flex items-center gap-1.5"
          >
            &larr; Back to campaigns
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
            Create New Campaign
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure your campaign templates, recipients CSV, and scheduling details.
          </p>
        </div>

        {/* Global API Error */}
        {apiError && (
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
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm font-medium text-red-800">{apiError}</p>
            </div>
          </div>
        )}

        <form onSubmit={handleValidate} className="space-y-6">
          {/* Card: Basic Details */}
          <div className="card p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-3">
              1. Campaign Information
            </h2>

            <Input
              label="Campaign Name"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="e.g. Q4 Founder Outreach"
              maxLength={120}
              required
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Link URL ({{link}})"
                type="url"
                value={form.linkUrl}
                onChange={(e) => updateField("linkUrl", e.target.value)}
                placeholder="https://example.com/demo"
                helperText="Must be a valid http or https URL"
                required
              />

              <Input
                label="Unsubscribe URL ({{unsubscribe_link}})"
                type="url"
                value={form.unsubscribeUrl}
                onChange={(e) => updateField("unsubscribeUrl", e.target.value)}
                placeholder="https://example.com/unsubscribe"
                helperText="Required in body template"
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Schedule Date & Time ({localTimeZone})
                </label>
                <input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(e) => updateField("scheduledAt", e.target.value)}
                  className="input-field"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  Must be in the future (minimum 5 minutes lead time).
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Unresolved Policy
                </label>
                <select
                  value={form.onUnresolved}
                  onChange={(e) =>
                    updateField("onUnresolved", e.target.value as "FALLBACK_TO_PLAIN" | "HOLD")
                  }
                  className="input-field"
                >
                  <option value="FALLBACK_TO_PLAIN">
                    Send the plain email (FALLBACK_TO_PLAIN)
                  </option>
                  <option value="HOLD">Do not send (HOLD)</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Action taken if drafts remain unreviewed at review deadline.
                </p>
              </div>
            </div>
          </div>

          {/* Card: AI Personalization */}
          <div className="card p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  2. AI Personalization
                </h2>
                <p className="text-xs text-gray-500">
                  Generate tailored opening sentences using recipient data.
                </p>
              </div>

              {/* Toggle switch */}
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={form.aiEnabled}
                  onChange={(e) => updateField("aiEnabled", e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                <span className="ml-3 text-sm font-medium text-gray-700">
                  {form.aiEnabled ? "Enabled" : "Off"}
                </span>
              </label>
            </div>

            {form.aiEnabled ? (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="block text-sm font-medium text-gray-700">
                    AI Instruction
                  </label>
                  <span
                    className={`text-xs ${
                      form.aiInstruction.length > 500
                        ? "text-red-600 font-bold"
                        : "text-gray-500"
                    }`}
                  >
                    {form.aiInstruction.length} / 500 characters
                  </span>
                </div>
                <textarea
                  value={form.aiInstruction}
                  onChange={(e) => updateField("aiInstruction", e.target.value)}
                  placeholder="e.g. Keep a friendly, professional tone. Highlight our shared background in SaaS and mention their recent company milestone."
                  rows={3}
                  maxLength={500}
                  className="input-field resize-y"
                />
                <p className="text-xs text-gray-500">
                  Note: When AI is enabled, the body template must include{" "}
                  <code className="text-purple-700 font-semibold">{"{{ai_intro}}"}</code>{" "}
                  exactly once.
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-500 italic">
                AI Personalization is disabled. Standard plain template will be rendered.
              </p>
            )}
          </div>

          {/* Card: Email Templates */}
          <div className="card p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-3">
              3. Email Templates
            </h2>

            {/* Template Variables Helper */}
            <div className="rounded-lg bg-blue-50/60 p-4 border border-blue-100 text-xs text-blue-900 space-y-2">
              <p className="font-semibold text-blue-950">
                Available Template Placeholders:
              </p>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded bg-blue-100 px-2 py-0.5 font-mono">{"{{first_name}}"}</span>
                <span className="rounded bg-blue-100 px-2 py-0.5 font-mono">{"{{company}}"}</span>
                <span className="rounded bg-blue-100 px-2 py-0.5 font-mono">{"{{role}}"}</span>
                <span className="rounded bg-blue-100 px-2 py-0.5 font-mono">{"{{note}}"}</span>
                <span className="rounded bg-blue-100 px-2 py-0.5 font-mono">{"{{link}}"}</span>
                <span className="rounded bg-blue-200 px-2 py-0.5 font-mono text-blue-950 font-bold">
                  {"{{unsubscribe_link}}"} (Required)
                </span>
                {form.aiEnabled && (
                  <span className="rounded bg-purple-100 px-2 py-0.5 font-mono text-purple-900 font-bold">
                    {"{{ai_intro}}"} (Required once)
                  </span>
                )}
              </div>
              <p className="text-blue-800 leading-relaxed pt-1">
                You can specify fallback text for missing recipient data using pipe syntax, e.g.{" "}
                <code className="font-mono bg-blue-100/80 px-1 py-0.5 rounded">
                  {"{{first_name|there}}"}
                </code>{" "}
                or{" "}
                <code className="font-mono bg-blue-100/80 px-1 py-0.5 rounded">
                  {"{{company|your team}}"}
                </code>
                . Extra columns in your CSV will also become usable placeholders.
              </p>
            </div>

            <Input
              label="Subject Template"
              value={form.subjectTemplate}
              onChange={(e) => updateField("subjectTemplate", e.target.value)}
              placeholder="e.g. Quick question for {{first_name|there}} regarding {{company}}"
              helperText="{{ai_intro}} is not permitted in subject"
              required
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Body Template
              </label>
              <textarea
                value={form.bodyTemplate}
                onChange={(e) => updateField("bodyTemplate", e.target.value)}
                placeholder={`Hi {{first_name|there}},\n\n${
                  form.aiEnabled ? "{{ai_intro}}\n\n" : ""
                }I wanted to share our latest product updates: {{link}}\n\nBest regards,\nYour Name\n\nTo unsubscribe: {{unsubscribe_link}}`}
                rows={8}
                className="input-field font-mono text-xs sm:text-sm resize-y"
                required
              />
            </div>
          </div>

          {/* Card: Recipients CSV */}
          <div className="card p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-3">
              4. Recipients CSV
            </h2>

            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="hidden"
                id="campaign-csv-file"
              />

              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <label
                  htmlFor="campaign-csv-file"
                  className="btn-secondary cursor-pointer inline-flex items-center gap-2 text-sm"
                >
                  <svg
                    className="h-4 w-4 text-gray-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                  Choose CSV File
                </label>

                {csvFileName && (
                  <span className="text-sm font-medium text-gray-700">
                    {csvFileName} ({(form.csv.length / 1024).toFixed(1)} KB)
                  </span>
                )}
              </div>

              {csvError && (
                <p className="mt-2 text-xs font-semibold text-red-600">{csvError}</p>
              )}

              <p className="mt-2 text-xs text-gray-500">
                Max file size: 1 MB. Required column: <code className="font-semibold">email</code>.
                Recognized columns: <code className="font-semibold">first_name</code>,{" "}
                <code className="font-semibold">company</code>, <code className="font-semibold">role</code>,{" "}
                <code className="font-semibold">note</code>. Any additional columns become custom placeholders.
              </p>
            </div>
          </div>

          {/* Dry Run Validation Results Card */}
          {dryRunResult && (
            <div
              className={`card p-6 space-y-4 border-2 ${
                dryRunResult.errors.length > 0
                  ? "border-red-300 bg-red-50/20"
                  : "border-green-300 bg-green-50/20"
              }`}
            >
              <div className="flex items-center justify-between border-b border-gray-200 pb-3">
                <div className="flex items-center gap-2">
                  {dryRunResult.errors.length === 0 ? (
                    <svg
                      className="h-5 w-5 text-green-600"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg
                      className="h-5 w-5 text-red-600"
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
                  )}
                  <h3 className="text-base font-bold text-gray-900">
                    Validation Result:{" "}
                    {dryRunResult.errors.length === 0
                      ? "Ready to Create"
                      : `${dryRunResult.errors.length} Blocking Error(s)`}
                  </h3>
                </div>

                {!isDryRunValid && (
                  <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                    Form modified since validation
                  </span>
                )}
              </div>

              {/* Blocking Errors */}
              {dryRunResult.errors.length > 0 && (
                <div className="rounded-lg bg-red-50 p-4 border border-red-200">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-red-900 mb-2">
                    Blocking Errors (Must be resolved)
                  </h4>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-red-800">
                    {dryRunResult.errors.map((err, i) => (
                      <li key={i}>
                        {err.field && <span className="font-semibold">[{err.field}] </span>}
                        {err.message || err.code}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Warnings */}
              {dryRunResult.warnings && dryRunResult.warnings.length > 0 && (
                <div className="rounded-lg bg-yellow-50 p-4 border border-yellow-200">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-yellow-900 mb-2">
                    Warnings (Non-blocking)
                  </h4>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-yellow-800">
                    {dryRunResult.warnings.map((w, i) => (
                      <li key={i}>
                        {w.recipientsMissing} of {w.total} recipients have no{" "}
                        <code className="font-mono font-bold text-yellow-900">
                          {w.variable}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Header Mapping & Extra Columns */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                {Object.keys(dryRunResult.headerMapping || {}).length > 0 && (
                  <div className="rounded-lg bg-white p-3 border border-gray-200 shadow-xs">
                    <p className="font-semibold text-gray-700 mb-2">CSV Column Mapping:</p>
                    <div className="space-y-1">
                      {Object.entries(dryRunResult.headerMapping).map(([orig, norm]) => (
                        <div key={orig} className="flex justify-between font-mono">
                          <span className="text-gray-500">"{orig}"</span>
                          <span className="text-primary-700">&rarr; {norm}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {dryRunResult.extraColumns && dryRunResult.extraColumns.length > 0 && (
                  <div className="rounded-lg bg-white p-3 border border-gray-200 shadow-xs">
                    <p className="font-semibold text-gray-700 mb-2">
                      Available Extra Variables:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {dryRunResult.extraColumns.map((col) => (
                        <span
                          key={col}
                          className="bg-indigo-50 text-indigo-700 font-mono px-2 py-0.5 rounded border border-indigo-100"
                        >
                          {"{{" + col + "}}"}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Rejected Rows (first 100) */}
              {dryRunResult.rejected && dryRunResult.rejected.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-700 mb-1.5">
                    Rejected Rows ({dryRunResult.rejectedCount} total, showing first{" "}
                    {dryRunResult.rejected.length}):
                  </p>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                    <table className="min-w-full divide-y divide-gray-200 text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">Row</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">Reason</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {dryRunResult.rejected.map((r, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-1.5 font-mono text-gray-500">{r.rowNumber}</td>
                            <td className="px-3 py-1.5 font-medium text-red-700">{r.code}</td>
                            <td className="px-3 py-1.5 text-gray-600 truncate max-w-xs">{r.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Form Actions */}
          <div className="flex flex-col sm:flex-row items-center justify-end gap-3 pt-4 border-t border-gray-200">
            <Link href="/campaigns" className="btn-secondary w-full sm:w-auto text-center">
              Cancel
            </Link>

            <Button
              type="submit"
              variant="secondary"
              loading={isValidating}
              disabled={isCreating || !form.name || !form.csv}
              className="w-full sm:w-auto"
            >
              Validate
            </Button>

            <Button
              type="button"
              variant="primary"
              onClick={handleCreate}
              loading={isCreating}
              disabled={!isCreateEnabled}
              className="w-full sm:w-auto"
            >
              Create campaign
            </Button>
          </div>

          {!isCreateEnabled && (
            <p className="text-right text-xs text-gray-500">
              {!dryRunResult
                ? "Run validation to enable campaign creation."
                : !isDryRunValid
                ? "Input values changed since last dry run. Validate again to proceed."
                : dryRunResult.errors.length > 0
                ? "Resolve all blocking validation errors to create the campaign."
                : ""}
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
