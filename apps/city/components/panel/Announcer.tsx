"use client";

import { useEffect, useState } from "react";

// One polite live region for the whole page (approval decisions, pause state).
let push: ((message: string) => void) | null = null;

export function announce(message: string): void {
  push?.(message);
}

export function Announcer() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    push = (next) => {
      // Clear first so repeating the same message is announced again.
      setMessage("");
      setTimeout(() => setMessage(next), 50);
    };
    return () => {
      push = null;
    };
  }, []);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
