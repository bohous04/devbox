import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { GiteaInstanceInfo, GiteaRepo, GithubOwner, GithubRepo } from "../api";
import type { Source, Visibility } from "../configEdit";
import { GiteaPane } from "./GiteaPane";
import { GithubPane } from "./GithubPane";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Modal browser of repo sources for a target (folder/project) of the config draft.
 * Shell (overlay, header, footer) + content — GitHub tabs always, Gitea tabs
 * additionally if at least one instance is configured.
 */
export function RepoBrowser({ target, github, giteaInstances = [], gitea, onClose }: {
  target: string;
  github: {
    isRepoAdded: (fullName: string) => boolean;
    ownerSource: (login: string) => Source | undefined;
    onToggleRepo: (r: GithubRepo) => void;
    onAddSource: (o: GithubOwner, visibility: Visibility) => void;
    onRemoveSource: (o: GithubOwner) => void;
  };
  giteaInstances?: GiteaInstanceInfo[];
  gitea?: {
    isRepoAdded: (fullName: string, cloneUrl: string) => boolean;
    ownerSource: (instance: string, login: string) => Source | undefined;
    onToggleRepo: (instance: string, r: GiteaRepo) => void;
    onAddSource: (instance: string, login: string) => void;
    onRemoveSource: (instance: string, login: string) => void;
  };
  onClose: () => void;
}) {
  const [tab, setTab] = useState("github"); // "github" | instance name
  const inst = giteaInstances.find((g) => g.name === tab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-background/60 p-5 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="flex max-h-[min(82vh,660px)] w-[min(720px,100%)] flex-col overflow-hidden rounded-2xl border bg-card shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label={`Add repo to ${target}`}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-center gap-2.5 border-b bg-muted/40 px-4 py-3">
          <span className="min-w-0 font-mono text-[13px] font-semibold tracking-wide">
            Add repo <span className="text-muted-foreground">→</span> <span className="text-foreground">{target}</span>
          </span>
          <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground hover:text-destructive" onClick={onClose} aria-label="Close">×</Button>
        </div>
        {giteaInstances.length > 0 && (
          <Tabs value={tab} onValueChange={setTab} className="gap-0 border-b bg-muted/40 px-4 pt-2">
            <TabsList variant="line" className="h-auto p-0">
              <TabsTrigger value="github" className="font-mono text-[11.5px] tracking-wide">GitHub</TabsTrigger>
              {giteaInstances.map((g) => (
                <TabsTrigger key={g.name} value={g.name} className="font-mono text-[11.5px] tracking-wide">{g.name}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
          {inst && gitea ? (
            <GiteaPane
              key={inst.name}
              target={target}
              instance={inst}
              isRepoAdded={gitea.isRepoAdded}
              ownerSource={(login) => gitea.ownerSource(inst.name, login)}
              onToggleRepo={(r) => gitea.onToggleRepo(inst.name, r)}
              onAddSource={(login) => gitea.onAddSource(inst.name, login)}
              onRemoveSource={(login) => gitea.onRemoveSource(inst.name, login)}
            />
          ) : (
            <GithubPane target={target} {...github} />
          )}
        </div>
        <div className="flex items-center gap-3 border-t bg-muted/40 px-4 py-2.5">
          <span className="flex-1 font-mono text-[10.5px] text-muted-foreground">Click a repo to add / remove it. Changes save with the "Save + push" button.</span>
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
