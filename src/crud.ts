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
import { mapReturnColumnsWithBigInt } from "./bigint";

const excludedColumns = [
  "userid",
  "log_actiesid",
  "tijd_vanaf",
  "importid",
  "import_uuid",
  "tenantid",
];

const excludedFilter = (column: Column) =>
  !excludedColumns.includes(column.name);

/** Output the table models and simple CRUD functions for them */
export function crudDecl(driver: Driver, tables: Table[]): Node[] {
  // Output the model (table classes)
  let nodes: Node[] = [];

  nodes.push(createNamedImportDeclaration(["Injectable"], "@nestjs/common"));
  nodes.push(
    createNamedImportDeclaration(["PartialType", "OmitType"], "@nestjs/swagger")
  );

  const imports = new Set<string>([
    "ValidationOptions",
    "IsDefined",
    "IsOptional",
    "IsArray",
  ]);

  const tableNodes = [];
  for (const table of tables) {
    tableNodes.push(tableDecl(table.rel!.name, driver, table.columns, imports));
    tableNodes.push(insertableDecl(table.rel!.name, table.columns));
    tableNodes.push(updateableDecl(table.rel!.name, driver, table.columns));
    tableNodes.push(filterDecl(table.rel!.name, driver, table.columns));
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
    createNamedImportDeclaration(["QueryArrayConfig", "QueryArrayResult"], "pg")
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
    columns
      .filter(excludedFilter)
      .map((column, i) =>
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

function decoratorForTypeName(typeName: string, imports: Set<string>) {
  switch (typeName) {
    case "int8":
      // IsBigInt is always imported, from local/shared package
      return "IsBigInt";
    case "bool":
      imports.add("IsBoolean");
      return "IsBoolean";
    case "text":
      imports.add("IsString");
      return "IsString";
    case "float4":
    case "float8":
      imports.add("IsNumber");
      return "IsNumber";
    case "int2":
    case "int4":
      imports.add("IsInt");
      return "IsInt";
    case "timestamptz":
    case "timestamp":
      imports.add("IsISO8601");
      return "IsISO8601";
    default:
      return null;
  }
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
    const decoratorName = decoratorForTypeName(typeName, imports);
    if (decoratorName != null) {
      decorators.push(decoratorDecl(decoratorName));
    }
  }

  return decorators;
}

function decoratorDecl(name: string, args?: Expression[]) {
  return factory.createDecorator(
    factory.createCallExpression(
      factory.createIdentifier(name),
      undefined,
      args
    )
  );
}

function insertableDecl(tableName: string, columns: Column[]) {
  const identifier = factory.createIdentifier(snakeToPascal(tableName));
  const insertableIdentifier = factory.createIdentifier(
    snakeToPascal(tableName) + "Insertable"
  );

  const hasId = columns.map((col) => col.name).includes(tableName + "id");

  const omits = [];

  if (hasId) {
    omits.push(factory.createStringLiteral(tableName + "id"));
  }

  return factory.createClassDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    insertableIdentifier,
    undefined,
    [
      factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
          factory.createCallExpression(
            factory.createIdentifier("PartialType"),
            undefined,
            omits.length > 0
              ? [
                  factory.createCallExpression(
                    factory.createIdentifier("OmitType"),
                    undefined,
                    [identifier, factory.createArrayLiteralExpression(omits)]
                  ),
                ]
              : [identifier]
          ),
          undefined
        ),
      ]),
    ],
    []
  );
}

