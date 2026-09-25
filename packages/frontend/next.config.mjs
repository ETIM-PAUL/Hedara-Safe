import * as dotenv from "dotenv";

// .env lives at the monorepo root, not in this package — Next.js only auto-loads .env files
// relative to itself, so load it explicitly before Next inlines NEXT_PUBLIC_* vars at build time.
dotenv.config({ path: "../../.env" });

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
