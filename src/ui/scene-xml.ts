// Scene XML parser (37_T declarative UI): reads a scene XML + its import
// chain and produces a UiElement tree for the Vue UI renderer.
// Modules supported (name -> behavior) per Engine.cfg + XModules:
// background, body, element, image, text, textBox, button, buttonSkin,
// horizontalFitList, verticalList, keyboard, options, about, scoreBoard,
// commandSetScene, commandBackScene, commandColorAction, commandAdd,
// commandAdjustWidth/Height, commandAutoWidth, commandTextIfRoot, font.

export interface UiCommand {
  kind: 'setScene' | 'backScene' | 'colorAction' | 'add' | 'adjustWidth' | 'adjustHeight' | 'autoWidth' | 'textIfRoot';
  path?: string;
  from?: string;
  percentage?: number;
  value?: [number, number];
  active?: [number, number, number, number];
  inactive?: [number, number, number, number];
  root?: string;
  nonRoot?: string;
}

export interface UiElement {
  tag: string;
  attrs: Record<string, string>;
  children: UiElement[];
  commands: UiCommand[];
  commandsUpdate: UiCommand[];
  commandsSize: UiCommand[];
}

export interface SceneXmlBundle {
  /** Scene root document. */
  root: UiElement;
  /** Import chain keyed by reference (e.g. _window, _buttonRU, _bskin1, _background). */
  refs: Map<string, UiElement>;
  /** Spritefont refs (path only in this port). */
  fonts: Map<string, string>;
  /** Texture aliases -> asset url. */
  textures: Map<string, string>;
  /** Model config (name -> detail + flares). */
  models: Map<string, { detail: number; engineFlares: number[][]; colorFlares: number[][] }>;
  /** scoreBoard requests. */
  scoreboards: { type: string; save: string }[];
  /** Scene-level extras with dedicated Vue views. */
  hasOptions: boolean;
  hasAbout: boolean;
  hasKeyboard: boolean;
  backgroundPath: string | null;
}

const CONTENT = 'content/';

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'text/xml');
}

function elementToUi(el: Element): UiElement {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const children: UiElement[] = [];
  const commands: UiCommand[] = [];
  const commandsUpdate: UiCommand[] = [];
  const commandsSize: UiCommand[] = [];
  for (const c of Array.from(el.children)) {
    const name = c.tagName;
    if (name.startsWith('command')) {
      commands.push(commandFrom(name, c));
      continue;
    }
    if (name === 'background') {
      commands.push({ kind: 'setScene', path: c.getAttribute('path') ?? '' });
    }
    children.push(elementToUi(c));
  }
  return { tag: el.tagName, attrs, children, commands, commandsUpdate, commandsSize };
}

function commandFrom(name: string, el: Element): UiCommand {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  switch (name) {
    case 'commandSetScene':
      return { kind: 'setScene', path: attrs.path ?? '' };
    case 'commandBackScene':
      return { kind: 'backScene' };
    case 'commandColorAction':
      return {
        kind: 'colorAction',
        active: parseColor(attrs.active),
        inactive: parseColor(attrs.inactive),
      };
    case 'commandAdd':
      return { kind: 'add', value: parseVec2(attrs.value) };
    case 'commandAdjustWidth':
      return { kind: 'adjustWidth', from: attrs.from, percentage: Number(attrs.percentage ?? 1) };
    case 'commandAdjustHeight':
      return { kind: 'adjustHeight', from: attrs.from, percentage: Number(attrs.percentage ?? 1) };
    case 'commandAutoWidth':
      return { kind: 'autoWidth' };
    case 'commandTextIfRoot':
      return { kind: 'textIfRoot', root: attrs.root ?? '', nonRoot: attrs.nonRoot ?? '' };
    default:
      return { kind: 'add' };
  }
}

export function parseColor(s: string | null): [number, number, number, number] {
  if (!s) return [1, 1, 1, 1];
  const p = s.split('|').map(Number);
  if (p.length === 3) return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, 1];
  return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, (p[3] ?? 255) / 255];
}

export function parseVec2(s: string | null): [number, number] {
  if (!s) return [0, 0];
  const p = s.split('|').map(Number);
  return [p[0] || 0, p[1] || 0];
}

function attr(el: Element | UiElement, name: string): string | null {
  return 'getAttribute' in (el as Element)
    ? (el as Element).getAttribute(name)
    : ((el as UiElement).attrs[name] ?? null);
}

