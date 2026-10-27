/*
 * Completions bar chart for the reports page, a progressive enhancement.
 *
 * Builds one SVG bar per row of #completions-table and then reveals #completions-chart. The
 * rendered table rows are the chart's only data source, so the chart cannot disagree with the
 * table. Without JavaScript, or if anything below throws, the figure keeps its hidden attribute
 * and the table alone is the report. For an invalid range the page renders neither element, and
 * the script does nothing.
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // A fixed 3:1 viewBox that CSS scales to the available width, whatever the number of bars.
  const WIDTH = 720;
  const HEIGHT = 240;
  const PAD_LEFT = 40; // Room for the maximum-value label.
  const PAD_RIGHT = 8;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 24; // Room for the first and last day labels.
  const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
  const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const BASELINE_Y = PAD_TOP + PLOT_H;
  const LABEL_OFFSET = 6;

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

  /** Creates a `text.chart-label` whose content is set as text, never parsed as markup. */
  function textLabel(text, x, y, anchor) {
    const label = svgElement('text', {
      class: 'chart-label',
      x,
      y,
      'text-anchor': anchor,
    });
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

  /** Builds the complete chart off-DOM: bars, then the baseline axis, then the labels. */
  function buildChart(bars) {
    let maxCount = 0;
    for (const bar of bars) {
      if (bar.count > maxCount) {
        maxCount = bar.count;
      }
    }
    // The scale's floor of 1 makes an all-zero range draw zero-height bars instead of dividing
    // by zero. The maximum label still shows the true maximum, 0 included.
    const scale = Math.max(1, maxCount);
    const n = bars.length;
    const slot = PLOT_W / n;
    const gap = Math.min(slot * 0.2, 4);
    const barWidth = round2(Math.max(slot - gap, 0.5));

    const svg = svgElement('svg', {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      role: 'img',
      'aria-label': ARIA_LABEL,
      class: 'completions-chart-svg',
      focusable: 'false',
      // PAD_LEFT fits a three-digit maximum at the small-screen label size. A larger maximum
      // extends into the page padding instead of being clipped at the SVG's edge.
      overflow: 'visible',
    });

    // Bars are the chart's only rect elements: the tests require exactly one rect per table
    // row, so the axis is a line and nothing else (background, frame, legend) is a rect.
    bars.forEach((bar, i) => {
      const height = round2((bar.count / scale) * PLOT_H);
      const rect = svgElement('rect', {
        class: 'chart-bar',
        x: round2(PAD_LEFT + i * slot + gap / 2),
        y: round2(BASELINE_Y - height),
        width: barWidth,
        height,
        'data-day': bar.day,
        'data-count': bar.countText,
      });
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${bar.day}: ${bar.countText}`;
      rect.appendChild(title);
      svg.appendChild(rect);
    });

    svg.appendChild(
      svgElement('line', {
        class: 'chart-axis',
        x1: PAD_LEFT,
        y1: BASELINE_Y,
        x2: WIDTH - PAD_RIGHT,
        y2: BASELINE_Y,
      }),
    );

    const dayLabelY = HEIGHT - LABEL_OFFSET;
    const valueLabelX = PAD_LEFT - LABEL_OFFSET;
    svg.appendChild(textLabel(bars[0].day, PAD_LEFT, dayLabelY, 'start'));
    // A one-day range has a single day, labelled once.
    if (n > 1) {
      svg.appendChild(textLabel(bars[n - 1].day, WIDTH - PAD_RIGHT, dayLabelY, 'end'));
    }
    const maxLabel = textLabel(String(maxCount), valueLabelX, PAD_TOP + 4, 'end');
    maxLabel.setAttribute('dominant-baseline', 'hanging');
    svg.appendChild(maxLabel);
    svg.appendChild(textLabel('0', valueLabelX, BASELINE_Y, 'end'));

    return svg;
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
