import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        // We use 'http://backend:8000' because that is the service name 
        // defined in your docker-compose.yml
        destination: 'http://backend:8000/api/:path*', 
      },
    ]
  },
};

export default nextConfig;
