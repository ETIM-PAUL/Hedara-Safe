import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "hedera-safe-swap",
  description: "Safe multisig treasury on Hedera, rebalanced through SaucerSwap"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
