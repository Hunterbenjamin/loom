import type { ComponentType } from "react";
import { useStore } from "../store/react.js";
import { CreateIssueDialog } from "./create-issue.js";
import { CreateResearchDialog } from "./create-research.js";

/** Register the description and the dialog together; all creation surfaces use this list. */
export const CREATABLES = [
  {
    id: "issue",
    label: "Issue",
    description: "Create an issue in a repository, in Backlog or Todo.",
    Dialog: CreateIssueDialog,
  },
  {
    id: "research",
    label: "Research",
    description: "Create a research article from a question and directory.",
    Dialog: CreateResearchDialog,
  },
] as const satisfies readonly {
  id: string;
  label: string;
  description: string;
  Dialog: ComponentType;
}[];

export type CreatableId = (typeof CREATABLES)[number]["id"];

export function CreateDialog() {
  const id = useStore((s) => s.ui.create);
  const entry = CREATABLES.find((entry) => entry.id === id);
  return entry ? <entry.Dialog key={entry.id} /> : null;
}
