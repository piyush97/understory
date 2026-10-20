import type { Diagram } from "../../domain/explanation";
import { renderDiagramSvg } from "../../domain/diagram";

type DiagramPlateProps = {
  diagram: Diagram;
  figure?: string;
  compact?: boolean;
};

export function DiagramPlate({ diagram, figure = "1", compact = false }: DiagramPlateProps) {
  const svg = renderDiagramSvg(diagram);
  return (
    <figure class={compact ? "diagram-plate diagram-plate--compact" : "diagram-plate"} id="diagram">
      <div class="diagram-plate__header">
        <span class="diagram-plate__fig">Fig. {figure}</span>
        <span class="diagram-plate__hint" aria-hidden="true">
          Scroll →
        </span>
        <span class="diagram-plate__kind">{diagram.conceptual ? "Conceptual" : "Measured"}</span>
      </div>
      <div
        class={compact ? "diagram-canvas diagram-canvas--compact" : "diagram-canvas"}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <figcaption class="diagram-caption">
        <span class="diagram-caption__title">{diagram.title}</span>
        <span class="diagram-caption__body">{diagram.description}</span>
        {diagram.caption ? <span class="diagram-caption__note">{diagram.caption}</span> : null}
      </figcaption>
    </figure>
  );
}