function updateableDecl(tableName: string, driver: Driver, columns: Column[]) {
  const updateableIdentifier = factory.createIdentifier(
    snakeToPascal(tableName) + "Updateable"
  );
  const insertableIdentifier = factory.createIdentifier(
    snakeToPascal(tableName) + "Insertable"
  );

  return factory.createClassDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    updateableIdentifier,
    undefined,
    [
      factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
          insertableIdentifier,
          undefined
        ),
      ]),
    ],
    columns
      // TODO detect which column is the primary key instead
      .filter((col) => col.name === tableName + "id")
      .map((column, i) =>
        factory.createPropertyDeclaration(
          columnDecoratorsDecl(column, new Set()),
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
  const updateableIdentifier = factory.createIdentifier(
    snakeToPascal(tableName) + "Updateable"
  );
  const insertableIdentifier = factory.createIdentifier(
    snakeToPascal(tableName) + "Insertable"
  );
  return factory.createObjectLiteralExpression(
    [
      getUpdateMethod(table, updateableIdentifier),
      getSelectMethod(table),
      getDeleteMethod(table),
      getInsertMethod(table, insertableIdentifier),
    ],
    true
  );
}

function getUpdateMethod(table: Table, companionIdentifier: ts.Identifier) {
  return factory.createPropertyAssignment(
    "update",
    factory.createArrowFunction(
      [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
      undefined,
      [
        factory.createParameterDeclaration(
          undefined,
          undefined,
          "entries",
          undefined,
          factory.createUnionTypeNode([
            factory.createTypeReferenceNode(companionIdentifier),
            factory.createArrayTypeNode(
              factory.createTypeReferenceNode(companionIdentifier)
            ),
          ])
        ),
      ],
      factory.createTypeReferenceNode("Promise", [
        factory.createKeywordTypeNode(SyntaxKind.NumberKeyword),
      ]),
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createBlock(
        [
          // Ensure entries is always an array
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "arr",
                  undefined,
                  undefined,
                  ts.factory.createConditionalExpression(
                    ts.factory.createCallExpression(
                      ts.factory.createPropertyAccessExpression(
                        ts.factory.createIdentifier("Array"),
                        ts.factory.createIdentifier("isArray")
                      ),
                      undefined,
                      [ts.factory.createIdentifier("entries")]
                    ),
                    ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                    ts.factory.createIdentifier("entries"),
                    ts.factory.createToken(ts.SyntaxKind.ColonToken),
                    ts.factory.createArrayLiteralExpression(
                      [ts.factory.createIdentifier("entries")],
                      false
                    )
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // The query
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "query",
                  undefined,
                  undefined,
                  ts.factory.createStringLiteral(getUpdateQueryString(table))
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // let rowCount = 0;
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "rowCount",
                  undefined,
                  undefined,
                  ts.factory.createNumericLiteral("0")
                ),
              ],
              ts.NodeFlags.Let
            )
          ),
          // Loop over each entry and update
          ts.factory.createForOfStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  ts.factory.createIdentifier("entry"),
                  undefined,
                  undefined,
                  undefined
                ),
              ],
              ts.NodeFlags.Const
            ),
            ts.factory.createIdentifier("arr"),
            ts.factory.createBlock(
              [
                factory.createVariableStatement(
                  undefined,
                  ts.factory.createVariableDeclarationList([
                    ts.factory.createVariableDeclaration(
                      "result",
                      undefined,
                      undefined,
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
                  ])
                ),
                factory.createExpressionStatement(
                  factory.createBinaryExpression(
                    factory.createIdentifier("rowCount"),
                    ts.SyntaxKind.PlusEqualsToken,
                    // result.rowCount ?? 0
                    factory.createBinaryExpression(
                      factory.createPropertyAccessExpression(
                        factory.createIdentifier("result"),
                        factory.createIdentifier("rowCount")
                      ),
                      ts.SyntaxKind.QuestionQuestionToken,
                      factory.createNumericLiteral("0")
                    )
                  )
                ),
              ],
              true
            )
          ),
          // return rowCount
          factory.createReturnStatement(factory.createIdentifier("rowCount")),
        ],
        true
      )
    )
  );
}

function getUpdateQueryString(table: Table): string {
  const tableName = table.rel!.name;

  // Create update statements for all columns (except the primary key)
  const updateLines = table.columns
    .filter((col) => col.name !== tableName + "id")
    .filter(excludedFilter)
    .map((col) => {
      const name = col.name;
      const type = col.type?.name;
      return `${name} = CASE WHEN data ? '${name}' THEN (data->>'${name}')::${
        type ?? "TEXT"
      } ELSE ${name} END`;
    });

  return `WITH input AS (SELECT $1::jsonb AS data) UPDATE ${tableName} SET ${updateLines.join(
    ", "
  )} FROM input WHERE ${tableName}.${tableName}id = (data->>'${tableName}id')::bigint;`;
}

