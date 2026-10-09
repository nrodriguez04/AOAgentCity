"use client";

import { useId, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";

export function LoginCard() {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);
    const { error: authError } = await supabase().auth.signInWithOtp({
      email,
      // Only existing users (the owner) can sign in; no self sign-up.
      options: { emailRedirectTo: window.location.origin, shouldCreateUser: false },
    });
    if (authError) {
      setState("idle");
      setError(authError.message);
    } else {
      setState("sent");
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card glass" aria-labelledby="auth-title">
        <p className="wordmark mono">AGENT CITY</p>
        <h1 id="auth-title">Sign in</h1>
        {state === "sent" ? (
          <p role="status">Check {email} for a sign-in link.</p>
        ) : (
          <form onSubmit={submit} className="stack">
            <label htmlFor={emailId} className="label">
              Owner email
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? `${emailId}-error` : undefined}
            />
            <button type="submit" className="btn btn-approve" disabled={state === "sending"}>
              {state === "sending" ? "Sending link…" : "Email me a sign-in link"}
            </button>
            {error ? (
              <p id={`${emailId}-error`} className="error-text" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </section>
    </main>
  );
}

export function NotOwnerCard({ userId, onSignOut }: { userId: string; onSignOut: () => void }) {
  return (
    <main className="auth-screen">
      <section className="auth-card glass" aria-labelledby="owner-title">
        <p className="wordmark mono">AGENT CITY</p>
        <h1 id="owner-title">Not an owner yet</h1>
        <p>This account is signed in but can't see the city. Add it as an owner in the Supabase SQL editor:</p>
        <pre className="code">{`insert into owners (user_id, note)\nvalues ('${userId}', 'nico');`}</pre>
        <button type="button" className="btn btn-ghost" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </main>
  );
}
