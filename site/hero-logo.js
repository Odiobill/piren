"use strict";

// Piren hero logo animation.
//
// Adapted from the steward's prototype (~/Downloads/piren-dark.html). The
// prototype is a standalone HTML+JS demo; this module adapts it for the
// landing page hero. It needs a <g id="piren-hero-text"> inside the hero SVG.
//
// Sequence: "Pi" draws in (stroke), fills in, then morphs into "Piren" via a
// clip-path reveal, then settles. The continuous orbit/ring animation runs in
// CSS for the whole time. With prefers-reduced-motion, we skip the one-shot
// intro and render a static "Piren" immediately.

(function () {
  const group = document.getElementById("piren-hero-text");
  if (!group) return;

  const NS = "http://www.w3.org/2000/svg";
  const FONT = "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  const COLOR = "#ffffff";

  function makeText(content, fillOpacity, strokeOpacity) {
    const el = document.createElementNS(NS, "text");
    el.setAttribute("text-anchor", "middle");
    el.setAttribute("dominant-baseline", "central");
    el.setAttribute("font-family", FONT);
    el.setAttribute("font-size", 110);
    el.setAttribute("font-weight", 500);
    el.setAttribute("letter-spacing", -2);
    el.setAttribute("fill", COLOR);
    el.setAttribute("fill-opacity", fillOpacity ?? 1);
    el.setAttribute("stroke", COLOR);
    el.setAttribute("stroke-width", 2);
    el.setAttribute("stroke-opacity", strokeOpacity ?? 0);
    el.setAttribute("paint-order", "stroke");
    el.textContent = content;
    return el;
  }

  function animate(duration, easeFn, onTick, onDone) {
    let start = null;
    function tick(ts) {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      onTick(easeFn(p));
      if (p < 1) requestAnimationFrame(tick);
      else if (onDone) onDone();
    }
    requestAnimationFrame(tick);
  }

  const easeInOut = (p) => (p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p);
  const easeOut3 = (p) => 1 - Math.pow(1 - p, 3);

  // Reduced-motion: show a static wordmark, no one-shot intro. The orbit
  // animation is also disabled by the media query in style.css.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    group.appendChild(makeText("Piren", 1, 0));
    return;
  }

  function phase1() {
    group.innerHTML = "";
    const fill = makeText("Pi", 0, 0);
    const stroke = makeText("Pi", 0, 1);
    group.appendChild(fill);
    group.appendChild(stroke);
    const len = 900;
    stroke.style.strokeDasharray = len;
    stroke.style.strokeDashoffset = len;
    animate(
      1000,
      easeInOut,
      (p) => {
        stroke.style.strokeDashoffset = len * (1 - p);
      },
      () => {
        animate(
          400,
          easeOut3,
          (p) => {
            fill.setAttribute("fill-opacity", p);
            stroke.setAttribute("stroke-opacity", 1 - p);
          },
          () => {
            fill.setAttribute("fill-opacity", 1);
            stroke.setAttribute("stroke-opacity", 0);
            setTimeout(phase2, 1000);
          },
        );
      },
    );
  }

  function phase2() {
    group.innerHTML = "";
    const clipId = "piren-reveal-clip";
    const defs = document.createElementNS(NS, "defs");
    const clip = document.createElementNS(NS, "clipPath");
    clip.setAttribute("id", clipId);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("y", -90);
    rect.setAttribute("height", 180);
    rect.setAttribute("x", -400);
    rect.setAttribute("width", "370");
    clip.appendChild(rect);
    defs.appendChild(clip);
    group.appendChild(defs);

    const fullText = makeText("Piren", 1, 0);
    fullText.setAttribute("clip-path", `url(#${clipId})`);
    group.appendChild(fullText);

    animate(
      700,
      easeOut3,
      (p) => {
        rect.setAttribute("width", 370 + 190 * p);
      },
      () => {
        fullText.removeAttribute("clip-path");
        group.innerHTML = "";
        group.appendChild(makeText("Piren", 1, 0));
      },
    );
  }

  phase1();
})();