function getSelectMethod(table: Table) {
  const tableName = table.rel!.name;
  const idName = snakeToCamel(tableName + "id");

  // Only accept included columns
  const columns = table.columns.filter(excludedFilter);

  return factory.createPropertyAssignment(
    "select",
    factory.createArrowFunction(
      [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
      undefined,
      [
        factory.createParameterDeclaration(
          undefined,
          undefined,
          idName,
          undefined,
          factory.createUnionTypeNode([
            factory.createKeywordTypeNode(SyntaxKind.BigIntKeyword),
            factory.createArrayTypeNode(
              factory.createKeywordTypeNode(SyntaxKind.BigIntKeyword)
            ),
          ])
        ),
      ],
      factory.createTypeReferenceNode("Promise", [
        factory.createArrayTypeNode(
          factory.createTypeReferenceNode(snakeToPascal(tableName))
        ),
      ]),
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createBlock(
        [
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  ts.factory.createIdentifier("arr"),
                  undefined,
                  undefined,
                  ts.factory.createConditionalExpression(
                    ts.factory.createCallExpression(
                      ts.factory.createPropertyAccessExpression(
                        ts.factory.createIdentifier("Array"),
                        ts.factory.createIdentifier("isArray")
                      ),
                      undefined,
                      [ts.factory.createIdentifier(idName)]
                    ),
                    ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                    ts.factory.createIdentifier(idName),
                    ts.factory.createToken(ts.SyntaxKind.ColonToken),
                    ts.factory.createArrayLiteralExpression(
                      [ts.factory.createIdentifier(idName)],
                      false
                    )
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // The query
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "query",
                  undefined,
                  undefined,
                  ts.factory.createStringLiteral(
                    getSelectQueryString(table, columns)
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),

          // Running the query
          factory.createVariableStatement(undefined, [
            factory.createVariableDeclaration(
              "result",
              undefined,
              undefined,
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
                            factory.createIdentifier("arr"),
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
          ]),
          factory.createReturnStatement(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier("result"),
                  factory.createIdentifier("rows")
                ),
                factory.createIdentifier("map")
              ),
              undefined,
              [
                factory.createArrowFunction(
                  undefined,
                  undefined,
                  [
                    factory.createParameterDeclaration(
                      undefined,
                      undefined,
                      factory.createIdentifier("row"),
                      undefined,
                      undefined,
                      undefined
                    ),
                  ],
                  undefined,
                  factory.createToken(SyntaxKind.EqualsGreaterThanToken),
                  factory.createBlock(
                    [
                      factory.createReturnStatement(
                        factory.createObjectLiteralExpression(
                          columns.map(mapReturnColumnsWithBigInt),
                          true
                        )
                      ),
                    ],
                    true
                  )
                ),
              ]
            )
          ),
        ],
        true
      )
    )
  );
}

function getSelectQueryString(table: Table, columns: Column[]): string {
  const tableName = table.rel!.name;
  return `SELECT ${columns
    .map((col) => col.name)
    .join(", ")} FROM ${tableName} WHERE ${tableName}id = ANY($1)`;
}

