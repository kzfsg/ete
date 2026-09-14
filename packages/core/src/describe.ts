import type { ResolvedEntry } from './schema.js';

function selectorLabel(selector: string): string {
  const named = /^(?:role=\w+\[name=|text=|label=|placeholder=)"?([^"\]]+)"?\]?$/.exec(selector);
  if (named) return `"${named[1]}"`;
  return selector.replace(/^css=/, '');
}

export function describeEntry(entry: ResolvedEntry): string {
  switch (entry.kind) {
    case 'navigate': return `go to ${entry.url}`;
    case 'click': return 'selector' in entry.target ? `click ${selectorLabel(entry.target.selector)}` : `click at (${entry.target.point.x}, ${entry.target.point.y})`;
    case 'type': return 'selector' in entry.target ? `type "${entry.text}" into ${selectorLabel(entry.target.selector)}` : `type "${entry.text}" at (${entry.target.point.x}, ${entry.target.point.y})`;
    case 'press': return `press ${entry.key}`;
    case 'scroll': return `scroll ${entry.dy > 0 ? 'down' : 'up'}`;
    case 'wait': return `wait ${entry.ms} ms`;
    case 'textVisible': return `expect the page shows "${entry.text}"`;
    case 'elementVisible': return 'selector' in entry.target ? `expect ${selectorLabel(entry.target.selector)} is visible` : 'expect element is visible';
    case 'urlMatches': return `expect the URL matches ${entry.pattern}`;
  }
}
