import {
  ClassDeclaration,
  ConstructorDeclaration,
  factory,
  GetAccessorDeclaration,
  ImportDeclaration,
  SyntaxKind,
} from "typescript";

const snakeToCamel = (str: string) =>
  str.replace(/([-_]\w)/g, (g) => g[1].toUpperCase());
export const snakeToPascal = (str: string) => {
  let camelCase = snakeToCamel(str);
  let pascalCase = camelCase[0].toUpperCase() + camelCase.substr(1);
  return pascalCase;
};

/// Utility functions for generating NestJS classes and components
export function nestServiceDecl(
  name: string,
  members: any[]
): ClassDeclaration {
  const injectableDecorator = factory.createDecorator(
    factory.createCallExpression(
      factory.createIdentifier("Injectable"),
      undefined,
      []
    )
  );

  return factory.createClassDeclaration(
    [injectableDecorator, factory.createModifier(SyntaxKind.ExportKeyword)],
    snakeToPascal(name) + "QueryService",
    undefined,
    [],
    [createClsServiceConstructor(), createClientGetter(), ...members]
  );
}

/**
 * Generates the 'client' getter for a service.
 * @returns The generated TypeScript AST node for the getter.
 */
function createClientGetter(): GetAccessorDeclaration {
  return factory.createGetAccessorDeclaration(
    [factory.createModifier(SyntaxKind.PrivateKeyword)],
    factory.createIdentifier("client"),
    [],
    factory.createTypeReferenceNode(factory.createIdentifier("Client")),
    factory.createBlock(
      [
        factory.createReturnStatement(
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createThis(),
                factory.createIdentifier("cls")
              ),
              factory.createIdentifier("get")
            ),
            undefined,
            [factory.createStringLiteral("db")]
          )
        ),
      ],
      true
    )
  );
}

/**
 * Generates a constructor with ClsService injected.
 * @returns The generated TypeScript AST node for the constructor.
 */
function createClsServiceConstructor(): ConstructorDeclaration {
  const clsParam = factory.createParameterDeclaration(
    [factory.createModifier(SyntaxKind.PrivateKeyword)],
    undefined,
    factory.createIdentifier("cls"),
    undefined,
    factory.createTypeReferenceNode(factory.createIdentifier("ClsService")),
    undefined
  );

  return factory.createConstructorDeclaration(
    undefined,
    [clsParam],
    factory.createBlock([], true)
  );
}

/**
 * Creates an import declaration for specific named imports from a module.
 * @param names An array of import names (e.g., ['Injectable', 'Module']).
 * @param moduleName The module to import from (e.g., '@nestjs/common').
 * @returns The generated TypeScript AST node for the import declaration.
 */
export function createNamedImportDeclaration(
  names: string[],
  moduleName: string
): ImportDeclaration {
  return factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      false,
      undefined,
      factory.createNamedImports(
        names.map((name) =>
          factory.createImportSpecifier(
            false,
            undefined,
            factory.createIdentifier(name)
          )
        )
      )
    ),
    factory.createStringLiteral(moduleName),
    undefined
  );
}
