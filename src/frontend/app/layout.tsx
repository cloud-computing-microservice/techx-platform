import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";
import { CartProvider } from "@/lib/CartContext";
import { StorefrontProvider } from "@/lib/StorefrontContext";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { SITE } from "@/lib/site-config";

const plusJakartaSans = localFont({
  src: "./fonts/PlusJakartaSans.ttf",
  weight: "400 800",
  variable: "--font-plus-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: SITE.name,
    template: `%s | ${SITE.name}`,
  },
  description: SITE.description,
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={plusJakartaSans.variable}>
      <body>
        <StorefrontProvider>
          <CartProvider>
            <Header />
            <main id="main-content" tabIndex={-1}>
              {children}
            </main>
            <Footer />
          </CartProvider>
        </StorefrontProvider>
      </body>
    </html>
  );
}
