import type { Child } from "hono/jsx";
import type { Block, Inline } from "../../domain/explanation";

export function InlineRuns({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((run) => {
        let content: Child = run.text;
        if (run.code) content = <code>{run.text}</code>;
        else if (run.strong) content = <strong>{run.text}</strong>;
        else if (run.em) content = <em>{run.text}</em>;

        return (
          <>
            {content}
            {run.cite ? (
              <sup class="cite">
                <a href={`#source-${run.cite}`} aria-label={`See source ${run.cite.slice(1)}`}>
                  {run.cite.slice(1)}
                </a>
              </sup>
            ) : null}
          </>
        );
      })}
    </>
  );
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block) => (
        <BlockView block={block} />
      ))}
    </>
  );
}

export function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "p":
      return (
        <p>
          <InlineRuns runs={block.runs} />
        </p>
      );
    case "list": {
      const items = block.items.map((item) => (
        <li>
          <InlineRuns runs={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return (
        <figure class="code-block">
          <pre>
            <code>{block.code}</code>
          </pre>
          {block.caption ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      );
    case "quote":
      return (
        <blockquote>
          <p>
            <InlineRuns runs={block.runs} />
          </p>
          {block.attribution ? <footer>{block.attribution}</footer> : null}
        </blockquote>
      );
    case "note":
      return (
        <aside class={`note note--${block.tone}`}>
          <p class="note__title">{block.title}</p>
          <div class="note__body">
            <InlineRuns runs={block.runs} />
          </div>
        </aside>
      );
  }
}
