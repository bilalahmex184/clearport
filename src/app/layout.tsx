import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "ClearPort // Customs Compliance & Exception Desk",
  description: "Enterprise-grade customs clearance exception management and cross-document auditor platform.",
  keywords: ["ClearPort", "customs compliance", "CBP", "exception management", "document auditor"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased bg-[#06070a] text-gray-200 font-sans`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
