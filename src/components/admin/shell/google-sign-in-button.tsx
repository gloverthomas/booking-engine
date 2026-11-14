"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** Submit button for the sign-in form; shows progress while the redirect to Google is prepared. */
export function GoogleSignInButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth loading={pending}>
      <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="currentColor">
        <path d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.64 4.1-5.35 4.1a5.9 5.9 0 1 1 0-11.8c1.9 0 3.17.8 3.9 1.5l2.66-2.57C19.5 3.72 17.1 2.6 12 2.6a9.4 9.4 0 1 0 0 18.8c5.43 0 9.03-3.82 9.03-9.2 0-.62-.06-1.09-.15-1.58l-.53.48z" />
      </svg>
      Continue with Google
    </Button>
  );
}
