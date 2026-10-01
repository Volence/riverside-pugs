import { useMemo } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { parseRichText, type Block, type Inline } from '../richText';

function inline(nodes: Inline[]): ComponentChildren[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text': return n.text;
      case 'br': return <br key={i} />;
      case 'strong': return <strong key={i}>{inline(n.children)}</strong>;
      case 'em': return <em key={i}>{inline(n.children)}</em>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{inline(n.children)}</a>;
    }
  });
}

/** Headings sit under the panel's own h3, so # is an h3, ## an h4, ### an h5. */
function block(b: Block, i: number) {
  if (b.kind === 'heading') {
    const Tag = (['h3', 'h4', 'h5'] as const)[b.level - 1]!;
    return <Tag key={i} class={`richtext__h${b.level}`}>{inline(b.children)}</Tag>;
  }
  if (b.kind === 'list') {
    const items = b.items.map((it, n) => <li key={n}>{inline(it)}</li>);
    return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
  }
  return <p key={i}>{inline(b.children)}</p>;
}

/** Text in the safe markdown subset (web/src/richText.ts), as elements.
 *  Never sets HTML: every string goes in as a text child. */
export function RichText({ text, class: cls }: { text: string; class?: string }) {
  const blocks = useMemo(() => parseRichText(text), [text]);
  return <div class={cls ? `richtext ${cls}` : 'richtext'}>{blocks.map(block)}</div>;
}