function getDeleteMethod(table: Table) {
  const tableName = table.rel!.name;
  const idName = snakeToCamel(tableName + "id");
  return factory.createPropertyAssignment(
    "delete",
    factory.createArrowFunction(
      [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
      undefined,
      [
        factory.createParameterDeclaration(
          undefined,
          undefined,
          idName,
          undefined,
          factory.createUnionTypeNode([
            factory.createKeywordTypeNode(SyntaxKind.BigIntKeyword),
            factory.createArrayTypeNode(
              factory.createKeywordTypeNode(SyntaxKind.BigIntKeyword)
            ),
          ])
        ),
      ],
      factory.createTypeReferenceNode("Promise", [
        factory.createKeywordTypeNode(SyntaxKind.NumberKeyword),
      ]),
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createBlock(
        [
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  ts.factory.createIdentifier("arr"),
                  undefined,
                  undefined,
                  ts.factory.createConditionalExpression(
                    ts.factory.createCallExpression(
                      ts.factory.createPropertyAccessExpression(
                        ts.factory.createIdentifier("Array"),
                        ts.factory.createIdentifier("isArray")
                      ),
                      undefined,
                      [ts.factory.createIdentifier(idName)]
                    ),
                    ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                    ts.factory.createIdentifier(idName),
                    ts.factory.createToken(ts.SyntaxKind.ColonToken),
                    ts.factory.createArrayLiteralExpression(
                      [ts.factory.createIdentifier(idName)],
                      false
                    )
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // The query
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "query",
                  undefined,
                  undefined,
                  ts.factory.createStringLiteral(
                    `DELETE FROM ${tableName} WHERE ${tableName}id = ANY($1);`
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),

          // Running the query
          factory.createVariableStatement(undefined, [
            factory.createVariableDeclaration(
              "result",
              undefined,
              undefined,
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
                            factory.createIdentifier("arr"),
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
          ]),
          // return result.rowCount ?? 0
          factory.createReturnStatement(
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier("result"),
                factory.createIdentifier("rowCount")
              ),
              ts.SyntaxKind.QuestionQuestionToken,
              factory.createNumericLiteral("0")
            )
          ),
        ],
        true
      )
    )
  );
}

function getInsertMethod(table: Table, insertableIdentifier: ts.Identifier) {
  const tableName = table.rel!.name;

  const columnTypes = new Map<string, string>(
    table.columns
      .filter((col) => col.name !== tableName + "id")
      .filter(excludedFilter)
      .map((col) => {
        const name = col.name;
        const type = col.type?.name;
        return [name, type ?? "TEXT"];
      })
  );

  // The insert method takes in a PartialType of the table class, omitting the primary key
  // It passes this as a JSONB object to the query
  return factory.createPropertyAssignment(
    "insert",
    factory.createArrowFunction(
      [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
      undefined,
      [
        factory.createParameterDeclaration(
          undefined,
          undefined,
          "entry",
          undefined,
          factory.createTypeReferenceNode(insertableIdentifier)
        ),
      ],
      factory.createTypeReferenceNode("Promise", [
        factory.createArrayTypeNode(
          factory.createKeywordTypeNode(SyntaxKind.BigIntKeyword)
        ),
      ]),
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createBlock(
        [
          // Define the columnTypes map
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "columnTypes",
                  undefined,
                  undefined,
                  ts.factory.createNewExpression(
                    ts.factory.createIdentifier("Map"),
                    undefined,
                    [
                      ts.factory.createArrayLiteralExpression(
                        Array.from(columnTypes).map(([name, type]) =>
                          ts.factory.createArrayLiteralExpression([
                            ts.factory.createStringLiteral(name),
                            ts.factory.createStringLiteral(type),
                          ])
                        ),
                        true
                      ),
                    ]
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // The columnTypes map, filtered on names that are actually present
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "filteredColumnTypes",
                  undefined,
                  undefined,
                  ts.factory.createNewExpression(
                    ts.factory.createIdentifier("Map"),
                    undefined,
                    [
                      ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(
                          ts.factory.createCallExpression(
                            ts.factory.createPropertyAccessExpression(
                              ts.factory.createIdentifier("Object"),
                              "getOwnPropertyNames"
                            ),
                            undefined,
                            [ts.factory.createIdentifier("entry")]
                          ),
                          "map"
                        ),
                        undefined,
                        [
                          ts.factory.createArrowFunction(
                            undefined,
                            undefined,
                            [
                              ts.factory.createParameterDeclaration(
                                undefined,
                                undefined,
                                "name"
                              ),
                            ],
                            undefined,
                            ts.factory.createToken(
                              ts.SyntaxKind.EqualsGreaterThanToken
                            ),
                            ts.factory.createArrayLiteralExpression([
                              ts.factory.createIdentifier("name"),
                              ts.factory.createCallExpression(
                                ts.factory.createPropertyAccessExpression(
                                  ts.factory.createIdentifier("columnTypes"),
                                  "get"
                                ),
                                undefined,
                                [ts.factory.createIdentifier("name")]
                              ),
                            ])
                          ),
                        ]
                      ),
                    ]
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // Create the query
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "query",
                  undefined,
                  undefined,
                  factory.createTemplateExpression(
                    factory.createTemplateHead(
                      `WITH input AS (SELECT $1::jsonb AS data) INSERT INTO ${tableName} (`
                    ),
                    [
                      factory.createTemplateSpan(
                        factory.createCallExpression(
                          factory.createPropertyAccessExpression(
                            factory.createCallExpression(
                              factory.createPropertyAccessExpression(
                                factory.createIdentifier("Array"),
                                "from"
                              ),
                              undefined,
                              [
                                factory.createCallExpression(
                                  factory.createPropertyAccessExpression(
                                    factory.createIdentifier(
                                      "filteredColumnTypes"
                                    ),
                                    "keys"
                                  ),
                                  undefined,
                                  undefined
                                ),
                              ]
                            ),
                            "join"
                          ),
                          undefined,
                          [factory.createStringLiteral(", ")]
                        ),
                        factory.createTemplateMiddle(") SELECT ")
                      ),
                      factory.createTemplateSpan(
                        ts.factory.createCallExpression(
                          ts.factory.createPropertyAccessExpression(
                            factory.createCallExpression(
                              factory.createPropertyAccessExpression(
                                factory.createIdentifier("Array"),
                                "from"
                              ),
                              undefined,
                              [
                                ts.factory.createCallExpression(
                                  ts.factory.createPropertyAccessExpression(
                                    ts.factory.createIdentifier(
                                      "filteredColumnTypes"
                                    ),
                                    ts.factory.createIdentifier("entries")
                                  ),
                                  undefined,
                                  []
                                ),
                              ]
                            ),
                            ts.factory.createIdentifier("map")
                          ),
                          undefined,
                          [
                            ts.factory.createArrowFunction(
                              undefined,
                              undefined,
                              [
                                ts.factory.createParameterDeclaration(
                                  undefined,
                                  undefined,

                                  ts.factory.createArrayBindingPattern([
                                    ts.factory.createBindingElement(
                                      undefined,
                                      undefined,
                                      "name"
                                    ),
                                    ts.factory.createBindingElement(
                                      undefined,
                                      undefined,
                                      "type"
                                    ),
                                  ])
                                ),
                              ],
                              undefined,
                              ts.factory.createToken(
                                ts.SyntaxKind.EqualsGreaterThanToken
                              ),
                              ts.factory.createTemplateExpression(
                                ts.factory.createTemplateHead("(data->>'"),
                                [
                                  ts.factory.createTemplateSpan(
                                    ts.factory.createIdentifier("name"),
                                    ts.factory.createTemplateMiddle("')::")
                                  ),
                                  ts.factory.createTemplateSpan(
                                    ts.factory.createBinaryExpression(
                                      ts.factory.createIdentifier("type"),
                                      ts.factory.createToken(
                                        ts.SyntaxKind.QuestionQuestionToken
                                      ),
                                      ts.factory.createStringLiteral("TEXT")
                                    ),
                                    ts.factory.createTemplateTail("")
                                  ),
                                ]
                              )
                            ),
                          ]
                        ),
                        factory.createTemplateTail(
                          ` FROM input RETURNING ${tableName}id;`
                        )
                      ),
                    ]
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // Running the query
          factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList([
              ts.factory.createVariableDeclaration(
                "result",
                undefined,
                undefined,
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
            ])
          ),
          // Return the inserted ids
          factory.createReturnStatement(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier("result"),
                  factory.createIdentifier("rows")
                ),
                factory.createIdentifier("map")
              ),
              undefined,
              [
                factory.createArrowFunction(
                  undefined,
                  undefined,
                  [
                    factory.createParameterDeclaration(
                      undefined,
                      undefined,
                      factory.createIdentifier("row"),
                      undefined,
                      undefined,
                      undefined
                    ),
                  ],
                  undefined,
                  factory.createToken(SyntaxKind.EqualsGreaterThanToken),
                  factory.createBlock(
                    [
                      factory.createReturnStatement(
                        factory.createCallExpression(
                          factory.createIdentifier("BigInt"),
                          undefined,
                          [
                            factory.createElementAccessExpression(
                              factory.createIdentifier("row"),
                              factory.createNumericLiteral("0")
                            ),
                          ]
                        )
                      ),
                    ],
                    true
                  )
                ),
              ]
            )
          ),
        ],
        true
      )
    )
  );
}

function getTryCatch(statements: ts.Statement[]) {
  return ts.factory.createTryStatement(
    // try block
    ts.factory.createBlock(statements, true),
    // catch clause
    ts.factory.createCatchClause(
      ts.factory.createVariableDeclaration(ts.factory.createIdentifier("e")),
      ts.factory.createBlock(
        [
          ts.factory.createThrowStatement(
            ts.factory.createNewExpression(
              ts.factory.createIdentifier("InternalServerErrorException"),
              undefined,
              [
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier("e"),
                  ts.factory.createIdentifier("message")
                ),
              ]
            )
          ),
        ],
        true
      )
    ),
    // finally block (none)
    undefined
  );
}

