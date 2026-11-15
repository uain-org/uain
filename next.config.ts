import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  async rewrites() {
    // Match the production Nginx fallback in development, including new members.
    // The live shell reads the original URL; no member list is baked into the build.
    return [{ source: '/network/directory/:id', destination: '/network/live' }];
  },
};

export default nextConfig;
