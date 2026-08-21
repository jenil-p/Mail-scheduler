"use client";

import React, { useState, useRef, useCallback } from "react";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { api } from "@/lib/api";

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function ComposeModal({ isOpen, onClose, onSuccess }: ComposeModalProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [delayBetweenEmails, setDelayBetweenEmails] = useState("2000");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientInput, setRecipientInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsedCount, setParsedCount] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Parse CSV/text file for email addresses
  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const found = text.match(emailRegex) || [];
        setRecipients((prev) => {
          const combined = [...prev, ...found];
          return Array.from(new Set(combined)); // deduplicate
        });
        setParsedCount(found.length);
      };
      reader.readAsText(file);

      // Reset file input so the same file can be re-uploaded
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    []
  );

  const addRecipient = () => {
    const email = recipientInput.trim();
    if (!email) return;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError("Invalid email address");
      return;
    }

    setRecipients((prev) => [...prev, email]);
    setRecipientInput("");
    setError(null);
  };

  const removeRecipient = (email: string) => {
    setRecipients((prev) => prev.filter((r) => r !== email));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (recipients.length === 0) {
      setError("Please add at least one recipient");
      return;
    }

    if (!subject.trim()) {
      setError("Subject is required");
      return;
    }

    if (!body.trim()) {
      setError("Body is required");
      return;
    }

    if (!scheduledAt) {
      setError("Please select a start time");
      return;
    }

    setSending(true);

    try {
      const response = await api.scheduleEmails({
        recipients,
        subject,
        body,          senderEmail: "Sendly Scheduler <scheduler@sendly.local>", // tracking label; actual SMTP uses dynamic Ethereal account
        scheduledAt: new Date(scheduledAt).toISOString(),
        delayBetweenEmails: parseInt(delayBetweenEmails) || 2000,
      });

      if (response.success) {
        // Reset form
        setSubject("");
        setBody("");
        setScheduledAt("");
        setRecipients([]);
        setParsedCount(null);
        onSuccess();
        onClose();
      }
    } catch (err: any) {
      setError(err.message || "Failed to schedule emails");
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Compose New Email" size="lg">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Recipients */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Recipients
          </label>

          {/* Add recipient input */}
          <div className="flex gap-2 mb-2">
            <input
              type="email"
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRecipient())}
              placeholder="Enter email address and press Enter"
              className="input-field flex-1"
            />
            <Button type="button" variant="secondary" size="sm" onClick={addRecipient}>
              Add
            </Button>
          </div>

          {/* File upload */}
          <div className="mb-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt"
              onChange={handleFileUpload}
              className="hidden"
              id="csv-upload"
            />
            <label
              htmlFor="csv-upload"
              className="inline-flex cursor-pointer items-center gap-2 text-sm text-primary-600 hover:text-primary-700 font-medium"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              Upload CSV / Text file
            </label>
            {parsedCount !== null && (
              <span className="ml-3 text-sm text-gray-500">
                (Found {parsedCount} email{parsedCount !== 1 ? "s" : ""})
              </span>
            )}
          </div>

          {/* Recipient chips */}
          {recipients.length > 0 && (
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-2 border border-gray-200 rounded-lg bg-gray-50">
              {recipients.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-medium text-primary-700"
                >
                  {email}
                  <button
                    type="button"
                    onClick={() => removeRecipient(email)}
                    className="text-primary-400 hover:text-primary-600"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-1">{recipients.length} recipient{recipients.length !== 1 ? "s" : ""}</p>
        </div>

        {/* Subject */}
        <Input
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Enter email subject"
        />

        {/* Body */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Body
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="Write your email body here..."
            className="input-field resize-y min-h-[100px]"
          />
        </div>

        {/* Schedule Settings */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            label="Start Time"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <Input
            label="Delay (ms)"
            type="number"
            value={delayBetweenEmails}
            onChange={(e) => setDelayBetweenEmails(e.target.value)}
            helperText="Min delay between sends"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={sending}>
            Schedule {recipients.length > 0 && `(${recipients.length})`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
