// The rules of the UI checks (scripts/ci/ui-checks.mjs). Each rule reads a TypeScript syntax tree (ts.createSourceFile, no type checker, no new dependency) or a stylesheet and reports `{ line, message }`.
// A rule is data: an id, a scope (which files it reads), a one-line statement of the law it keeps, and a `check`. The driver runs every rule over every file in scope, applies the allow list
// (scripts/ci/ui-checks-allow.json: a counted, reasoned ratchet) and fails on anything else. tests/ci/ui-checks.test.mjs holds one planted violation per rule and fails when a rule has none.
import ts from "typescript";

export const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/),
);
const COLOUR_FUNCTION = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
// Properties whose numbers are not lengths: a bare number there is not a pixel size.
const UNITLESS = new Set(["opacity", "zIndex", "flex", "flexGrow", "flexShrink", "order", "fontWeight", "lineHeight", "zoom", "scale", "aspectRatio", "gridColumn", "gridRow", "gridArea", "columns", "WebkitLineClamp", "lineClamp", "orphans", "widows", "fillOpacity", "strokeOpacity", "tabSize"]);
const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "summary", "Button", "ActionButton", "Link"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "switch", "checkbox", "option"]);
const KIT_PARTS = new Set(["Button", "ActionButton", "Input", "Select", "Textarea", "SectionCard", "RailCard"]);
const SPACING_PROPERTY = /^(?:padding|margin|gap|row-gap|column-gap|font-size)(?:-[a-z]+)?$/;
const DATA_LAYER = [/^@\/core\/db(\/|$)/, /^@supabase\//, /^@\/features\/lists/, /^@\/core\/auth\/(membership|orgs|invitations|claims|ensure-profile|platform-admin)/, /^@\/features\/[a-z-]+\/api\//];
const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const tagName = (el) => el.tagName.getText();
const attrOf = (el, name) => el.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
const isJsxElement = (n) => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n);
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every piece of literal text in a file, with its node: string literals, template heads/middles/tails. `attribute` is true for the string of a JSX attribute (the JSX parser decodes HTML entities there). */
export function* literals(sf) {
  const walk = function* (node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) yield { text: node.text, node, attribute: ts.isJsxAttribute(node.parent) };
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) yield { text: node.text, node, attribute: false };
    for (const child of node.getChildren(sf)) yield* walk(child);
  };
  yield* walk(sf);
}

/** The `style={{ ... }}` object literal of a JSX element, or null. */
const styleObject = (el) => {
  const a = attrOf(el, "style");
  const e = a?.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
  return e && ts.isObjectLiteralExpression(e) ? e : null;
};
function* styleEntries(sf) {
  const walk = function* (node) {
    if (isJsxElement(node)) {
      const obj = styleObject(node);
      if (obj) for (const p of obj.properties) if (ts.isPropertyAssignment(p)) yield { element: node, name: p.name.getText(sf).replace(/^["']|["']$/g, ""), value: p.initializer, node: p };
    }
    for (const child of node.getChildren(sf)) yield* walk(child);
  };
  yield* walk(sf);
}
const textOfValue = (v) => (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text : ts.isTemplateExpression(v) ? v.getText() : null);
const pxOf = (v) => {
  if (ts.isNumericLiteral(v)) return Number(v.text);
  const t = ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(v.text) : null;
  return t ? Number(t[1]) : null;
};
const isInteractive = (el) => INTERACTIVE_TAGS.has(tagName(el)) || Boolean(attrOf(el, "onClick")) || INTERACTIVE_ROLES.has(attrOf(el, "role")?.initializer?.text);

/** Does the expression contain a call to `.from("table")` or `.rpc("name")` (through wrapper calls such as qb(...))? */
function reachesDatabase(e) {
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return reachesDatabase(e.expression);
  if (ts.isPropertyAccessExpression(e)) return reachesDatabase(e.expression);
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  if (ts.isPropertyAccessExpression(callee) && ["from", "rpc"].includes(callee.name.text) && e.arguments[0] && (ts.isStringLiteralLike(e.arguments[0]) || ts.isTemplateExpression(e.arguments[0]))) return true;
  return reachesDatabase(callee) || e.arguments.some(reachesDatabase);
}
/** The method names a call chain goes through, outermost first (`sb.from("t").update(x).eq(...)` -> eq, update, from). */
const methodsOf = (e) => {
  const names = [];
  while (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) {
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) names.push(e.expression.name.text);
    e = ts.isCallExpression(e) ? e.expression : e.expression;
  }
  return names;
};
/**
 * Is the awaited result handled so that its `error` is looked at? Yes when: a function the project owns wraps the call (`one(...)`, `exactCount(...)`, `must("x", await ...)`, `ok(await ...)`: the wrapper throws or
 * returns the failure); the result is destructured with `error`, or read as `.error` in the function; or it is handed straight back to a caller that does.
 */
function errorHandled(aw, sf) {
  if (ts.isCallExpression(aw.expression) && ts.isIdentifier(aw.expression.expression)) return true;
  let child = aw;
  let p = aw.parent;
  while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)) {
    child = p;
    p = p.parent;
  }
  if (ts.isPropertyAccessExpression(p) && p.name.text === "error") return true;
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.arguments.includes(child)) return true;
  if (ts.isPropertyAssignment(p)) {
    // { k, r: await db.from(...) }: handled when the function reads `.r.error` afterwards.
    let fn = p;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    return new RegExp(`\\.${p.name.getText(sf)}\\??\\.error\\b`).test((fn ?? sf).getText(sf));
  }
  if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isConditionalExpression(p)) return true;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return ts.isObjectLiteralExpression(p.left) && p.left.properties.some((x) => x.name?.getText(sf) === "error");
  if (!ts.isVariableDeclaration(p)) return false;
  if (ts.isObjectBindingPattern(p.name)) return p.name.elements.some((el) => (el.propertyName ?? el.name).getText(sf) === "error");
  if (!ts.isIdentifier(p.name)) return ts.isArrayBindingPattern(p.name);
  let fn = p;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  return new RegExp(`\\b${p.name.text}\\??\\.error\\b`).test((fn ?? sf).getText(sf));
}

