import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // 1. Check if an Environment Variable is set. 
    // If not, default to Localhost (for your laptop).
    const backendUrl = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:8000';
    
    console.log(`Proxying /api requests to: ${backendUrl}`); // Helpful debug log

    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ]
  },
};

export default nextConfig;