function filterDecl(
  name: string,
  driver: Driver,
  columns: Column[]
): ts.Statement {
  return factory.createClassDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    factory.createIdentifier(`${snakeToPascal(name)}Filter`),
    undefined,
    undefined,
    columns.filter(excludedFilter).map((column, i) => {
      const decorators = [decoratorDecl("IsOptional")];

      const typeDecoratorName = decoratorForTypeName(
        column.type!.name,
        new Set()
      );

      if (typeDecoratorName != null) {
        if (["IsISO8601", "IsNumber", "IsUuid"].includes(typeDecoratorName)) {
          // Options is the second argument
          decorators.push(
            decoratorDecl(typeDecoratorName, [
              factory.createIdentifier("undefined"),
              factory.createObjectLiteralExpression([
                factory.createPropertyAssignment("each", factory.createTrue()),
              ]),
            ])
          );
        } else {
          // By default, options is the first argument
          decorators.push(
            decoratorDecl(typeDecoratorName, [
              factory.createObjectLiteralExpression([
                factory.createPropertyAssignment("each", factory.createTrue()),
              ]),
            ])
          );
        }
      }

      return factory.createPropertyDeclaration(
        decorators,
        factory.createIdentifier(colName(i, column)),
        factory.createToken(SyntaxKind.QuestionToken),
        factory.createUnionTypeNode([
          driver.columnType(column),
          factory.createArrayTypeNode(driver.columnType(column)),
        ]),
        undefined
      );
    })
  );
}