/** Load one scene XML + imports. `path` is a content-relative path. */
export async function loadSceneXml(
  path: string,
  basePath: string,
  seen = new Set<string>(),
): Promise<SceneXmlBundle> {
  const bundle: SceneXmlBundle = {
    root: { tag: 'scene', attrs: {}, children: [], commands: [], commandsUpdate: [], commandsSize: [] },
    refs: new Map(),
    fonts: new Map(),
    textures: new Map(),
    models: new Map(),
    scoreboards: [],
    hasOptions: false,
    hasAbout: false,
    hasKeyboard: false,
    backgroundPath: null,
  };
  await loadInto(bundle, path, basePath, seen);
  return bundle;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const BASE = (import.meta.env.BASE_URL + 'content/').replace(/([^:])\/\//g, '$1/');

function urlFor(contentPath: string): string {
  // "Content/Import/X.xml" -> base + Import/X.xml
  const rel = contentPath.replace(/^Content\//i, '');
  return BASE + rel;
}

async function loadInto(
  bundle: SceneXmlBundle, path: string, basePath: string, seen: Set<string>,
): Promise<void> {
  const key = path.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  const text = await fetchText(urlFor(path));
  if (!text) return;
  const doc = parseXml(text);
  const rootEl = doc.documentElement;
  if (!rootEl) return;
  const ui = elementToUi(rootEl);
  if (rootEl.tagName === 'scene') {
    // Merge: imports first (for refs), then own nodes.
    for (const child of ui.children) {
      if (child.tag === 'import') {
        const value = child.attrs.value ?? '';
        if (value) await loadInto(bundle, value, basePath, seen);
        continue;
      }
      if (child.tag === 'scoreBoard') {
        bundle.scoreboards.push({ type: child.attrs.type ?? 'TT', save: child.attrs.save ?? '' });
        continue;
      }
      if (child.tag === 'options') {
        bundle.hasOptions = true;
        continue;
      }
      if (child.tag === 'about') {
        bundle.hasAbout = true;
        continue;
      }
      if (child.tag === 'keyboard') {
        bundle.hasKeyboard = true;
        continue;
      }
      if (child.tag === 'background') {
        bundle.backgroundPath = child.attrs.path ?? bundle.backgroundPath;
        continue;
      }
    }
    // Evaluate `element` ref-targets in order.
    for (const child of ui.children) {
      if (child.tag === 'element') {
        bundle.refs.set(child.attrs.reference ?? '', child);
      }
    }
  } else {
    // Import fragment (<import> root): background/body/buttonSkin/font/
    // textures/models + generic `element`?-less nodes.
    for (const child of ui.children) {
      await processImportNode(bundle, child, basePath, seen);
    }
  }
}

async function processImportNode(
  bundle: SceneXmlBundle, node: UiElement, basePath: string, seen: Set<string>,
): Promise<void> {
  switch (node.tag) {
    case 'import': {
      const value = node.attrs.value ?? '';
      if (value) await loadInto(bundle, value, basePath, seen);
      break;
    }
    case 'background':
      bundle.backgroundPath = node.attrs.path ?? bundle.backgroundPath;
      break;
    case 'font':
      bundle.fonts.set(node.attrs.reference ?? '', node.attrs.path ?? '');
      break;
    case 'textures': {
      for (const t of node.children) {
        if (t.tag === 'texture') {
          bundle.textures.set(t.attrs.name ?? '', t.attrs.directory ?? '');
        }
      }
      break;
    }
    case 'models': {
      for (const m of node.children) {
        if (m.tag !== 'model') continue;
        const engineFlares: number[][] = [];
        const colorFlares: number[][] = [];
        for (const f of m.children) {
          if (f.tag === 'engineFlares') {
            for (const fl of f.children) {
              if (fl.tag === 'engineFlare') engineFlares.push((fl.attrs.value ?? '').split('|').map(Number));
            }
          } else if (f.tag === 'colorFlares') {
            for (const fl of f.children) {
              if (fl.tag === 'colorFlare') colorFlares.push((fl.attrs.value ?? '').split('|').map(Number));
            }
          }
        }
        bundle.models.set(m.attrs.name ?? '', {
          detail: Number(m.attrs.detail ?? 1), engineFlares, colorFlares,
        });
      }
      break;
    }
    case 'body':
      bundle.refs.set(node.attrs.reference ?? '_body', node);
      break;
    case 'buttonSkin':
      bundle.refs.set(node.attrs.reference ?? '', node);
      break;
    case 'image':
    case 'text':
    case 'button':
      if (node.attrs.reference) bundle.refs.set(node.attrs.reference, node);
      break;
    default:
      if (node.attrs.reference) bundle.refs.set(node.attrs.reference, node);
      break;
  }
}

export { urlFor };
