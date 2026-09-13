import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Default Server Action body limit is 1MB. Website photo uploads already
  // validate at 4MB (under the Vercel function cap). Without this, typical
  // JPG/PNG marketing photos fail before our owner-facing validation runs.
  experimental: {
    serverActions: {
      bodySizeLimit: "4.5mb",
      // Preview Host is *.vercel.app while x-forwarded-host can be the
      // production domain. Allow the Preview origin so sign-in stays on
      // the current deployment instead of aborting the Server Action.
      allowedOrigins: ["*.vercel.app"],
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.public.blob.vercel-storage.com",
      },
      {
        protocol: "https",
        hostname: "*.blob.vercel-storage.com",
      },
    ],
  },
};

export default nextConfig;
