/* Classify PDF lines for the reading-content filter. */
'use strict';
R.text = (() => {
  function decorate(lines, width, height) {
    for (const line of lines) {
      line.column ??= line.x + line.w / 2 < width / 2 ? 0 : 1;
      const inMargin = line.y < height * .08 || line.y > height * .92;
      const pageNumber = /^(?:[-–—·]\s*)?(?:\d{1,5}|[ivxlcdm]{1,8})(?:\s*[-–—·])?$/i;
      line.role = inMargin && pageNumber.test(line.text.trim()) ? 'page-number' : 'content';
    }
    return lines;
  }

  function sequence(lines, mode) {
    return lines.flatMap((line, index) =>
      mode === 'all' || (line.role !== 'page-number' && line.role !== 'running-header') ? [index] : []);
  }

  return { decorate, sequence };
})();
