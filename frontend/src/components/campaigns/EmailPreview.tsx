"use client";

import React from "react";

interface EmailPreviewProps {
  subject: string;
  body: string;
  aiIntro?: string | null;
  className?: string;
}

export function EmailPreview({
  subject,
  body,
  aiIntro,
  className = "",
}: EmailPreviewProps) {
  // Safe HTML template for server-rendered email body inside sandboxed iframe
  const srcDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1f2937;
      margin: 14px;
      background: #ffffff;
      word-break: break-word;
    }
    a {
      color: #2563eb;
      text-decoration: underline;
    }
  </style>
</head>
<body>${body}</body>
</html>`;

  return (
    <div className={`space-y-3 ${className}`}>
      {/* AI Intro Callout */}
      {aiIntro && (
        <div className="rounded-lg border border-purple-200 bg-purple-50/70 p-3.5 shadow-xs">
          <div className="flex items-center gap-2 mb-1">
            <svg
              className="h-4 w-4 text-purple-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            <span className="text-xs font-semibold uppercase tracking-wider text-purple-900">
              Personalized AI Intro
            </span>
          </div>
          <p className="text-sm font-medium text-purple-950 italic">
            "{aiIntro}"
          </p>
        </div>
      )}

      {/* Subject Line */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2 text-sm">
        <span className="font-semibold text-gray-600">Subject: </span>
        <span className="font-medium text-gray-900">{subject}</span>
      </div>

      {/* Sandboxed Body Iframe */}
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
          Email Body Preview
        </label>
        <iframe
          sandbox=""
          srcDoc={srcDoc}
          title={`Email Preview: ${subject}`}
          className="w-full h-48 sm:h-56 rounded-lg border border-gray-200 bg-white shadow-inner overflow-auto"
        />
      </div>
    </div>
  );
}
