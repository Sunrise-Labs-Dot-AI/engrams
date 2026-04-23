import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: resolve(__dirname, "../.."),
  serverExternalPackages: [
    "onnxruntime-node",
    "@huggingface/transformers",
    "sharp",
    "better-sqlite3",
    "sqlite-vec",
  ],

  // Force-include onnxruntime-node + its native .node binaries in the
  // Vercel serverless deploy for the MCP route. serverExternalPackages
  // tells Next not to bundle the module, but Next 15's file-tracing can
  // miss pnpm-nested native binaries (the package entry + *.node files
  // live under node_modules/.pnpm/onnxruntime-node@*/...). Without this,
  // the MCP Lambda fails on import with "Cannot find module 'onnxruntime-
  // node'" — confirmed live on deploy 2026-04-21 via the Layer 1
  // reranker-diagnostic fields added in PR #78.
  outputFileTracingIncludes: {
    "/api/mcp/route": [
      "../../node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/**/*",
      "../../node_modules/.pnpm/@huggingface+transformers@*/node_modules/@huggingface/transformers/**/*",
    ],
  },

  env: {
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
    NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL: "/",
    NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL: "/",
  },

  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
  ],

  webpack: (config) => {
    config.externals = [
      ...(config.externals || []),
      "onnxruntime-node",
    ];
    return config;
  },
};

export default nextConfig;
