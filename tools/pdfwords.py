"""Find phrases in a PDF by word coordinates (pdftotext -bbox), for building snippets from a script."""
import html
import re
import subprocess
from collections import defaultdict

WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>')
PAGE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')


def norm(t):
    return (t.replace('’', "'").replace('“', '"').replace('”', '"')
            .replace('–', '-').replace('—', '-').strip().lower())


class PdfWords:
    def __init__(self, path):
        out = subprocess.run(['pdftotext', '-bbox', path, '-'], capture_output=True, text=True, check=True).stdout
        self.pages, self.height = [], []
        for chunk in out.split('<page ')[1:]:
            m = PAGE.search('<page ' + chunk)
            self.height.append(float(m.group(2)))
            self.pages.append([(float(a), float(b), float(c), float(d), html.unescape(w))
                               for a, b, c, d, w in WORD.findall(chunk)])

    def _find(self, page, phrase, nth=0, after=0):
        words = self.pages[page - 1]
        toks = [norm(t) for t in phrase.split()]
        hits = []
        for i in range(after, len(words) - len(toks) + 1):
            if all(norm(words[i + k][4]) == toks[k] for k in range(len(toks))):
                hits.append(i)
        if len(hits) <= nth:
            raise ValueError(f'p{page}: not found: {phrase!r} (hits={len(hits)})')
        return hits[nth], hits[nth] + len(toks)

    def text(self, page, *phrases, nth=0):
        """Text snippet: each phrase is matched on its own; returns (rects, text) in PDF points."""
        rects, parts = [], []
        for ph in phrases:
            i, j = self._find(page, ph, nth)
            rects += self._line_rects(page, self.pages[page - 1][i:j])
            parts.append(' '.join(w[4] for w in self.pages[page - 1][i:j]))
        return rects, ' '.join(parts)

    def span(self, page, start, end, nth=0):
        """Text snippet from the start phrase through the end phrase, in reading order."""
        i, _ = self._find(page, start, nth)
        _, j = self._find(page, end, 0, after=i)
        words = self.pages[page - 1][i:j]
        return self._line_rects(page, words), ' '.join(w[4] for w in words)

    def area(self, page, start, end, nth=0, pad=6, x0=None, x1=None):
        """Area snippet: the box around every word from start through end (top-left origin)."""
        i, _ = self._find(page, start, nth)
        _, j = self._find(page, end, 0, after=i)
        ws = self.pages[page - 1][i:j]
        box = [min(w[0] for w in ws) - pad, min(w[1] for w in ws) - pad, max(w[2] for w in ws) + pad, max(w[3] for w in ws) + pad]
        if x0 is not None: box[0] = x0
        if x1 is not None: box[2] = x1
        return box, ' '.join(w[4] for w in ws)

    def to_pdf(self, page, box):
        h = self.height[page - 1]
        return [round(box[0], 2), round(h - box[3], 2), round(box[2], 2), round(h - box[1], 2)]

    def _line_rects(self, page, words):
        lines = defaultdict(list)
        for w in words:
            key = next((k for k in lines if abs(k - w[1]) < 3), w[1])
            lines[key].append(w)
        out = []
        for ws in lines.values():
            box = [min(w[0] for w in ws), min(w[1] for w in ws), max(w[2] for w in ws), max(w[3] for w in ws)]
            out.append([page, *self.to_pdf(page, box)])
        return out
