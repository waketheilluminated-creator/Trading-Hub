import type { Metadata } from "next";
import { PineEditorTab } from "./pine-editor-tab";

export const metadata: Metadata = {
  title: "Pine Editor — Trading Hub",
  description: "A focused Pine Script editing tab synchronized with the Trading Hub chart workspace.",
};

export default function PineEditorPage() {
  return <PineEditorTab />;
}
