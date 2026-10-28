/*
 * Completions bar chart for the reports page, a progressive enhancement.
 *
 * Builds one SVG bar per row of #completions-table, with HTML labels for the first day, the last
 * day and the maximum value, and then reveals #completions-chart. The rendered table rows are the
 * chart's only data source, so the chart cannot disagree with the table. Without JavaScript, or
 * if anything below throws, the figure keeps its hidden attribute and the table alone is the
 * report. For an invalid range the page renders neither element, and the script does nothing.
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // A fixed 3:1 viewBox that CSS scales to the available width, whatever the number of bars. The
  // SVG holds only the plot; the labels are HTML beside and below it, so they keep their CSS size
  // however far the SVG is scaled.
  const WIDTH = 720;
  const HEIGHT = 240;
  const PLOT_W = WIDTH;
  // Bars stand on the axis line, whose 1-unit stroke fills the bottom unit row.
  const BASELINE_Y = HEIGHT - 1;
  const PLOT_H = BASELINE_Y;
  // Caps a short range's bars, so a single day reads as a bar rather than a filled panel.
  const MAX_BAR_W = 48;

  const ARIA_LABEL =
    'Bar chart of tasks completed per day. The same data is shown in the completions table.';

  /** Rounds to two decimals, which keeps the markup of up to 366 bars small. */
  const round2 = (value) => Math.round(value * 100) / 100;

  /** Creates an SVG element with each attribute set to its value as a string. */
  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, String(value));
    }
    return element;
  }

  /** Appends a `<title>` tooltip whose content is set as text, never parsed as markup. */
  function appendTitle(element, text) {
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = text;
    element.appendChild(title);
  }

  /** Creates an HTML `span.chart-label` with `modifier` whose content is set as text. */
  function htmlLabel(text, modifier) {
    const label = document.createElement('span');
    label.className = `chart-label ${modifier}`;
    label.textContent = text;
    return label;
  }

  /**
   * Reads one bar per table row. `day` and `countText` are the attribute strings exactly as
   * rendered, copied verbatim onto the bars so each bar's data-day and data-count equal its
   * row's. `count` is used only for geometry, so a malformed value draws as 0.
   */
  function readBars(rows) {
    const bars = [];
    for (const row of rows) {
      const day = row.getAttribute('data-day') || '';
      const countText = row.getAttribute('data-count') || '0';
      const parsed = Number.parseInt(countText, 10);
      const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      bars.push({ day, countText, count });
    }
    return bars;
  }

  /**
   * Builds the complete chart off-DOM as a `div.chart-area`: the SVG plot (each bar's hit area
   * and bar, then the baseline axis), then the HTML value labels and day labels that app.css
   * places beside and below it.
   */
  function buildChart(bars) {
    let maxCount = 0;
    for (const bar of bars) {
      if (bar.count > maxCount) {
        maxCount = bar.count;
      }
    }
    // The scale's floor of 1 makes an all-zero range draw zero-height bars instead of dividing
    // by zero.
    const scale = Math.max(1, maxCount);
    const n = bars.length;
    const slot = PLOT_W / n;
    const gap = Math.min(slot * 0.2, 4);
    // Each bar is centred in its slot; only ranges under 14 days reach the cap.
    const barWidth = round2(Math.max(Math.min(slot - gap, MAX_BAR_W), 0.5));

    const svg = svgElement('svg', {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      role: 'img',
      'aria-label': ARIA_LABEL,
      class: 'completions-chart-svg',
      focusable: 'false',
    });

    // Bars are the chart's only rect elements: the tests require exactly one rect per table
    // row, so the axis is a line, each hit area a path, and nothing else is a rect.
    bars.forEach((bar, i) => {
      const tooltip = `${bar.day}: ${bar.countText}`;
      // The bar's whole slot answers the pointer with its tooltip, so a zero-height or thin bar
      // can still be hovered. It precedes the rect, which therefore stays on top where drawn.
      // fill and pointer-events are attributes, so no stylesheet is needed to keep it unpainted.
      const x0 = round2(i * slot);
      const x1 = round2((i + 1) * slot);
      const hit = svgElement('path', {
        class: 'chart-hit',
        d: `M${x0} 0H${x1}V${BASELINE_Y}H${x0}Z`,
        fill: 'none',
        'pointer-events': 'all',
      });
      appendTitle(hit, tooltip);
      svg.appendChild(hit);

      const height = round2((bar.count / scale) * PLOT_H);
      const rect = svgElement('rect', {
        class: 'chart-bar',
        x: round2(i * slot + (slot - barWidth) / 2),
        y: round2(BASELINE_Y - height),
        width: barWidth,
        height,
        'data-day': bar.day,
        'data-count': bar.countText,
      });
      appendTitle(rect, tooltip);
      svg.appendChild(rect);
    });

    svg.appendChild(
      svgElement('line', {
        class: 'chart-axis',
        x1: 0,
        y1: BASELINE_Y + 0.5,
        x2: WIDTH,
        y2: BASELINE_Y + 0.5,
      }),
    );

    // The labels repeat what the image's aria-label and the table already convey, so assistive
    // technology skips them, as it skipped them as presentational children of the role=img SVG.
    const yLabels = document.createElement('div');
    yLabels.className = 'chart-y-labels';
    yLabels.setAttribute('aria-hidden', 'true');
    // The top of the plot is the maximum. When every count is 0, the scale's floor makes the top
    // stand for 1, so it stays unlabelled and the baseline's 0 is the maximum, labelled once.
    if (maxCount > 0) {
      yLabels.appendChild(htmlLabel(String(maxCount), 'chart-label-max'));
    }
    yLabels.appendChild(htmlLabel('0', 'chart-label-zero'));

    const xLabels = document.createElement('div');
    xLabels.className = 'chart-x-labels';
    xLabels.setAttribute('aria-hidden', 'true');
    // A day label is one slot wide, so it centres under its bar when its text fits the slot.
    xLabels.style.setProperty('--chart-slot', `${round2(100 / n)}%`);
    xLabels.appendChild(htmlLabel(bars[0].day, 'chart-label-day'));
    // A one-day range has a single day, labelled once.
    if (n > 1) {
      xLabels.appendChild(htmlLabel(bars[n - 1].day, 'chart-label-day'));
    }

    const area = document.createElement('div');
    area.className = 'chart-area';
    area.appendChild(svg);
    area.appendChild(yLabels);
    area.appendChild(xLabels);
    return area;
  }

  function render() {
    const figure = document.getElementById('completions-chart');
    const table = document.getElementById('completions-table');
    if (figure === null || table === null) {
      return;
    }
    if (figure.querySelector('svg') !== null) {
      return;
    }
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) {
      return;
    }

    const fragment = document.createDocumentFragment();
    fragment.appendChild(buildChart(readBars(rows)));
    // One insertion into the live document, after the figure's caption.
    figure.appendChild(fragment);
    figure.removeAttribute('hidden');
  }

  // A deferred script runs before DOMContentLoaded, so either path draws the chart before the
  // load event.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
})();
