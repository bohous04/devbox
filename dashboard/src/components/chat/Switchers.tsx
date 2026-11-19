import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { ThreadSnapshot } from "../../../../shared/thread";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, ApiError, type ChatSwitchResult, type ChatTarget } from "../../api";
import { profileFor } from "../../newSession";
import {
  accountMenuBlocked, claudeAccountOptions, codexAccountOptions, harnessOptions, modelMenuBlocked, modelOptions,
  switchBlocked, switchErrorText, switchResultText, type SwitchOption,
} from "../../switchView";

type Which = "harness" | "model" | "account";
const errorText = (e: unknown) => (e instanceof ApiError ? switchErrorText(e.status, e.body) : (e as Error).message);

/** Model, account and harness menus of a chat session. devd applies a switch between turns and records it in the
 *  thread as a notice; `onSwitched` reloads the thread to show it. The menus show the target devd plans the next
 *  switch from (GET thread/target), re-read when the thread announces a new native thread or a run ends. */
export function Switchers({ sessionId, thread, onSwitched }: {
  sessionId: string;
  thread: ThreadSnapshot;
  onSwitched: () => Promise<void>;
}) {
  const [target, setTarget] = useState<ChatTarget | null>(null);
  const [accounts, setAccounts] = useState<SwitchOption[] | null>(null);
  const [accountsErr, setAccountsErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Which | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const n = thread.native;
  const ended = thread.runs.filter((r) => r.endedSeq !== null).length;
  const loadTarget = useCallback(
    () => api.chatTarget(sessionId).then(setTarget, (e) => setErr(`could not read the current agent: ${errorText(e)}`)),
    [sessionId],
  );
  useEffect(() => { void loadTarget(); }, [loadTarget, n?.harness, n?.nativeThreadId, n?.model, n?.account, ended]);

  const loadAccounts = useCallback(async (t: ChatTarget) => {
    setAccounts(null); setAccountsErr(null);
    try {
      if (t.harness === "codex") {
        const r = await api.codexAccounts();
        setAccounts(codexAccountOptions(r.accounts, Date.now(), t));
      } else {
        const r = await api.accounts();
        setAccounts(claudeAccountOptions(r.accounts, r.pool.thresholdPct, Date.now(), t));
      }
    } catch (e) { setAccountsErr(errorText(e)); }
  }, []);

  async function doSwitch(which: Which, value: string, call: () => Promise<ChatSwitchResult>) {
    setBusy(which); setErr(null); setNote(null);
    let r: ChatSwitchResult;
    try { r = await call(); }
    catch (e) {
      setErr(`${which === "harness" ? "Agent" : which === "model" ? "Model" : "Account"} switch to ${value} failed: ${errorText(e)}`);
      setBusy(null);
      return;
    }
    setNote(switchResultText(r));
    // The switch happened; a failed reload only hides its notice until the next load.
    if (!r.unchanged) await onSwitched().catch((e) => setErr(`Switched, but reloading the thread failed: ${errorText(e)}`));
    await loadTarget();
    setBusy(null);
  }

  const blocked = switchBlocked(thread);
  if (!target) return err ? <p role="alert" className="text-xs text-destructive">{err}</p> : null;
  const profile = profileFor(target.agent);
  const currentAccount = accounts?.find((a) => a.current)?.label ?? target.account;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Agent, model and account">
        <Menu
          which="harness" title="Agent" busy={busy} blocked={blocked} label={profile.short}
          options={harnessOptions(target)}
          onPick={(o) => void doSwitch("harness", o.label, () => api.switchChatHarness(sessionId, o.value as ChatTarget["agent"]))}
        />
        <Menu
          which="model" title="Model" busy={busy} blocked={blocked ?? modelMenuBlocked(target)} label={target.model ?? "default model"}
          options={modelOptions(target)}
          onPick={(o) => void doSwitch("model", o.label, () => api.switchChatModel(sessionId, o.value))}
        />
        <Menu
          which="account" title={target.harness === "codex" ? "Codex account" : "Claude account"} busy={busy}
          blocked={blocked ?? accountMenuBlocked(target)} label={currentAccount ?? "no account"}
          options={accounts} loadErr={accountsErr}
          onOpen={() => void loadAccounts(target)}
          onPick={(o) => void doSwitch("account", o.label, () => api.switchChatAccount(sessionId, o.value))}
        />
      </div>
      {note && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{note}</p>}
      {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

/** One switcher: a small trigger with the current value and a menu of options. Disabled options show their reason
 *  inline (a disabled menu item gets no hover, and touch has none); a blocked menu has it as the trigger's tooltip. */
function Menu({ which, title, label, options, loadErr, busy, blocked, onOpen, onPick }: {
  which: Which;
  title: string;
  label: string;
  /** null = loading. */
  options: SwitchOption[] | null;
  loadErr?: string | null;
  busy: Which | null;
  blocked: string | null;
  onOpen?: () => void;
  onPick: (o: SwitchOption) => void;
}) {
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) onOpen?.(); }}>
      {/* A disabled button gets no pointer events: the tooltip sits on the wrapper. */}
      <span title={blocked ?? undefined} className="min-w-0">
        <DropdownMenuTrigger asChild disabled={blocked !== null || busy !== null}>
          <Button type="button" variant="outline" size="xs" className="max-w-48 font-normal" aria-label={`${title}: ${label}`}>
            {busy === which ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            <span className="truncate">{label}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </span>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{title}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loadErr ? <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{loadErr}</p>
          : options === null ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
          : options.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing to switch to</p>
          : options.map((o) => (
            <DropdownMenuItem key={o.value} disabled={o.disabled !== null} onSelect={() => { if (!o.current) onPick(o); }} className="items-start">
              <Check className={o.current ? "mt-0.5" : "invisible mt-0.5"} aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{o.label}</span>
                {o.detail && <span className="text-xs text-muted-foreground">{o.detail}</span>}
                {o.warning && <span className="text-xs font-medium text-amber-700 dark:text-amber-300">{o.warning}</span>}
                {o.disabled && <span className="text-xs text-muted-foreground">{o.disabled}</span>}
              </span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
