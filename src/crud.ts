import ts, { Expression, factory, Node, SyntaxKind } from "typescript";
import { Driver } from "./app";
import { Column, Table } from "./gen/plugin/codegen_pb";
import {
  createNamedImportDeclaration,
  nestServiceDecl,
  snakeToCamel,
  snakeToPascal,
} from "./nest";
import { colName } from "./drivers/utlis";

/** Output the table models and simple CRUD functions for them */
export function crudDecl(driver: Driver, tables: Table[]): Node[] {
  // Output the model (table classes)
  let nodes: Node[] = [];

  nodes.push(createNamedImportDeclaration(["Injectable"], "@nestjs/common"));
  nodes.push(createNamedImportDeclaration(["PartialType"], "@nestjs/swagger"));

  const imports = new Set<string>(["IsDefined", "IsOptional"]);

  const tableNodes = [];
  for (const table of tables) {
    tableNodes.push(tableDecl(table.rel!.name, driver, table.columns, imports));
    tableNodes.push(companionDecl(table.rel!.name, driver, table.columns));
  }

  nodes.push(createNamedImportDeclaration(["ClsService"], "nestjs-cls"));

  // import { IsDefined, IsOptional, x, y, z } from 'class-validator';
  nodes.push(
    createNamedImportDeclaration(Array.from(imports), "class-validator")
  );

  nodes.push(
    createNamedImportDeclaration(["IsBigInt"], "src/validators/env.validator")
  );

  nodes.push(
    factory.createInterfaceDeclaration(
      undefined,
      factory.createIdentifier("Client"),
      undefined,
      undefined,
      [
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier("query"),
          undefined,
          factory.createFunctionTypeNode(
            undefined,
            [
              factory.createParameterDeclaration(
                undefined,
                undefined,
                factory.createIdentifier("config"),
                undefined,
                factory.createTypeReferenceNode(
                  factory.createIdentifier("QueryArrayConfig"),
                  undefined
                ),
                undefined
              ),
            ],
            factory.createTypeReferenceNode(
              factory.createIdentifier("Promise"),
              [
                factory.createTypeReferenceNode(
                  factory.createIdentifier("QueryArrayResult"),
                  undefined
                ),
              ]
            )
          )
        ),
      ]
    )
  );

  nodes.push(...tableNodes);

  const crudNodes: Node[] = [replacerMethodDecl()];

  for (const table of tables) {
    crudNodes.push(
      factory.createAssignment(
        factory.createIdentifier(snakeToCamel(table.rel!.name)),
        crudTableDecl(table)
      )
    );
  }

  nodes.push(nestServiceDecl("CrudService", crudNodes));

  return nodes;
}

function tableDecl(
  name: string,
  driver: Driver,
  columns: Column[],
  imports: Set<string>
) {
  return factory.createClassDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    factory.createIdentifier(snakeToPascal(name)),
    undefined,
    undefined,
    columns.map((column, i) =>
      factory.createPropertyDeclaration(
        columnDecoratorsDecl(column, imports),
        factory.createIdentifier(colName(i, column)),
        undefined,
        driver.columnType(column),
        undefined
      )
    )
  );
}

function columnDecoratorsDecl(
  column: Column,
  imports: Set<string>
): ts.Decorator[] {
  const decorators = [
    decoratorDecl(column.notNull ? "IsDefined" : "IsOptional"),
  ];

  // Some of the type names have the `pgcatalog.` prefix. Remove this.
  let typeName = column.type?.name;

  if (typeName != null) {
    const pgCatalog = "pg_catalog.";
    if (typeName.startsWith(pgCatalog)) {
      typeName = typeName.slice(pgCatalog.length);
    }

    // For certain types, add additional decorators to validate the actual type
    switch (typeName) {
      case "int8":
        decorators.push(decoratorDecl("IsBigInt"));
        // IsBigInt is always imported, from local/shared package
        break;
      case "bool":
        decorators.push(decoratorDecl("IsBoolean"));
        imports.add("IsBoolean");
        break;
      case "text":
        decorators.push(decoratorDecl("IsString"));
        imports.add("IsString");
        break;
      case "float4":
      case "float8":
        decorators.push(decoratorDecl("IsNumber"));
        imports.add("IsNumber");
        break;
      case "int2":
      case "int4":
        decorators.push(decoratorDecl("IsInt"));
        imports.add("IsInt");
        break;
    }
  }
  return decorators;
}

function decoratorDecl(name: string) {
  return factory.createDecorator(
    factory.createCallExpression(
      factory.createIdentifier(name),
      undefined,
      undefined
    )
  );
}