const inUi = (f) => f.startsWith("src/ui/");
const isTs = (f) => /\.tsx?$/.test(f);
const isTsx = (f) => f.endsWith(".tsx");
const isCss = (f) => f.endsWith(".css");
const notFixture = (f) => !f.startsWith("src/app/privacy/ui-fixtures/") && !f.includes("/parts/");
const kitOrFeature = (f) => isTsx(f) && f.startsWith("src/") && notFixture(f);

/** The rules. `check({ file, text, sf, base })` yields `{ line, message }`. `sf` is the syntax tree (TypeScript files only); `base` is the text of src/ui/base.css. */
export const RULES = [
  {
    id: "style-element",
    law: "CSS is carried once, in the stylesheet: no <style> element in the kit",
    scope: (f) => isTsx(f) && inUi(f),
    *check({ sf }) {
      const walk = function* (n) {
        if (isJsxElement(n) && tagName(n) === "style") yield { line: lineOf(sf, n), message: "a <style> element" };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "colour-literal",
    law: "colours are tokens (theme.css) and nowhere else: no hex, colour function or colour name in a kit string or stylesheet, template literals included",
    scope: (f) => f.startsWith("src/ui/") && f !== "src/ui/theme.css" && (isTs(f) || isCss(f)),
    *check({ sf, text, file }) {
      if (isCss(file)) {
        for (const [i, l] of stripComments(text).split("\n").entries()) {
          if ((HEX.test(l) && !/^\s*@import|url\(/.test(l)) || /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i.test(l)) yield { line: i + 1, message: `a colour literal in a stylesheet: ${l.trim().slice(0, 80)}` };
        }
        return;
      }
      for (const lit of literals(sf)) {
        if (HEX.test(lit.text) && !/^#[a-z]+$/i.test(lit.text.trim())) yield { line: lineOf(sf, lit.node), message: `a hex colour in a string: ${lit.text.slice(0, 60)}` };
        else if (COLOUR_FUNCTION.test(lit.text)) yield { line: lineOf(sf, lit.node), message: `a colour function in a string: ${lit.text.slice(0, 60)}` };
      }
      // A colour NAME is a plain word, so it is read only where a colour is being set: a property called color, background, border, fill, stroke, outline or shadow.
      const walk = function* (n) {
        if (ts.isPropertyAssignment(n) && /color|background|border|fill|stroke|outline|shadow/i.test(n.name.getText(sf)) && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)) && n.initializer.text.toLowerCase().split(/[\s,()]+/).some((w) => NAMED_COLOURS.has(w))) yield { line: lineOf(sf, n), message: `${n.name.getText(sf)} is set to a colour name: ${n.initializer.text.slice(0, 40)}` };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "colour-built-at-runtime",
    law: "a colour is never assembled at run time from parts (`#${...}`): the kit takes it from a token",
    scope: (f) => isTs(f) && inUi(f),
    *check({ sf }) {
      const walk = function* (n) {
        if (ts.isTemplateExpression(n) && /#$/.test(n.head.text) && n.templateSpans.some((s) => /hex|toString\(16\)|padStart\(2/i.test(s.expression.getText(sf)))) yield { line: lineOf(sf, n), message: "a colour assembled in a template literal" };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "style-colour",
    law: "an inline style takes a colour from a token: no colour function, hex or colour name in `style`",
    scope: kitOrFeature,
    *check({ sf }) {
      for (const { name, value, node } of styleEntries(sf)) {
        const t = textOfValue(value);
        if (t === null) continue;
        const words = t.toLowerCase().split(/[\s,()]+/);
        if (HEX.test(t) || COLOUR_FUNCTION.test(t) || (/color|background|border|fill|stroke|outline|shadow/i.test(name) && words.some((w) => NAMED_COLOURS.has(w)))) yield { line: lineOf(sf, node), message: `style.${name} holds a colour literal: ${t.slice(0, 60)}` };
      }
    },
  },
  {
    id: "style-px",
    law: "an inline style takes sizes from the scale (var(--sp-*), var(--target)): no literal pixel size in `style`",
    scope: kitOrFeature,
    *check({ sf }) {
      for (const { name, value, node } of styleEntries(sf)) {
        if (UNITLESS.has(name)) continue;
        if (ts.isNumericLiteral(value) && Number(value.text) !== 0) yield { line: lineOf(sf, node), message: `style.${name} is the bare number ${value.text} (pixels)` };
        else {
          const t = textOfValue(value);
          const px = t === null ? null : [...t.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n > 1);
          if (px?.length) yield { line: lineOf(sf, node), message: `style.${name} holds a literal pixel size: ${t.slice(0, 60)}` };
        }
      }
    },
  },
  {
    id: "target-height",
    law: "law 2: an interactive element is never given a height under 44 px",
    scope: kitOrFeature,
    *check({ sf }) {
      for (const { element, name, value, node } of styleEntries(sf)) {
        if (!/^(height|minHeight)$/.test(name) || !isInteractive(element)) continue;
        const px = pxOf(value);
        if (px !== null && px < 44) yield { line: lineOf(sf, node), message: `<${tagName(element)}> is given ${name} ${px} px (the floor is 44)` };
      }
    },
  },
  {
    id: "data-layer-import",
    law: "the kit never reaches the data layer",
    scope: (f) => isTs(f) && inUi(f),
    *check({ sf }) {
      const walk = function* (n) {
        const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier ? n.moduleSpecifier.text : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : null;
        if (spec !== null && DATA_LAYER.some((re) => re.test(spec))) yield { line: lineOf(sf, n), message: `imports the data layer: ${spec}` };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "media-outside-base",
    law: "breakpoints live in base.css only",
    scope: (f) => f.startsWith("src/ui/") && f !== "src/ui/base.css" && (isTs(f) || isCss(f)),
    *check({ sf, text, file }) {
      if (isCss(file)) {
        if (/@media|@container/.test(stripComments(text))) yield { line: 1, message: "@media or @container outside base.css" };
        return;
      }
      for (const lit of literals(sf)) if (/@media|@container/.test(lit.text)) yield { line: lineOf(sf, lit.node), message: "@media or @container in a string outside base.css" };
    },
  },
  {
    id: "var-unresolved",
    law: "every var(--name) in the kit resolves to a token or a property the code sets",
    scope: (f) => inUi(f) && (isTs(f) || isCss(f)),
    *check({ sf, text, file, defined }) {
      const found = isCss(file) ? [...stripComments(text).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => ({ name: m[1], line: stripComments(text).slice(0, m.index).split("\n").length })) : [...literals(sf)].flatMap((l) => [...l.text.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => ({ name: m[1], line: lineOf(sf, l.node) })));
      for (const f of found) if (!defined.has(f.name)) yield { line: f.line, message: `var(${f.name}) resolves to nothing` };
    },
  },
  {
    id: "class-undefined",
    law: "every cl- class a part names is defined in base.css; a class assembled from a template must match at least one defined class",
    scope: (f) => isTsx(f) && f.startsWith("src/"),
    *check({ sf, defClasses }) {
      for (const lit of literals(sf)) {
        for (const m of lit.text.matchAll(/(?<![\w-])cl-[a-z0-9]+(?:-[a-z0-9]+)*/g)) {
          const end = m.index + m[0].length;
          const next = lit.text[end];
          const continues = (ts.isTemplateHead(lit.node) || ts.isTemplateMiddle(lit.node)) && (end === lit.text.length || (next === "-" && end + 1 === lit.text.length));
          if (continues) {
            // `cl-chip-${x}`: the class goes on with an expression; some defined class must start with this stem.
            const stem = next === "-" ? `${m[0]}-` : m[0];
            if (![...defClasses].some((c) => c.startsWith(stem))) yield { line: lineOf(sf, lit.node), message: `a class assembled from ${stem}\${...} matches no class defined in base.css` };
          } else if (next === "-") continue;
          else if (!defClasses.has(m[0])) yield { line: lineOf(sf, lit.node), message: `class ${m[0]} is not defined in base.css` };
        }
      }
    },
  },
  {
    id: "cl-btn-outside-button",
    law: "a button is the Button part: the cl-btn classes are written in Button.tsx only",
    scope: (f) => isTsx(f) && f.startsWith("src/") && f !== "src/ui/Button.tsx",
    *check({ sf }) {
      for (const lit of literals(sf)) if (/(?<![\w-])cl-btn(?![\w])/.test(lit.text)) yield { line: lineOf(sf, lit.node), message: "the cl-btn class written outside Button.tsx" };
    },
  },
  {
    id: "raw-form-control",
    law: "every form field is FormField's: no raw <input>, <select> or <textarea> outside FormField.tsx",
    scope: (f) => isTsx(f) && f.startsWith("src/") && f !== "src/ui/FormField.tsx" && notFixture(f),
    *check({ sf }) {
      const walk = function* (n) {
        if (isJsxElement(n) && ["input", "select", "textarea"].includes(tagName(n))) yield { line: lineOf(sf, n), message: `a raw <${tagName(n)}>` };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "details-open",
    law: "a disclosure is closed by default: no <details open>",
    scope: (f) => isTsx(f) && f.startsWith("src/"),
    *check({ sf }) {
      const walk = function* (n) {
        if (isJsxElement(n) && tagName(n) === "details" && attrOf(n, "open")) yield { line: lineOf(sf, n), message: "<details open>" };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "wall-clock",
    law: "the wall clock is read through the injected clock only (deps.now), never with Date.now() or new Date()",
    scope: (f) => isTs(f) && f.startsWith("src/"),
    *check({ sf }) {
      const walk = function* (n) {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(sf) === "Date" && n.expression.name.text === "now") yield { line: lineOf(sf, n), message: "Date.now()" };
        if (ts.isNewExpression(n) && n.expression.getText(sf) === "Date" && (n.arguments?.length ?? 0) === 0) yield { line: lineOf(sf, n), message: "new Date()" };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "bare-fetch",
    law: "the kit and the feature screens do not call fetch(): the one request caller is core/http/request-json",
    scope: (f) => isTs(f) && (inUi(f) || /^src\/features\/[^/]+\/ui\//.test(f)),
    *check({ sf }) {
      const walk = function* (n) {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") yield { line: lineOf(sf, n), message: "a bare fetch(" };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "entity-in-string",
    law: "an HTML entity is decoded in JSX text only; in a string it is printed to the reader as its characters",
    scope: (f) => isTs(f) && (f.startsWith("src/features/") || inUi(f)),
    *check({ sf }) {
      for (const lit of literals(sf)) if (!lit.attribute && /&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/i.test(lit.text)) yield { line: lineOf(sf, lit.node), message: `an HTML entity in a string: ${lit.text.slice(0, 60)}` };
    },
  },
  {
    id: "http-error-message",
    law: "a failure sentence for the customer is written for the customer, never the driver's message: no HttpError(status, error.message)",
    scope: (f) => isTs(f) && f.startsWith("src/"),
    *check({ sf }) {
      const walk = function* (n) {
        if (ts.isNewExpression(n) && n.expression.getText(sf) === "HttpError" && n.arguments?.[1]) {
          const a = n.arguments[1];
          if ((ts.isPropertyAccessExpression(a) && a.name.text === "message") || (ts.isTemplateExpression(a) && a.templateSpans.some((s) => /\.message\b/.test(s.expression.getText(sf))))) yield { line: lineOf(sf, n), message: "HttpError carries a .message" };
        }
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "supabase-error-unhandled",
    law: "every database read looks at its `error`: destructured, read, or handed back to a caller that does",
    scope: (f) => isTs(f) && f.startsWith("src/") && !f.startsWith("src/core/db/"),
    *check({ sf }) {
      const walk = function* (n) {
        if (ts.isAwaitExpression(n) && reachesDatabase(n.expression) && !methodsOf(n.expression).some((m) => WRITE_METHODS.has(m)) && !errorHandled(n, sf)) yield { line: lineOf(sf, n), message: "a database read whose error is never looked at" };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "model-id-literal",
    law: "no model identifier is written in the tree (the injected-brief seam replaces every model call)",
    scope: (f) => isTs(f) && f.startsWith("src/"),
    *check({ sf }) {
      for (const lit of literals(sf)) if (/(?<![\w-])(?:claude|gpt|gemini)-(?:\d|opus|sonnet|haiku|turbo|pro|flash)[\w.-]*/i.test(lit.text)) yield { line: lineOf(sf, lit.node), message: `a model identifier: ${lit.text.slice(0, 60)}` };
    },
  },
  {
    id: "cron-literal",
    law: "no schedule is written in the tree (build mode: every runtime is dispatched)",
    scope: (f) => isTs(f) && f.startsWith("src/"),
    *check({ sf }) {
      for (const lit of literals(sf)) if (/^\s*[\d*/,-]+(?:\s+[\d*/,\-A-Za-z?#]+){4}\s*$/.test(lit.text) && /[*/]/.test(lit.text)) yield { line: lineOf(sf, lit.node), message: `a cron expression: ${lit.text.trim()}` };
    },
  },
  {
    id: "button-rest-style",
    law: "the Button part cannot be given a style: its 44 px floor cannot be overridden through ...rest",
    scope: (f) => f === "src/ui/Button.tsx",
    *check({ sf }) {
      const props = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === "ButtonProps");
      const omits = props?.heritageClauses?.some((h) => h.types.some((t) => t.expression.getText(sf) === "Omit" && /["']style["']/.test(t.typeArguments?.[1]?.getText(sf) ?? "")));
      if (!omits) yield { line: props ? lineOf(sf, props) : 1, message: 'ButtonProps must extend Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style">' };
    },
  },
  {
    id: "style-on-kit-part",
    law: "a feature does not restyle a kit part: no `style` on Button, Input, Select, Textarea, SectionCard or RailCard outside the kit",
    scope: (f) => isTsx(f) && f.startsWith("src/") && !inUi(f) && notFixture(f),
    *check({ sf }) {
      const walk = function* (n) {
        if (isJsxElement(n) && KIT_PARTS.has(tagName(n)) && attrOf(n, "style")) yield { line: lineOf(sf, n), message: `<${tagName(n)}> is given a style` };
        for (const c of n.getChildren(sf)) yield* walk(c);
      };
      yield* walk(sf);
    },
  },
  {
    id: "css-px-scale",
    law: "spacing and type sizes come from the scale (var(--sp-*), var(--fs-*)): no literal pixel size in padding, margin, gap or font-size outside theme.css",
    scope: (f) => isCss(f) && f.startsWith("src/") && f !== "src/ui/theme.css",
    *check({ text }) {
      const code = stripComments(text);
      for (const m of code.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
        if (SPACING_PROPERTY.test(m[1]) && /(?<![\w.-])(?:[2-9]|\d{2,})(?:\.\d+)?px/.test(m[2])) yield { line: code.slice(0, m.index).split("\n").length, message: `${m[1]}: ${m[2].trim().slice(0, 40)}` };
      }
    },
  },
];
