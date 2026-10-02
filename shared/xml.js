// Minimal, dependency-free XML reader for DASH manifests. Works in the service worker,
// extension pages and Node tests (no DOMParser required). It is intentionally small:
// elements, attributes, text, comments, CDATA, processing instructions and doctype.
globalThis.XmlTools = (() => {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[name] ?? match;
  });
  const local = name => name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  function parse(text) {
    if (typeof text !== 'string') throw new Error('XML input must be text.');
    if (text.length > 20 * 1024 * 1024) throw new Error('XML document is too large.');
    const root = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
    const stack = [root];
    let i = 0;
    const attrRe = /([^\s=\/>]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { stack.at(-1).text += decode(text.slice(i)); break; }
      if (lt > i) stack.at(-1).text += decode(text.slice(i, lt));
      if (text.startsWith('<!--', lt)) { const end = text.indexOf('-->', lt + 4); if (end < 0) throw new Error('Unterminated XML comment.'); i = end + 3; continue; }
      if (text.startsWith('<![CDATA[', lt)) { const end = text.indexOf(']]>', lt + 9); if (end < 0) throw new Error('Unterminated CDATA.'); stack.at(-1).text += text.slice(lt + 9, end); i = end + 3; continue; }
      if (text.startsWith('<?', lt)) { const end = text.indexOf('?>', lt + 2); if (end < 0) throw new Error('Unterminated processing instruction.'); i = end + 2; continue; }
      if (text.startsWith('<!', lt)) {
        // DOCTYPE, possibly with an internal subset.
        let depth = 0, j = lt + 2;
        for (; j < text.length; j++) { if (text[j] === '[') depth++; else if (text[j] === ']') depth--; else if (text[j] === '>' && depth <= 0) break; }
        i = j + 1; continue;
      }
      // Find the tag end while respecting quoted attribute values.
      let j = lt + 1, quote = '';
      for (; j < text.length; j++) {
        const c = text[j];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= text.length) throw new Error('Unterminated XML tag.');
      const body = text.slice(lt + 1, j);
      i = j + 1;
      if (body[0] === '/') {
        const name = body.slice(1).trim();
        while (stack.length > 1 && stack.at(-1).name !== name) stack.pop(); // tolerate unclosed children
        if (stack.length > 1) stack.pop();
        continue;
      }
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const nameMatch = inner.match(/^\s*([^\s\/>]+)/);
      if (!nameMatch) throw new Error('Invalid XML tag.');
      const node = { name: nameMatch[1], local: local(nameMatch[1]), attrs: {}, children: [], text: '', parent: stack.at(-1) };
      attrRe.lastIndex = nameMatch[0].length;
      for (let m; (m = attrRe.exec(inner));) {
        const value = m[3] ?? m[4] ?? m[5] ?? '';
        node.attrs[m[1]] = decode(value);
        node.attrs[local(m[1])] ??= decode(value);
      }
      stack.at(-1).children.push(node);
      if (stack.length > 64) throw new Error('XML nesting is too deep.');
      if (!selfClosing) stack.push(node);
    }
    return root;
  }
  const children = (node, name) => (node?.children || []).filter(child => child.local === name);
  const child = (node, name) => (node?.children || []).find(child => child.local === name) || null;
  function find(node, name, out = []) {
    for (const item of node?.children || []) { if (item.local === name) out.push(item); find(item, name, out); }
    return out;
  }
  return { parse, children, child, find, decode };
})();
