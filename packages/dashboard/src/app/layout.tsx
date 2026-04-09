import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import "@/globals.css";

export const metadata: Metadata = {
  title: "Engrams",
  description: "AI memory dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-[var(--color-border)] bg-[var(--color-card)]">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold text-[var(--color-accent-text)]">
                Engrams
              </h1>
            </div>
            <Nav />
          </div>
        </header>
        <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
