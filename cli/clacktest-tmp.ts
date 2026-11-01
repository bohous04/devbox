import { select, isCancel } from "@clack/prompts";
const v = await select<string>({
  message: "11 sessions for this repo are running.",
  options: [
    { value: "attach", label: "Attach" },
    { value: "fresh", label: "New session (own worktree and branch)" },
  ],
});
console.log("VYBRANO:", isCancel(v) ? "cancel" : v);
