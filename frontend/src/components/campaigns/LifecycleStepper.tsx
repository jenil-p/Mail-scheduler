"use client";

import React from "react";
import { CampaignStatus } from "@/types/campaigns";
import { AI_LIFECYCLE_STEPS, PLAIN_LIFECYCLE_STEPS } from "@/lib/campaignLifecycle";

interface LifecycleStepperProps {
  status: CampaignStatus;
  aiEnabled: boolean;
}

export function LifecycleStepper({ status, aiEnabled }: LifecycleStepperProps) {
  const steps = aiEnabled ? AI_LIFECYCLE_STEPS : PLAIN_LIFECYCLE_STEPS;

  // Compute current step index
  let currentIndex = steps.findIndex((s) => s.key === status);
  const isPaused = status === "PAUSED";
  const isCancelled = status === "CANCELLED";

  // If paused or cancelled, determine which step was reached
  if (currentIndex === -1) {
    if (isCancelled) {
      currentIndex = -2; // distinct state
    } else if (isPaused) {
      // Paused can happen in SAMPLING, SAMPLE_REVIEW, GENERATING, EXCEPTION_REVIEW
      currentIndex = 1;
    }
  }

  return (
    <div className="card p-4 sm:p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Campaign Lifecycle
        </h3>
        {isPaused && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Execution Paused
          </span>
        )}
        {isCancelled && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            Cancelled
          </span>
        )}
      </div>

      <nav aria-label="Progress">
        <ol className="flex items-center justify-between w-full overflow-x-auto pb-2">
          {steps.map((step, index) => {
            const isCompleted =
              status === "COMPLETED" ||
              (!isCancelled && currentIndex > index);
            const isCurrent =
              !isCancelled && !isPaused && currentIndex === index;

            return (
              <li
                key={step.key}
                className={`relative flex-1 min-w-[80px] ${
                  index !== steps.length - 1 ? "pr-4 sm:pr-8" : ""
                }`}
              >
                {/* Connecting Line */}
                {index !== steps.length - 1 && (
                  <div
                    className={`absolute top-4 left-6 -right-2 h-0.5 transition-colors ${
                      isCompleted ? "bg-primary-600" : "bg-gray-200"
                    }`}
                    aria-hidden="true"
                  />
                )}

                <div className="group relative flex flex-col items-center">
                  {/* Step Icon / Circle */}
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-all z-10 ${
                      isCompleted
                        ? "bg-primary-600 text-white shadow-sm"
                        : isCurrent
                        ? "border-2 border-primary-600 bg-white text-primary-600 ring-4 ring-primary-100"
                        : "border border-gray-300 bg-white text-gray-400"
                    }`}
                  >
                    {isCompleted ? (
                      <svg
                        className="h-4 w-4 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    ) : (
                      <span>{index + 1}</span>
                    )}
                  </div>

                  {/* Step Label */}
                  <span
                    className={`mt-2 text-center text-xs font-medium whitespace-nowrap ${
                      isCurrent
                        ? "text-primary-700 font-bold"
                        : isCompleted
                        ? "text-gray-900"
                        : "text-gray-400"
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
