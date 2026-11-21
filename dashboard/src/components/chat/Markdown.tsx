import { Fragment } from "react";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { codeOnly, isPathLike, parseInline, parseMarkdown, type MdBlock, type StatusKind } from "../../markdown";

const STATUS_ICON: Record<StatusKind, { Icon: typeof CircleCheck; className: string }> = {
  ok: { Icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400" },
  fail: { Icon: CircleX, className: "text-red-600 dark:text-red-400" },
  warn: { Icon: TriangleAlert, className: "text-amber-600 dark:text-amber-400" },
};

// Code up to `nowrap` characters never breaks inside; longer code wraps at its spaces. A desktop table cell allows
// more, so a command keeps its line and the auto-sized table gives it the room; a phone's stacked table allows less.
const NOWRAP_PROSE = 32;
const NOWRAP_TABLE = 48;
const NOWRAP_STACKED = 16;

/** `plain`: table cells, where code is set in mono without a chip so a column of commands reads as a column. */
function Inline({ text, plain, nowrap = NOWRAP_PROSE }: { text: string; plain?: boolean; nowrap?: number }) {
  return (
    <>
      {parseInline(text).map((p, i) => {
        switch (p.type) {
          // A file or folder name is plain mono text, not a chip: prose with three chips per sentence is lumpy.
          case "code": if (!plain && isPathLike(p.text)) return <code key={i} className="whitespace-nowrap font-mono text-[0.86em] text-foreground">{p.text}</code>;
          return (
            <code key={i} className={cn("font-mono text-[0.86em]", p.text.length <= nowrap ? "whitespace-nowrap" : "break-words",
              // No vertical padding: a chip must not make its line taller than the others.
              plain ? "text-foreground/90" : "box-decoration-clone rounded-[4px] bg-foreground/[0.05] px-[0.28em] dark:bg-foreground/[0.07]")}>
              {p.text.length <= nowrap
                ? p.text
                // A long command wraps between its words, never inside one (`--strict` must not split after `--`).
                : p.text.split(" ").map((w, j) => <Fragment key={j}>{j > 0 && " "}<span className="whitespace-nowrap">{w}</span></Fragment>)}
            </code>
          );
          case "bold": return <strong key={i} className="font-semibold text-foreground">{p.text}</strong>;
          case "italic": return <em key={i}>{p.text}</em>;
          case "link": return (
            <a key={i} href={p.href} target="_blank" rel="noreferrer noopener"
              className="break-all text-sky-700 underline decoration-sky-700/30 underline-offset-[3px] transition-colors hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30 dark:hover:decoration-sky-400">
              {p.text}
            </a>
          );
          case "status": {
            const { Icon, className } = STATUS_ICON[p.kind];
            return <Icon key={i} role="img" aria-label={p.text} className={cn("mb-[0.15em] inline-block size-[1.05em] align-middle", className)} />;
          }
          default: return <Fragment key={i}>{p.text}</Fragment>;
        }
      })}
    </>
  );
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

/** A desktop table cell: a lone command or path on one line, cut at its end with the whole in its tooltip, so a long
 *  one does not wrap and push its row out of line with the others; prose wraps. The phone's stacked table (no hover)
 *  keeps such cells wrapping. */
function Cell({ text }: { text: string }) {
  const code = codeOnly(text);
  if (code === null) return <Inline text={text} plain nowrap={NOWRAP_TABLE} />;
  return <span title={code} className="block max-w-[28rem] truncate"><Inline text={text} plain nowrap={Infinity} /></span>;
}

function StackedTable({ table }: { table: Extract<MdBlock, { type: "table" }> }) {
  return (
    <div className="divide-y divide-border/50 border-y border-border/50 text-sm sm:hidden">
      {table.rows.map((r, j) => (
        table.header.length <= 2 ? (
          // Two columns: the first cell titles the row, the second sits under it; cells stay as authored.
          <div key={j} className="space-y-0.5 py-2.5">
            <p className="font-medium text-foreground"><Inline text={r[0]} plain nowrap={NOWRAP_STACKED} /></p>
            {r.length > 1 && <p className="text-foreground/80"><Inline text={r[1]} plain nowrap={NOWRAP_STACKED} /></p>}
          </div>
        ) : (
          // More columns: every value keeps its column's name as a small label.
          <dl key={j} className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 py-2.5">
            {r.map((c, k) => (
              <Fragment key={k}>
                <dt className="max-w-24 truncate text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"><Inline text={table.header[k]} plain nowrap={NOWRAP_STACKED} /></dt>
                <dd className="min-w-0 text-foreground/85"><Inline text={c} plain nowrap={NOWRAP_STACKED} /></dd>
              </Fragment>
            ))}
          </dl>
        )
      ))}
    </div>
  );
}

/** Assistant text as markdown (the subset in markdown.ts), rendered as elements, never as HTML. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2.5 break-words sm:space-y-3">
      {parseMarkdown(text).map((b, i) => {
        switch (b.type) {
          case "code":
            return <pre key={i} className="overflow-x-auto rounded-lg border border-border/60 bg-muted/50 px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed">{b.text}</pre>;
          case "heading":
            return <p key={i} className={cn("pt-1 font-semibold tracking-tight text-foreground", b.level <= 2 && "text-[1.0625rem]")}><Inline text={b.text} /></p>;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={cn("space-y-1 pl-5 marker:text-muted-foreground", b.ordered ? "list-decimal" : "list-disc")}>
                {b.items.map((it, j) => <li key={j} className="pl-1"><Inline text={it} /></li>)}
              </Tag>
            );
          }
          case "table":
            return (
              <Fragment key={i}>
              {/* A phone gets each row as a small block (first cell as its label), so a command column is not
                  squeezed into three-line wraps; from sm up it is a table. */}
              <StackedTable table={b} />
              <div className="-mx-1 hidden overflow-x-auto px-1 sm:block">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      {b.header.map((h, j) => <th key={j} scope="col" className={cn("py-2 pr-5 align-bottom font-semibold text-foreground last:pr-0", b.align[j] && ALIGN[b.align[j]])}><Inline text={h} plain nowrap={NOWRAP_TABLE} /></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-b border-border/50 last:border-0">
                        {r.map((c, k) => <td key={k} className={cn("py-2 pr-5 align-top text-foreground/80 last:pr-0", b.align[k] && ALIGN[b.align[k]])}><Cell text={c} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </Fragment>
            );
          default:
            return <p key={i} className="whitespace-pre-wrap"><Inline text={b.text} /></p>;
        }
      })}
    </div>
  );
}
