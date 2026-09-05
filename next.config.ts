import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Default Server Action body limit is 1MB. Website photo uploads already
  // validate at 4MB (under the Vercel function cap). Without this, typical
  // JPG/PNG marketing photos fail before our owner-facing validation runs.
  experimental: {
    serverActions: {
      bodySizeLimit: "4.5mb",
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
