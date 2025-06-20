import { ClassDeclaration, factory, SyntaxKind } from "typescript";

/// Utility functions for generating NestJS classes and components
export function nestServiceDecl(name: string): ClassDeclaration {
  const injectableDecorator = factory.createDecorator(
    factory.createCallExpression(
      factory.createIdentifier("Injectable"),
      undefined,
      [],
    )
  );

  return factory.createClassDeclaration(
    [factory.createModifier(SyntaxKind.ExportKeyword), injectableDecorator],
    name,
    undefined,
    [],
    [],
  );
}
