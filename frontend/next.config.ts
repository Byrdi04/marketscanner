import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        // The destination now dynamically reads from an environment variable
        destination: `${process.env.BACKEND_URL}/api/:path*`,
      },
    ]
  },
};

export default nextConfig;
