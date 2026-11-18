import { Fragment } from "react";
import { parseInline, parseMarkdown } from "../../markdown";

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((p, i) => {
        switch (p.type) {
          case "code": return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{p.text}</code>;
          case "bold": return <strong key={i} className="font-semibold">{p.text}</strong>;
          case "italic": return <em key={i}>{p.text}</em>;
          case "link": return <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">{p.text}</a>;
          default: return <Fragment key={i}>{p.text}</Fragment>;
        }
      })}
    </>
  );
}

/** Assistant text as markdown (the subset in markdown.ts), rendered as elements, never as HTML. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words">
      {parseMarkdown(text).map((b, i) => {
        switch (b.type) {
          case "code":
            return <pre key={i} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed">{b.text}</pre>;
          case "heading":
            return <p key={i} className={b.level <= 2 ? "text-base font-semibold" : "font-semibold"}><Inline text={b.text} /></p>;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return <Tag key={i} className={b.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</Tag>;
          }
          default:
            return <p key={i} className="whitespace-pre-wrap"><Inline text={b.text} /></p>;
        }
      })}
    </div>
  );
}
