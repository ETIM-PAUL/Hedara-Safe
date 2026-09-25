import * as dotenv from "dotenv";

// .env lives at the monorepo root, not in this package — Next.js only auto-loads .env files
// relative to itself. Load it explicitly, before Next builds its webpack config, so Next's own
// automatic NEXT_PUBLIC_* scan of process.env (which inlines them into the client bundle) picks
// these up too, not just server-side reads. Every NEXT_PUBLIC_* var must be referenced as a
// static `process.env.NEXT_PUBLIC_X` in source for that inlining to work — see lib/safe.ts.
dotenv.config({ path: "../../.env" });

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
