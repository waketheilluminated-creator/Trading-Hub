import type { Metadata } from "next";
import { SettingsView } from "./settings-view";

export const metadata: Metadata = {
  title: "Settings — Trading Hub",
  description: "Alert notification settings: 通知邮箱 and test email verification.",
};

export default function SettingsPage() {
  return <SettingsView />;
}
