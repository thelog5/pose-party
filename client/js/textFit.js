/* Small dependency-free text fitter for copy that may wrap inside fixed art.
   It is shared by robot.js (fit before reveal) and gameplayFeedback.js (refit
   after fonts, viewport, or text change), without creating an import cycle. */

export function fitWrappedTextToBox(node, options={}){
  if(!node) return false;

  /* Clear the previous pixel fit first so container-query units resolve from
     the authored Figma size again after a viewport or parent-size change. */
  node.style.removeProperty("font-size");
  const base = parseFloat(getComputedStyle(node).fontSize);
  const width = node.clientWidth;
  const height = node.clientHeight;
  if(!Number.isFinite(base) || base <= 0 || width <= 0 || height <= 0)
    return false;

  const min = Math.max(.75, Number(options.minSize) || 1.5);
  const tolerance = Number(options.tolerance) || .75;
  const fits = () => node.scrollWidth <= width + tolerance &&
    node.scrollHeight <= height + tolerance;

  node.style.fontSize = base + "px";
  let best = min;
  if(fits()) best = base;
  else{
    /* Binary search keeps the largest readable size that fits both axes.
       `overflow-wrap:anywhere` in CSS guarantees even an edited-in long token
       has a legal break, so the minimum is a final guardrail, not a clip. */
    let low = min;
    let high = base;
    node.style.fontSize = low + "px";
    if(!fits()){
      low = .75;
      best = .75;
      node.style.fontSize = low + "px";
    }
    for(let pass=0; pass<14; pass++){
      const size = (low + high) / 2;
      node.style.fontSize = size + "px";
      if(fits()){
        best = size;
        low = size;
      }else high = size;
    }
  }

  node.style.fontSize = best + "px";
  node.dataset.fitLines = "2";
  return fits();
}
