import { parse } from "acorn";
import type { BlockStatement } from "acorn";
import * as walk from "acorn-walk";
import type { RecursiveVisitors } from "acorn-walk";

function isTopLevelDeclaration(state: any) {
  return state.ancestors[state.ancestors.length - 2] === state.body;
}

/** Whether the subtree (any depth) contains constructs incompatible with
 *  extraction: return (may change the construction result by returning an
 *  object) or MetaProperty (new.target/import.meta, a syntax error inside a
 *  method). */
function containsUnsafeNode(node: any): boolean {
  if (node.type === "ReturnStatement" || node.type === "MetaProperty") return true;
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const el of v) {
        if (el && typeof el.type === "string" && containsUnsafeNode(el)) return true;
      }
    } else if (v && typeof v.type === "string" && containsUnsafeNode(v)) {
      return true;
    }
  }
  return false;
}

/** The first super() call in the subtree (super property access doesn't match). */
function findSuperCall(node: any): any | null {
  if (node.type === "CallExpression" && node.callee.type === "Super") return node;
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const el of v) {
        if (el && typeof el.type === "string") {
          const r = findSuperCall(el);
          if (r) return r;
        }
      }
    } else if (v && typeof v.type === "string") {
      const r = findSuperCall(v);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Extract top-level class constructor logic (runs on sucrase output, no TS
 * syntax): the constructor body and instance field initializers are merged
 * into a prototype method __replInit, the constructor only keeps parameter
 * forwarding (derived classes keep their super() call).
 * On class redefinition __replInit hot-updates with the prototype (see
 * patchClass in repl.ts), so constructor changes need no REPL restart: new
 * instances dispatch to the newest __replInit through the prototype chain,
 * old instances can re-run initialization via f.__replInit(...).
 *
 * Degraded (no extraction, kept as-is): the class body already has a method
 * named __replInit (internal name taken), or the constructor body contains
 * return/MetaProperty.
 */
function extractConstructor(state: any, classNode: any): void {
  const elements = classNode.body.body as any[];
  let ctor: any = null;
  let userReplInit = false;
  const fields: any[] = [];
  for (const el of elements) {
    if (el.type === "MethodDefinition") {
      if (el.kind === "constructor" && !el.static) ctor = el;
      if (el.key.type === "Identifier" && el.key.name === "__replInit") {
        userReplInit = true;
      }
    } else if (
      el.type === "PropertyDefinition" && !el.static && !el.computed &&
      el.key.type === "Identifier"
    ) {
      fields.push(el);
    }
  }
  if (userReplInit) return;

  let ctorBody: any = null;
  let params: any[] = [];
  if (ctor) {
    const fn = ctor.value;
    if (fn.type !== "FunctionExpression" || containsUnsafeNode(fn.body)) return;
    ctorBody = fn.body;
    params = fn.params;
  }

  // Read all text first (subsequent replaces clear the corresponding regions)
  const bodyText = ctorBody ? state.slice(ctorBody.start, ctorBody.end) : "";
  // Forward only the argument values, not the default initializers: copied
  // into the call expression, "loc = \"\"" would be an assignment
  // re-evaluated on every call, forcibly resetting the argument to its
  // default and losing the passed value (defaults stay on the __replInit
  // signature where they keep their meaning)
  const callParams = params
    .map((p) =>
      p.type === "AssignmentPattern"
        ? state.slice(p.left.start, p.left.end)
        : state.slice(p.start, p.end),
    )
    .join(", ");
  const paramsText = params.length
    ? state.slice(params[0].start, params[params.length - 1].end)
    : "";
  const superCall = ctorBody ? findSuperCall(ctorBody) : null;
  const superText = superCall ? state.slice(superCall.start, superCall.end) : "";
  const fieldTexts = fields.map((f) => {
    const init = f.value ? state.slice(f.value.start, f.value.end) : "undefined";
    return `this.${f.key.name} = ${init}; `;
  });

  const ctorArgs = paramsText || "...__replArgs";
  if (ctorBody) {
    // Original body minus the super() call becomes the __replInit body (the
    // super call stays in the delegating constructor)
    const initBody = superCall
      ? bodyText.slice(0, superCall.start - ctorBody.start) +
        bodyText.slice(superCall.end - ctorBody.start)
      : bodyText;
    // The delegation references this class's prototype explicitly:
    // this.__replInit would be shadowed on subclass instances by their own
    // method (parent initialization lost in the super() case); the class
    // expression's internal name binds the new class itself, while the old
    // class's delegation always references the patched old prototype
    state.replace(
      ctorBody.start, ctorBody.end,
      `{ ${superText ? `${superText}; ` : ""}${classNode.id.name}.prototype.__replInit.call(this${callParams ? ", " + callParams : ""}) }`,
    );
    // replace(from===to) inserts before the target char: body.end-1 is the
    // class body `}`, inserting before it lands at the end of the body
    state.replace(
      classNode.body.end - 1, classNode.body.end - 1,
      ` __replInit(${ctorArgs}) { ${fieldTexts.join("")}${initBody.slice(1, -1)} }`,
    );
  } else {
    const superForward = classNode.superClass ? "super(...__replArgs); " : "";
    // body.start+1 is the char right after `{`: inserting before it lands at
    // the start of the body
    state.replace(
      classNode.body.start + 1, classNode.body.start + 1,
      `constructor(...__replArgs) { ${superForward}${classNode.id.name}.prototype.__replInit.call(this, ...__replArgs) } `,
    );
    state.replace(
      classNode.body.end - 1, classNode.body.end - 1,
      ` __replInit(...__replArgs) { ${fieldTexts.join("")} }`,
    );
  }
  for (const f of fields) {
    state.replace(f.start, f.end, "");
  }
}

const noop = () => {};

const visitorsWithoutAncestors: RecursiveVisitors<any> = {
  ClassDeclaration(node, state, c) {
    if (isTopLevelDeclaration(state)) {
      // Extract constructor logic first, then rewrite to a
      // __replPatchClass call: the outer assignment receives the patch
      // result (the old class), arg 1 is the old binding, arg 2 is the new
      // class (assigned to the binding first; side effects acceptable).
      // Redefining a class with the same name hot-updates the old class's
      // prototype (full sync of methods/static members, __replInit
      // included), keeping the binding unchanged: old instances take effect
      // immediately and instanceof stays intact; on first definition the old
      // binding is undefined and patch returns the new class.
      extractConstructor(state, node);
      state.prepend(
        node,
        `${node.id!.name}=__replPatchClass(${node.id!.name}, ${node.id!.name}=`,
      );
      state.hoistedDeclarationStatements.push(`var ${node.id!.name}; `);
      // After rewriting to an expression assignment, append a semicolon:
      // converters (like sucrase) may join the following statement on the
      // same line, where ASI does not apply (the offending token needs a
      // newline before the previous token), causing Unexpected identifier
      // style syntax errors
      state.append(node, ');');
      // Don't descend into children: extraction moved the constructor body
      // text into __replInit, so further traversal would rewrite the moved
      // nodes a second time (text corruption). It also avoids method-body
      // var statements being rewritten by VariableDeclaration (which would
      // break var hoisting semantics)
    } else {
      walk.base.ClassDeclaration!(node, state, c);
    }
  },
  FunctionDeclaration(node, state, c) {
    state.prepend(node, `this.${node.id!.name} = ${node.id!.name}; `);
    state.hoistedDeclarationStatements.push(`var ${node.id!.name}; `);
  },
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop,
  VariableDeclaration(node, state, c) {
    const variableKind = node.kind;
    const isIterableForDeclaration = ['ForOfStatement', 'ForInStatement']
      .includes(state.ancestors[state.ancestors.length - 2].type);

    if (variableKind === 'var' || isTopLevelDeclaration(state)) {
      state.replace(
        node.start,
        node.start + variableKind.length + (isIterableForDeclaration ? 1 : 0),
        variableKind === 'var' && isIterableForDeclaration ?
          '' :
          'void' + (node.declarations.length === 1 ? '' : ' ('),
      );

      if (!isIterableForDeclaration) {
        node.declarations.forEach((decl) => {
          state.prepend(decl, '(');
          state.append(decl, decl.init ? ')' : '=undefined)');
        });

        if (node.declarations.length !== 1) {
          state.append(node.declarations[node.declarations.length - 1], ')');
        }
      }

      const variableIdentifiersToHoist: string[] = [];
      function registerVariableDeclarationIdentifiers(node: any) {
        switch (node.type) {
          case 'Identifier':
            variableIdentifiersToHoist.push(node.name);
            break;
          case 'ObjectPattern':
            node.properties
              .map((property: any) => property.value || property.argument)
              .forEach(registerVariableDeclarationIdentifiers);
            break;
          case 'ArrayPattern':
            node.elements.forEach(registerVariableDeclarationIdentifiers);
            break;
        }
      }

      node.declarations.forEach((decl) => {
        registerVariableDeclarationIdentifiers(decl.id);
      });

      if (variableIdentifiersToHoist.length > 0) {
        state.hoistedDeclarationStatements.push(
          `var ${variableIdentifiersToHoist.join(', ')}; `,
        );
      }
    }

    walk.base.VariableDeclaration!(node, state, c);
  },
};

type Walker = (node: any, state: any, c: (node: any, state: any, c: any) => void) => void;

const vistors: Record<string, Walker> = {};
for (const nodeType of Object.keys(walk.base)) {
  vistors[nodeType] = (node, state, c) => {
    const isNew = node !== state.ancestors[state.ancestors.length - 1];
    if (isNew) state.ancestors.push(node);
    ((visitorsWithoutAncestors as Record<string, Walker>)[nodeType] ||
      (walk.base as Record<string, Walker>)[nodeType])(node, state, c);
    if (isNew) state.ancestors.pop();
  }
}

export function processCode(code: string) {
  // Leading/trailing newlines: with a trailing line comment (e.g.
  // "// a = 1"), `//` would comment out the rest of the line and swallow the
  // wrapping `})()`, and without a newline parsing fails with
  // Unexpected token
  const wrapped = `(async () => {\n${code}\n})()`;
  const root = parse(wrapped, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowImportExportEverywhere: true,
  });
  // @ts-ignore body is a BlockStatement because we wrapped the code
  const body: BlockStatement = root.body[0].expression.callee.body;

  const wrappedArray = wrapped.split('');
  const state = {
    body,
    ancestors: [],
    hoistedDeclarationStatements: [],
    slice(from: number, to: number) {
      return wrappedArray.slice(from, to).join('');
    },
    replace(from: number, to: number, str: string) {
      for (let i = from; i < to; i++) {
        wrappedArray[i] = '';
      }
      if (from === to) str += wrappedArray[from];
      wrappedArray[from] = str;
    },
    prepend(node: any, str: string) {
      wrappedArray[node.start] = str + wrappedArray[node.start];
    },
    append(node: any, str: string) {
      wrappedArray[node.end - 1] += str;
    },
  };

  walk.recursive(body, state, vistors);

  for (let i = body.body.length - 1; i >= 0; i--) {
    const node = body.body[i];
    if (node.type === 'EmptyStatement') continue;
    if (node.type === 'ExpressionStatement') {
      state.prepend(node.expression, '{ value: (');
      // Leading newline: when the rewritten previous statement (e.g.
      // class/var rewrites) shares a line with this return, ASI does not
      // apply (the offending token needs a newline before the previous
      // token), causing a syntax error
      state.prepend(node, '\nreturn ');
      state.append(node.expression, ') }');
    }
    break;
  }

  return state.hoistedDeclarationStatements.join('') + wrappedArray.join('');
}
