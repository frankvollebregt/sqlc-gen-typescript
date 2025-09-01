import {
  ClassDeclaration,
  ConstructorDeclaration,
  factory,
  GetAccessorDeclaration,
  ImportDeclaration,
  PropertyAssignment,
  SyntaxKind,
} from "typescript";

export const snakeToCamel = (str: string) =>
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
    name,
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

/**
 * Generates a Nest.js @Module decorated class.
 *
 * @param moduleName The name of the module class (e.g., "GeneratedModule").
 * @param providers An array of identifiers for the providers to include (e.g., ["MyService"]).
 * @param controllers An array of identifiers for the controllers.
 * @param imports An array of identifiers for imported modules.
 * @param exports An array of identifiers for exported providers/modules.
 * @returns A ts.ClassDeclaration representing the decorated module.
 */
export function generateNestModule(
  moduleName: string,
  providers: string[] = [],
  controllers: string[] = [],
  imports: string[] = [],
  exports: string[] = []
): ClassDeclaration {
  const moduleProperties: PropertyAssignment[] = [];

  if (providers.length > 0) {
    moduleProperties.push(
      factory.createPropertyAssignment(
        factory.createIdentifier("providers"),
        factory.createArrayLiteralExpression(
          providers.map((p) => factory.createIdentifier(p)),
          false
        )
      )
    );
  }

  if (controllers.length > 0) {
    moduleProperties.push(
      factory.createPropertyAssignment(
        factory.createIdentifier("controllers"),
        factory.createArrayLiteralExpression(
          controllers.map((c) => factory.createIdentifier(c)),
          false
        )
      )
    );
  }

  if (imports.length > 0) {
    moduleProperties.push(
      factory.createPropertyAssignment(
        factory.createIdentifier("imports"),
        factory.createArrayLiteralExpression(
          imports.map((i) => factory.createIdentifier(i)),
          false
        )
      )
    );
  }

  if (exports.length > 0) {
    moduleProperties.push(
      factory.createPropertyAssignment(
        factory.createIdentifier("exports"),
        factory.createArrayLiteralExpression(
          exports.map((e) => factory.createIdentifier(e)),
          false
        )
      )
    );
  }

  const decoratorArgument = factory.createObjectLiteralExpression(
    moduleProperties,
    true
  );

  const moduleCallExpression = factory.createCallExpression(
    factory.createIdentifier("Module"),
    undefined,
    [decoratorArgument]
  );

  const moduleDecorator = factory.createDecorator(moduleCallExpression);
  const moduleClass = factory.createClassDeclaration(
    [
      factory.createDecorator(
        factory.createCallExpression(
          factory.createIdentifier("Global"),
          undefined,
          []
        )
      ),
      moduleDecorator,
      factory.createToken(SyntaxKind.ExportKeyword),
    ],
    factory.createIdentifier(moduleName),
    undefined,
    [],
    []
  );

  return moduleClass;
}
