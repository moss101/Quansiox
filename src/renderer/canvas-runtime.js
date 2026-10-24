/**
 * The canvas runtime.
 *
 * A canvas in Grok Bot is not a static document: it is a live JavaScript
 * application. The canvas page imports TWO modules as blob URLs — a *runtime*
 * module and a *user* module — and the runtime's `mountCanvas(userUrl)` loads
 * the user module and gives it a small API:
 *
 *   window.__cursorCanvas = {
 *     tokenParam: string,
 *     state:      Map<string, unknown>,   // the page's own state
 *     data:       Map<string, unknown>,   // the data the agent passed in
 *     reportError(error): void,
 *   }
 *
 * This is that runtime for Quansiox, with the same shape and the same
 * contract, renamed for the local product (`__quansioxCanvas`).
 *
 * The runtime is loaded from a blob URL by the page, so it must be a
 * self-contained ES module with NO imports of its own — a blob module cannot
 * resolve a relative import.
 *
 * The user module receives the API as its default export, and may render
 * into the page's #root.
 */

/** The API handed to the user module. */
function createApi({ data, state, theme, reportError }) {
  const api = {
    tokenParam: '',
    state: state instanceof Map ? state : new Map(Object.entries(state ?? {})),
    data: data instanceof Map ? data : new Map(Object.entries(data ?? {})),
    theme: theme ?? {},
    reportError: typeof reportError === 'function' ? reportError : () => {},
    /**
     * Render a DOM node into the page's root, REPLACING what is there.
     * A canvas normally calls this once with its whole view; use `append`
     * for incremental updates.
     */
    render(node) {
      const root = document.getElementById('root');
      if (!root) return;
      root.replaceChildren();
      if (node) root.appendChild(node);
    },
    /** Add a DOM node to the page's root without clearing it. */
    append(node) {
      const root = document.getElementById('root');
      if (!root || !node) return;
      root.appendChild(node);
    },
    /** Build an element without a framework. */
    el(tag, props = {}, ...children) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props ?? {})) {
        if (key === 'class' || key === 'className') node.className = String(value);
        else if (key === 'style' && value && typeof value === 'object') Object.assign(node.style, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'text') node.textContent = String(value);
        else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, String(value));
      }
      for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.appendChild(typeof child === 'string' || typeof child === 'number'
          ? document.createTextNode(String(child))
          : child);
      }
      return node;
    },
  };
  return api;
}

/**
 * Mount a user module.
 *
 * The API is ALWAYS the runtime's, merged over whatever the page's bootstrap
 * put on `window.__quansioxCanvas` (its `data`, `state` and `reportError`).
 * The page cannot provide `render` or `el` — those are the runtime's job.
 *
 * @param {string} userUrl  a blob: URL for the user module
 * @returns {Promise<object>} the API the user module was given
 */
export async function mountCanvas(userUrl) {
  const base = window.__quansioxCanvas ?? {};
  const api = {
    ...base,
    ...createApi({
      data: base.data,
      state: base.state,
      theme: base.theme,
      reportError: base.reportError,
    }),
  };
  // Publish the merged API, so a user module that reads
  // `window.__quansioxCanvas` sees the same object it was handed.
  window.__quansioxCanvas = api;
  const userModule = await import(userUrl);
  const mount = userModule.default ?? userModule.mount;
  if (typeof mount === 'function') {
    await mount(api);
  } else if (userModule.default) {
    // A module whose default export is a component: give it the API and let
    // it render itself into the root.
    const rendered = userModule.default(api);
    if (rendered && typeof rendered === 'object' && 'nodeType' in rendered) api.render(rendered);
  } else {
    throw new Error('the canvas module exports no default and no mount()');
  }
  return api;
}

/** A minimal built-in runtime, used when a canvas ships no runtime of its own. */
export default { mountCanvas };
