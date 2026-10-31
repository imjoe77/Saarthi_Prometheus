import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/copytrading",
        destination: "/copy-trading",
        permanent: true,
      },
      {
        source: "/copy_trading",
        destination: "/copy-trading",
        permanent: true,
      },
      {
        source: "/ember",
        destination: "/tokenomics",
        permanent: true,
      },
      {
        source: "/ember-tokenomics",
        destination: "/tokenomics",
        permanent: true,
      },
      {
        source: "/usdt",
        destination: "/usdt-exchange",
        permanent: true,
      },
      {
        source: "/usdtexchange",
        destination: "/usdt-exchange",
        permanent: true,
      },
      {
        source: "/exchange",
        destination: "/usdt-exchange",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
