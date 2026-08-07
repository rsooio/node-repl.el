import { BlockStatement, parse } from "acorn";
import { RecursiveVisitors } from "acorn-walk";
import * as walk from "acorn-walk";

function isTopLevelDeclaration(state: any) {
  return state.ancestors[state.ancestors.length - 2] === state.body;
}

const noop = () => {};

const visitorsWithoutAncestors: RecursiveVisitors<any> = {
  ClassDeclaration(node, state, c) {
    if (isTopLevelDeclaration(state)) {
      state.prepend(node, `${node.id!.name}=`);
      state.hoistedDeclarationStatements.push(`var ${node.id!.name}; `);
      // 改写为表达式赋值后补分号：转换器（如 sucrase）可能在同一行拼接后续
      // 语句，无分号时 ASI 不生效（offending token 与前一 token 间需有换行），
      // 导致 Unexpected identifier 类语法错误
      state.append(node, ';');
    }
    walk.base.ClassDeclaration!(node, state, c);
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
      function registerVariableDeclarationIdentifiers(node) {
        switch (node.type) {
          case 'Identifier':
            variableIdentifiersToHoist.push(node.name);
            break;
          case 'ObjectPattern':
            node.properties
              .map((property) => property.value || property.argument)
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

const vistors = {};
for (const nodeType of Object.keys(walk.base)) {
  vistors[nodeType] = (node, state, c) => {
    const isNew = node !== state.ancestors[state.ancestors.length - 1];
    if (isNew) state.ancestors.push(node);
    (visitorsWithoutAncestors[nodeType] || walk.base[nodeType])(node, state, c);
    if (isNew) state.ancestors.pop();
  }
}

export function processCode(code: string) {
  const wrapped = `(async () => { ${code} })()`;
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
    replace(from, to, str) {
      for (let i = from; i < to; i++) {
        wrappedArray[i] = '';
      }
      if (from === to) str += wrappedArray[from];
      wrappedArray[from] = str;
    },
    prepend(node, str) {
      wrappedArray[node.start] = str + wrappedArray[node.start];
    },
    append(node, str) {
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
