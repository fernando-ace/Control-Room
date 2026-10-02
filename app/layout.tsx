import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Control Room | Solar Storm",
  description:
    "Three stations. One spacecraft. Talk your crew through the storm.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
