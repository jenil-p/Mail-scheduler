"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { User } from "@/types";

declare global {
  interface Window {
    google?: any;
  }
}

interface LoginPageProps {
  onLogin: (token: string, user: User) => void;
}

function LoginPage({ onLogin }: LoginPageProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load Google Sign-In script
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // Google Sign-In via OAuth token client popup
  const handleGoogleSignIn = useCallback(async () => {
    setError(null);
    setLoading(true);

    // Timeout safety: reset loading after 60s if popup is closed or hangs
    const timeoutId = setTimeout(() => {
      setLoading(false);
      setError("Sign-in timed out. Please try again.");
    }, 60000);

    try {
      const googleWindow = window as any;

      if (!googleWindow.google?.accounts) {
        clearTimeout(timeoutId);
        throw new Error("Google Sign-In not loaded. Please refresh and try again.");
      }

      // Use the token client for a proper popup flow
      googleWindow.google.accounts.oauth2.initTokenClient({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
        scope: "openid email profile",
        callback: async (response: any) => {
          clearTimeout(timeoutId);
          if (response.access_token) {
            try {
              // Send the access token to our backend for verification
              const result = await api.googleLogin(response.access_token);
              if (result.success && result.data) {
                onLogin(result.data.token, result.data.user);
              } else {
                throw new Error(result.error || "Authentication failed");
              }
            } catch (err: any) {
              setError(err.message || "Failed to authenticate with Google");
            }
          } else {
            setError("Google Sign-In was cancelled or failed");
          }
          setLoading(false);
        },
      }).requestAccessToken();
    } catch (err: any) {
      clearTimeout(timeoutId);
      setError(err.message || "Google login failed");
      setLoading(false);
    }
  }, [onLogin]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-50 via-primary-50/30 to-blue-50">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-primary-100/40 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-blue-100/40 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md px-4">
        {/* Card */}
        <div className="card p-8 animate-slide-up">
          {/* Logo */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-600 shadow-lg shadow-primary-200">
              <svg
                className="h-7 w-7 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Welcome to Sendly</h1>
            <p className="mt-2 text-sm text-gray-500">
              Schedule and manage your emails with ease
            </p>
          </div>

          {/* Google Login Button */}
          <div className="space-y-4">
            <Button
              onClick={handleGoogleSignIn}
              loading={loading}
              variant="secondary"
              size="lg"
              className="w-full gap-3 border-2"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              Sign in with Google
            </Button>

            {error && (
              <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700 text-center">
                {error}
              </div>
            )}

            <p className="text-center text-xs text-gray-400">
              By signing in, you agree to our Terms of Service
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export { LoginPage };
