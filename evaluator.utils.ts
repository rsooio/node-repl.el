import { parse } from "acorn";
import type { BlockStatement } from "acorn";
import * as walk from "acorn-walk";
import type { RecursiveVisitors } from "acorn-walk";

function isTopLevelDeclaration(state: any) {
  return state.ancestors[state.ancestors.length - 2] === state.body;
}

/** 节点子树（任意深度）是否含不兼容抽取的构造：return（可能返回对象改变构造
 *  结果）或 MetaProperty（new.target/import.meta，在方法内为语法错误）。 */
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

/** 子树内第一个 super() 调用（super 属性访问不匹配）。 */
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
 * 顶层 class 构造逻辑抽取（在 sucrase 输出上运行，无 TS 语法）：
 * constructor 方法体与实例字段初始化合并进原型方法 __replInit，
 * constructor 只保留参数转发（派生类保留 super() 调用）。
 * 重定义 class 时 __replInit 随原型热更新（见 repl.ts patchClass），构造逻辑
 * 变更无需重启 REPL：新实例构造时经原型链动态分派到新版 __replInit，
 * 旧实例可调 f.__replInit(...) 重跑初始化。
 *
 * 降级（不抽取，保持原样）：类体已有同名 __replInit 方法（内部名被占用）、
 * constructor 体含 return/MetaProperty。
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

  // 先读取全部文本（后续 replace 会清空对应区域）
  const bodyText = ctorBody ? state.slice(ctorBody.start, ctorBody.end) : "";
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
    // 原 body 移除 super() 调用后作为 __replInit 体（super 调用留在委托构造）
    const initBody = superCall
      ? bodyText.slice(0, superCall.start - ctorBody.start) +
        bodyText.slice(superCall.end - ctorBody.start)
      : bodyText;
    // 委托显式引用本类 prototype：this.__replInit 会在子类实例上被子类同名
    // 方法遮蔽（super() 场景父类初始化丢失）；类表达式内部名绑定新类自身，
    // 旧类委托则始终引用被 patch 更新的旧原型
    state.replace(
      ctorBody.start, ctorBody.end,
      `{ ${superText ? `${superText}; ` : ""}${classNode.id.name}.prototype.__replInit.call(this${paramsText ? ", " + paramsText : ""}) }`,
    );
    // replace(from===to) 在目标字符前插入：body.end-1 是类体 `}`，
    // 插在其前即类体末尾
    state.replace(
      classNode.body.end - 1, classNode.body.end - 1,
      ` __replInit(${ctorArgs}) { ${fieldTexts.join("")}${initBody.slice(1, -1)} }`,
    );
  } else {
    const superForward = classNode.superClass ? "super(...__replArgs); " : "";
    // body.start+1 是 `{` 后第一个字符：在其前插入即类体开头
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
      // 先抽取构造逻辑，再改写为 __replPatchClass 调用：外层赋值接收 patch
      // 结果（旧类），参数 1 是旧绑定，参数 2 是新类（先临时赋值到绑定，
      // 副作用可接受）。同名 class 重复定义时热更新旧类的原型
      // （方法/静态成员全量同步，含 __replInit），保持绑定不变，旧实例
      // 立即生效且 instanceof 不破坏；首次定义时旧绑定为 undefined，
      // patch 直接返回新类。
      extractConstructor(state, node);
      state.prepend(
        node,
        `${node.id!.name}=__replPatchClass(${node.id!.name}, ${node.id!.name}=`,
      );
      state.hoistedDeclarationStatements.push(`var ${node.id!.name}; `);
      // 改写为表达式赋值后补分号：转换器（如 sucrase）可能在同一行拼接后续
      // 语句，无分号时 ASI 不生效（offending token 与前一 token 间需有换行），
      // 导致 Unexpected identifier 类语法错误
      state.append(node, ');');
      // 不遍历子节点：抽取已把 constructor 体文本移到 __replInit，继续遍历
      // 会对已移动位置的节点二次改写（文本错乱）。顺带避免方法体 var 被
      // VariableDeclaration 改写（改写会破坏 var 提升语义）
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
  // 前后加换行：代码以行注释结尾时（如 "// a = 1"），`//` 会注释到行尾并
  // 吞掉包装的 `})()`，无换行则解析报 Unexpected token
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
      // 前导换行：改写后的前一条语句（如 class/var 改写）与 return 同行时，
      // ASI 不生效（offending token 与前一 token 间需有换行），会导致语法错误
      state.prepend(node, '\nreturn ');
      state.append(node.expression, ') }');
    }
    break;
  }

  return state.hoistedDeclarationStatements.join('') + wrappedArray.join('');
}