function companionDecl(tableName: string, driver: Driver, columns: Column[]) {
  const identifier = factory.createIdentifier(snakeToPascal(tableName));
  const companionIdentifier = factory.createIdentifier(
    snakeToPascal(tableName) + "Companion"
  );

  return factory.createClassDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    companionIdentifier,
    undefined,
    [
      factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
          factory.createCallExpression(
            factory.createIdentifier("PartialType"),
            undefined,
            [identifier]
          ),
          undefined
        ),
      ]),
    ],
    columns
      // TODO detect which column is the primary key instead
      .filter((col) => col.name === tableName + "id")
      .map((column, i) =>
        factory.createPropertyDeclaration(
          undefined,
          factory.createIdentifier(colName(i, column)),
          undefined,
          driver.columnType(column),
          undefined
        )
      )
  );
}

function replacerMethodDecl(): ts.MethodDeclaration {
  return factory.createMethodDeclaration(
    [factory.createModifier(ts.SyntaxKind.PrivateKeyword)],
    undefined,
    "replacer",
    undefined,
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        "k",
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
      ),
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        "v",
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
      ),
    ],
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword), // return type
    ts.factory.createBlock(
      [
        // if (typeof this[k] === 'bigint') { return this[k].toString(); }
        ts.factory.createIfStatement(
          ts.factory.createBinaryExpression(
            ts.factory.createTypeOfExpression(
              ts.factory.createElementAccessExpression(
                ts.factory.createThis(),
                ts.factory.createIdentifier("k")
              )
            ),
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.factory.createStringLiteral("bigint")
          ),
          ts.factory.createBlock(
            [
              ts.factory.createReturnStatement(
                ts.factory.createCallExpression(
                  ts.factory.createPropertyAccessExpression(
                    ts.factory.createElementAccessExpression(
                      ts.factory.createThis(),
                      ts.factory.createIdentifier("k")
                    ),
                    "toString"
                  ),
                  undefined,
                  []
                )
              ),
            ],
            true
          )
        ),
        // return v;
        ts.factory.createReturnStatement(ts.factory.createIdentifier("v")),
      ],
      true
    )
  );
}

function crudTableDecl(table: Table): Expression {
  const tableName = table.rel!.name;
  const identifier = factory.createIdentifier(snakeToPascal(tableName));
  const companionIdentifier = factory.createIdentifier(
    snakeToPascal(tableName) + "Companion"
  );
  return factory.createObjectLiteralExpression(
    [
      factory.createPropertyAssignment(
        "update",
        factory.createArrowFunction(
          [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
          undefined,
          [
            factory.createParameterDeclaration(
              undefined,
              undefined,
              "entry",
              undefined,
              factory.createTypeReferenceNode(companionIdentifier)
            ),
          ],
          factory.createTypeReferenceNode("Promise", [
            factory.createKeywordTypeNode(SyntaxKind.VoidKeyword),
          ]),
          factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          ts.factory.createBlock(
            [
              // The query
              ts.factory.createVariableStatement(
                undefined,
                ts.factory.createVariableDeclarationList(
                  [
                    ts.factory.createVariableDeclaration(
                      "query",
                      undefined,
                      undefined,
                      ts.factory.createStringLiteral(getQueryString(table))
                    ),
                  ],
                  ts.NodeFlags.Const
                )
              ),

              // Logging

              // Running the query
              factory.createExpressionStatement(
                factory.createAwaitExpression(
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                      factory.createPropertyAccessExpression(
                        factory.createThis(),
                        factory.createIdentifier("client")
                      ),
                      factory.createIdentifier("query")
                    ),
                    undefined,
                    [
                      factory.createObjectLiteralExpression(
                        [
                          factory.createPropertyAssignment(
                            "text",
                            factory.createIdentifier("query")
                          ),
                          factory.createPropertyAssignment(
                            "values",
                            factory.createArrayLiteralExpression([
                              factory.createCallExpression(
                                factory.createPropertyAccessExpression(
                                  factory.createIdentifier("JSON"),
                                  "stringify"
                                ),
                                undefined,
                                [
                                  factory.createIdentifier("entry"),
                                  factory.createPropertyAccessExpression(
                                    factory.createThis(),
                                    factory.createIdentifier("replacer")
                                  ),
                                ]
                              ),
                            ])
                          ),
                          factory.createPropertyAssignment(
                            "rowMode",
                            factory.createStringLiteral("array")
                          ),
                        ],
                        true
                      ),
                    ]
                  )
                )
              ),
            ],
            true
          )
        )
      ),
    ],
    true
  );
}

function getQueryString(table: Table): string {
  const tableName = table.rel!.name;

  // Create update statements for all columns (except the primary key)
  const updateLines = table.columns
    .filter((col) => col.name !== tableName + "id")
    .map((col) => {
      const name = col.name;
      return `${name} = CASE WHEN data ? '${name}' THEN data->>'${name}' ELSE ${name} END`;
    });

  return `WITH input AS (SELECT $1::jsonb AS data) UPDATE ${tableName} SET ${updateLines.join(
    ", "
  )} FROM input WHERE ${tableName}.${tableName}id = (data->>'${tableName}id')::bigint;`;
}
