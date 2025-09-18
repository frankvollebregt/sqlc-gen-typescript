import ts, {
  Expression,
  factory,
  Node,
  NodeFlags,
  SyntaxKind,
} from "typescript";
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
import { Syntax } from "@bufbuild/protobuf";

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

  const imports = new Set<string>(["IsDefined", "IsOptional", "IsIn", "Min"]);

  const tableNodes = [];
  for (const table of tables) {
    tableNodes.push(tableDecl(table.rel!.name, driver, table.columns, imports));
    tableNodes.push(insertableDecl(table.rel!.name, table.columns));
    tableNodes.push(updateableDecl(table.rel!.name, driver, table.columns));
    tableNodes.push(filterDecl(table.rel!.name, driver, table.columns));
    tableNodes.push(sortDecl(table.rel!.name, table.columns));
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

  // Class for LIMIT and OFFSET
  nodes.push(
    factory.createClassDeclaration(
      [factory.createToken(SyntaxKind.ExportKeyword)],
      factory.createIdentifier("Pagination"),
      undefined,
      undefined,
      [
        factory.createPropertyDeclaration(
          [
            decoratorDecl("IsOptional"),
            decoratorDecl("IsInt"),
            decoratorDecl("Min", [factory.createNumericLiteral("1")]),
          ],
          factory.createIdentifier("limit"),
          factory.createToken(SyntaxKind.QuestionToken),
          factory.createKeywordTypeNode(SyntaxKind.NumberKeyword),
          undefined
        ),
        factory.createPropertyDeclaration(
          [
            decoratorDecl("IsOptional"),
            decoratorDecl("IsInt"),
            decoratorDecl("Min", [factory.createNumericLiteral("0")]),
          ],
          factory.createIdentifier("offset"),
          factory.createToken(SyntaxKind.QuestionToken),
          factory.createKeywordTypeNode(SyntaxKind.NumberKeyword),
          undefined
        ),
      ]
    )
  );

  // General class for sorting
  // type Direction = 'ASC' | 'DESC';
  nodes.push(
    factory.createTypeAliasDeclaration(
      undefined,
      factory.createIdentifier("Direction"),
      undefined,
      factory.createUnionTypeNode([
        factory.createLiteralTypeNode(factory.createStringLiteral("ASC")),
        factory.createLiteralTypeNode(factory.createStringLiteral("DESC")),
      ])
    )
  );

  nodes.push(
    factory.createClassDeclaration(
      [factory.createToken(SyntaxKind.AbstractKeyword)],
      factory.createIdentifier("Sort"),
      undefined,
      undefined,
      [
        factory.createPropertyDeclaration(
          [
            decoratorDecl("IsDefined"),
            decoratorDecl("IsString"),
            factory.createToken(SyntaxKind.AbstractKeyword),
          ],
          factory.createIdentifier("column"),
          undefined,
          factory.createKeywordTypeNode(SyntaxKind.StringKeyword),
          undefined
        ),
        factory.createPropertyDeclaration(
          [
            decoratorDecl("IsOptional"),
            decoratorDecl("IsIn", [
              factory.createArrayLiteralExpression(
                [
                  factory.createStringLiteral("ASC"),
                  factory.createStringLiteral("DESC"),
                ],
                false
              ),
            ]),
          ],
          factory.createIdentifier("direction"),
          factory.createToken(SyntaxKind.QuestionToken),
          factory.createTypeReferenceNode(
            factory.createIdentifier("Direction"),
            undefined
          ),
          undefined
        ),
      ]
    )
  );

  // Helpers for select query building
  nodes.push(getFilterClauseDecl());
  nodes.push(getSortClauseDecl());
  nodes.push(getPaginationClauseDecl());

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
          "filter",
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createTypeReferenceNode(snakeToPascal(tableName) + "Filter")
        ),
        factory.createParameterDeclaration(
          undefined,
          undefined,
          "sort",
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createUnionTypeNode([
            factory.createTypeReferenceNode(snakeToPascal(tableName) + "Sort"),
            factory.createArrayTypeNode(
              factory.createTypeReferenceNode(snakeToPascal(tableName) + "Sort")
            ),
          ])
        ),
        factory.createParameterDeclaration(
          undefined,
          undefined,
          "pagination",
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createTypeReferenceNode("Pagination")
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
          // Get the filter clause
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createObjectBindingPattern([
                    factory.createBindingElement(
                      undefined,
                      undefined,
                      "filterClause",
                      undefined
                    ),
                    factory.createBindingElement(
                      undefined,
                      undefined,
                      "values",
                      undefined
                    ),
                  ]),
                  undefined,
                  undefined,
                  factory.createCallExpression(
                    factory.createIdentifier("getFilterClause"),
                    undefined,
                    [factory.createIdentifier("filter")]
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),

          // Get the sort clause
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  "sortClause",
                  undefined,
                  undefined,
                  factory.createCallExpression(
                    factory.createIdentifier("getSortClause"),
                    undefined,
                    [factory.createIdentifier("sort")]
                  )
                ),
              ],
              ts.NodeFlags.Const
            )
          ),

          // Get the pagination clause
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  "paginationClause",
                  undefined,
                  undefined,
                  factory.createCallExpression(
                    factory.createIdentifier("getPaginationClause"),
                    undefined,
                    [factory.createIdentifier("pagination")]
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
                  factory.createTemplateExpression(
                    // i.e. `select * from table ${whereClause} ${sortClause}`
                    factory.createTemplateHead(
                      getSelectQueryString(table, columns)
                    ),
                    [
                      factory.createTemplateSpan(
                        factory.createIdentifier("filterClause"),
                        factory.createTemplateMiddle(" ", undefined)
                      ),
                      factory.createTemplateSpan(
                        factory.createIdentifier("sortClause"),
                        factory.createTemplateMiddle(" ", undefined)
                      ),
                      factory.createTemplateSpan(
                        factory.createIdentifier("paginationClause"),
                        factory.createTemplateTail("", undefined)
                      ),
                    ]
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
                          factory.createIdentifier("values")
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
    .join(", ")} FROM ${tableName} `;
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
          "filter",
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createTypeReferenceNode(snakeToPascal(tableName) + "Filter")
        ),
      ],
      factory.createTypeReferenceNode("Promise", [
        factory.createKeywordTypeNode(SyntaxKind.NumberKeyword),
      ]),
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createBlock(
        [
          // Get the filter clause
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createObjectBindingPattern([
                    factory.createBindingElement(
                      undefined,
                      undefined,
                      "filterClause",
                      undefined
                    ),
                    factory.createBindingElement(
                      undefined,
                      undefined,
                      "values",
                      undefined
                    ),
                  ]),
                  undefined,
                  undefined,
                  factory.createCallExpression(
                    factory.createIdentifier("getFilterClause"),
                    undefined,
                    [factory.createIdentifier("filter")]
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
                  factory.createTemplateExpression(
                    // i.e. `DELETE FROM table ${filterClause}`
                    factory.createTemplateHead(`DELETE FROM ${tableName} `),
                    [
                      factory.createTemplateSpan(
                        factory.createIdentifier("filterClause"),
                        factory.createTemplateTail("", undefined)
                      ),
                    ]
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
                          factory.createIdentifier("values")
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
          "entries",
          undefined,
          factory.createUnionTypeNode([
            factory.createTypeReferenceNode(insertableIdentifier),
            factory.createArrayTypeNode(
              factory.createTypeReferenceNode(insertableIdentifier)
            ),
          ])
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
          // const ids: bigint[] = [];
          ts.factory.createVariableStatement(
            undefined,
            ts.factory.createVariableDeclarationList(
              [
                ts.factory.createVariableDeclaration(
                  "ids",
                  undefined,
                  ts.factory.createArrayTypeNode(
                    ts.factory.createKeywordTypeNode(SyntaxKind.BigIntKeyword)
                  ),
                  ts.factory.createArrayLiteralExpression([], false)
                ),
              ],
              ts.NodeFlags.Const
            )
          ),
          // Loop over each entry and insert
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
                                        ts.factory.createIdentifier(
                                          "columnTypes"
                                        ),
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
                                      ts.factory.createTemplateHead(
                                        "(data->>'"
                                      ),
                                      [
                                        ts.factory.createTemplateSpan(
                                          ts.factory.createIdentifier("name"),
                                          ts.factory.createTemplateMiddle(
                                            "')::"
                                          )
                                        ),
                                        ts.factory.createTemplateSpan(
                                          ts.factory.createBinaryExpression(
                                            ts.factory.createIdentifier("type"),
                                            ts.factory.createToken(
                                              ts.SyntaxKind
                                                .QuestionQuestionToken
                                            ),
                                            ts.factory.createStringLiteral(
                                              "TEXT"
                                            )
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
                // const id = BigInt(result.rows[0][0]);
                factory.createVariableStatement(
                  undefined,
                  factory.createVariableDeclarationList(
                    [
                      factory.createVariableDeclaration(
                        "id",
                        undefined,
                        factory.createUnionTypeNode([
                          factory.createKeywordTypeNode(
                            SyntaxKind.StringKeyword
                          ),
                          factory.createKeywordTypeNode(
                            SyntaxKind.UndefinedKeyword
                          ),
                        ]),
                        factory.createElementAccessExpression(
                          factory.createElementAccessExpression(
                            factory.createPropertyAccessExpression(
                              factory.createIdentifier("result"),
                              factory.createIdentifier("rows")
                            ),
                            factory.createIdentifier("0")
                          ),
                          factory.createIdentifier("0")
                        )
                      ),
                    ],
                    NodeFlags.Const
                  )
                ),

                factory.createIfStatement(
                  factory.createBinaryExpression(
                    factory.createIdentifier("id"),
                    SyntaxKind.ExclamationEqualsToken,
                    factory.createNull()
                  ),
                  factory.createBlock(
                    [
                      // ids.push(id);
                      factory.createExpressionStatement(
                        factory.createCallExpression(
                          factory.createPropertyAccessExpression(
                            factory.createIdentifier("ids"),
                            "push"
                          ),
                          undefined,
                          [
                            factory.createCallExpression(
                              factory.createIdentifier("BigInt"),
                              undefined,
                              [factory.createIdentifier("id")]
                            ),
                          ]
                        )
                      ),
                    ],
                    false
                  ),
                  undefined
                ),
              ],
              true
            )
          ),
          // Return the inserted ids
          factory.createReturnStatement(factory.createIdentifier("ids")),
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
): ts.ClassDeclaration {
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

function sortDecl(tableName: string, columns: Column[]) {
  const columnNames = columns.filter(excludedFilter).map((col) => col.name);

  return factory.createClassDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    factory.createIdentifier(snakeToPascal(tableName) + "Sort"),
    undefined,
    [
      factory.createHeritageClause(SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
          factory.createIdentifier("Sort"),
          undefined
        ),
      ]),
    ],
    [
      factory.createPropertyDeclaration(
        [
          decoratorDecl("IsIn", [
            factory.createArrayLiteralExpression(
              columnNames.flatMap((name) => [
                factory.createStringLiteral(name),
              ]),
              true
            ),
          ]),
        ],
        factory.createIdentifier("column"),
        undefined,
        factory.createTypeOperatorNode(
          SyntaxKind.KeyOfKeyword,
          factory.createTypeReferenceNode(snakeToPascal(tableName))
        ),
        undefined
      ),
    ]
  );
}

function getFilterClauseDecl() {
  return factory.createFunctionDeclaration(
    undefined,
    undefined,
    "getFilterClause",
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        "filter",
        factory.createToken(SyntaxKind.QuestionToken),
        factory.createTypeReferenceNode("any")
      ),
    ],
    factory.createTypeLiteralNode([
      factory.createPropertySignature(
        undefined,
        "filterClause",
        undefined,
        factory.createTypeReferenceNode("string")
      ),
      factory.createPropertySignature(
        undefined,
        "values",
        undefined,
        factory.createArrayTypeNode(
          factory.createKeywordTypeNode(SyntaxKind.AnyKeyword)
        )
      ),
    ]),
    factory.createBlock(
      [
        // const definedProperties = Object.getOwnPropertyNames(filter ?? {}).filter((prop) => filter[prop] != null);
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                "definedProperties",
                undefined,
                undefined,
                factory.createCallExpression(
                  factory.createPropertyAccessExpression(
                    factory.createCallExpression(
                      factory.createPropertyAccessExpression(
                        factory.createIdentifier("Object"),
                        "getOwnPropertyNames"
                      ),
                      undefined,

                      [
                        factory.createBinaryExpression(
                          factory.createIdentifier("filter"),
                          SyntaxKind.QuestionQuestionToken,
                          factory.createObjectLiteralExpression()
                        ),
                      ]
                    ),
                    "filter"
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
                          "prop"
                        ),
                      ],
                      undefined,
                      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                      factory.createBinaryExpression(
                        factory.createElementAccessChain(
                          factory.createIdentifier("filter"),
                          factory.createToken(SyntaxKind.QuestionDotToken),
                          factory.createIdentifier("prop")
                        ),
                        ts.SyntaxKind.ExclamationEqualsToken,
                        factory.createNull()
                      )
                    ),
                  ]
                )
              ),
            ],
            ts.NodeFlags.Const
          )
        ),

        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                "filterConditions",
                undefined,
                factory.createArrayTypeNode(
                  factory.createKeywordTypeNode(SyntaxKind.StringKeyword)
                ),
                factory.createArrayLiteralExpression([], false)
              ),
            ],
            ts.NodeFlags.Const
          )
        ),

        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                "values",
                undefined,
                factory.createArrayTypeNode(
                  factory.createKeywordTypeNode(SyntaxKind.AnyKeyword)
                ),
                factory.createArrayLiteralExpression([], false)
              ),
            ],
            ts.NodeFlags.Const
          )
        ),

        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                "counter",
                undefined,
                undefined,
                factory.createNumericLiteral("1")
              ),
            ],
            ts.NodeFlags.Let
          )
        ),
        // for (const prop of definedProperties) {
        factory.createForOfStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                ts.factory.createIdentifier("prop"),
                undefined,
                undefined,
                undefined
              ),
            ],
            ts.NodeFlags.Const
          ),
          factory.createIdentifier("definedProperties"),
          factory.createBlock([
            // const value = filter[prop];
            factory.createVariableStatement(
              undefined,
              factory.createVariableDeclarationList(
                [
                  factory.createVariableDeclaration(
                    ts.factory.createIdentifier("value"),
                    undefined,
                    undefined,
                    factory.createElementAccessChain(
                      factory.createIdentifier("filter"),
                      factory.createToken(SyntaxKind.QuestionDotToken),
                      factory.createIdentifier("prop")
                    )
                  ),
                ],
                ts.NodeFlags.Const
              )
            ),
            // if (Array.isArray(value)) {
            factory.createIfStatement(
              factory.createCallExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier("Array"),
                  "isArray"
                ),
                undefined,
                [factory.createIdentifier("value")]
              ),
              // then
              factory.createBlock([
                // whereConditions.push(`${prop} = ANY($${counter})`);
                factory.createExpressionStatement(
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                      factory.createIdentifier("filterConditions"),
                      "push"
                    ),
                    undefined,
                    [
                      factory.createTemplateExpression(
                        factory.createTemplateHead("", undefined),
                        [
                          factory.createTemplateSpan(
                            factory.createIdentifier("prop"),
                            factory.createTemplateMiddle(" = ANY($", undefined)
                          ),
                          factory.createTemplateSpan(
                            factory.createIdentifier("counter"),
                            factory.createTemplateTail(")", ")")
                          ),
                        ]
                      ),
                    ]
                  )
                ),
              ]),
              factory.createBlock([
                // else
                // whereConditions.push(`${prop} = $${counter}`);
                factory.createExpressionStatement(
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                      factory.createIdentifier("filterConditions"),
                      "push"
                    ),
                    undefined,
                    [
                      factory.createTemplateExpression(
                        factory.createTemplateHead("", undefined),
                        [
                          factory.createTemplateSpan(
                            factory.createIdentifier("prop"),
                            factory.createTemplateMiddle(" = $", undefined)
                          ),
                          factory.createTemplateSpan(
                            factory.createIdentifier("counter"),
                            factory.createTemplateTail("", undefined)
                          ),
                        ]
                      ),
                    ]
                  )
                ),
              ])
            ),
            // values.push(value);
            factory.createExpressionStatement(
              factory.createCallExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier("values"),
                  "push"
                ),
                undefined,
                [factory.createIdentifier("value")]
              )
            ),
            // counter++;
            factory.createExpressionStatement(
              factory.createPostfixIncrement(
                factory.createIdentifier("counter")
              )
            ),
          ])
        ),
        // return whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        factory.createReturnStatement(
          factory.createObjectLiteralExpression(
            [
              factory.createPropertyAssignment(
                "filterClause",
                factory.createConditionalExpression(
                  factory.createBinaryExpression(
                    factory.createPropertyAccessExpression(
                      factory.createIdentifier("filterConditions"),
                      "length"
                    ),
                    ts.SyntaxKind.GreaterThanToken,
                    factory.createNumericLiteral("0")
                  ),
                  factory.createToken(ts.SyntaxKind.QuestionToken),
                  factory.createTemplateExpression(
                    factory.createTemplateHead("WHERE "),
                    [
                      factory.createTemplateSpan(
                        factory.createCallExpression(
                          factory.createPropertyAccessExpression(
                            factory.createIdentifier("filterConditions"),
                            "join"
                          ),
                          undefined,

                          [factory.createStringLiteral(" AND ")]
                        ),
                        factory.createTemplateTail("", undefined)
                      ),
                    ]
                  ),
                  factory.createToken(ts.SyntaxKind.ColonToken),
                  factory.createStringLiteral("")
                )
              ),
              factory.createPropertyAssignment(
                "values",
                factory.createIdentifier("values")
              ),
            ],
            true
          )
        ),
      ],
      true
    )
  );
}

function getSortClauseDecl() {
  return factory.createFunctionDeclaration(
    undefined,
    undefined,
    "getSortClause",
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        "sort",
        factory.createToken(SyntaxKind.QuestionToken),
        factory.createUnionTypeNode([
          factory.createTypeReferenceNode("Sort"),
          factory.createArrayTypeNode(factory.createTypeReferenceNode("Sort")),
        ])
      ),
    ],
    factory.createTypeReferenceNode("string"),
    factory.createBlock(
      [
        // const sortArr = Array.isArray(sort) ? sort : [sort];
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                "sortArr",
                undefined,
                undefined,
                factory.createConditionalExpression(
                  // sort == null ? [] : (Array.isArray(sort) ? sort : [sort]
                  factory.createBinaryExpression(
                    factory.createIdentifier("sort"),
                    ts.SyntaxKind.EqualsEqualsToken,
                    factory.createNull()
                  ),
                  factory.createToken(ts.SyntaxKind.QuestionToken),
                  factory.createArrayLiteralExpression([], false),
                  factory.createToken(ts.SyntaxKind.ColonToken),
                  factory.createConditionalExpression(
                    factory.createCallExpression(
                      factory.createPropertyAccessExpression(
                        factory.createIdentifier("Array"),
                        "isArray"
                      ),
                      undefined,
                      [factory.createIdentifier("sort")]
                    ),
                    factory.createToken(ts.SyntaxKind.QuestionToken),
                    factory.createIdentifier("sort"),
                    factory.createToken(ts.SyntaxKind.ColonToken),
                    factory.createArrayLiteralExpression(
                      [factory.createIdentifier("sort")],
                      false
                    )
                  )
                )
              ),
            ],
            ts.NodeFlags.Const
          )
        ),
        // const sortExpressions = sortArr.map((sort) => `${sort.column} ${sort.direction ?? ''}`);
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                "sortExpressions",
                undefined,
                undefined,
                factory.createCallExpression(
                  factory.createPropertyAccessExpression(
                    factory.createIdentifier("sortArr"),
                    "map"
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
                          "sort",
                          undefined,
                          undefined,
                          undefined
                        ),
                      ],

                      undefined,
                      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                      factory.createTemplateExpression(
                        factory.createTemplateHead("", undefined),
                        [
                          factory.createTemplateSpan(
                            factory.createPropertyAccessExpression(
                              factory.createIdentifier("sort"),
                              "column"
                            ),
                            factory.createTemplateMiddle(" ", undefined)
                          ),
                          factory.createTemplateSpan(
                            factory.createBinaryExpression(
                              factory.createPropertyAccessExpression(
                                factory.createIdentifier("sort"),
                                "direction"
                              ),
                              ts.SyntaxKind.QuestionQuestionToken,
                              factory.createStringLiteral("")
                            ),
                            factory.createTemplateTail("", undefined)
                          ),
                        ]
                      )
                    ),
                  ]
                )
              ),
            ],
            ts.NodeFlags.Const
          )
        ),

        // return sortArr.length === 0 ? '' : `ORDER BY ${sortExpressions.join(', ')}`;
        factory.createReturnStatement(
          factory.createConditionalExpression(
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier("sortArr"),
                "length"
              ),
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              factory.createNumericLiteral("0")
            ),
            factory.createToken(ts.SyntaxKind.QuestionToken),
            factory.createStringLiteral(""),
            factory.createToken(ts.SyntaxKind.ColonToken),
            factory.createTemplateExpression(
              factory.createTemplateHead("ORDER BY "),
              [
                factory.createTemplateSpan(
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                      factory.createIdentifier("sortExpressions"),
                      "join"
                    ),
                    undefined,
                    [factory.createStringLiteral(", ")]
                  ),
                  factory.createTemplateTail("", undefined)
                ),
              ]
            )
          )
        ),
      ],
      true
    )
  );
}

function getPaginationClauseDecl() {
  return factory.createFunctionDeclaration(
    undefined,
    undefined,
    "getPaginationClause",
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        "pagination",
        factory.createToken(SyntaxKind.QuestionToken),
        factory.createTypeReferenceNode("Pagination")
      ),
    ],
    factory.createTypeReferenceNode("string"),
    factory.createBlock(
      [
        // The pagination clause
        // return `${pagination?.limit != null ? `LIMIT ${pagination.limit}` : ''} ${pagination?.offset != null ? `OFFSET ${pagination.offset}` : ''}`;
        factory.createReturnStatement(
          factory.createTemplateExpression(factory.createTemplateHead(""), [
            factory.createTemplateSpan(
              factory.createConditionalExpression(
                factory.createBinaryExpression(
                  factory.createPropertyAccessChain(
                    factory.createIdentifier("pagination"),
                    factory.createToken(SyntaxKind.QuestionDotToken),
                    factory.createIdentifier("limit")
                  ),
                  ts.SyntaxKind.ExclamationEqualsToken,
                  factory.createNull()
                ),
                factory.createToken(ts.SyntaxKind.QuestionToken),
                factory.createTemplateExpression(
                  factory.createTemplateHead("LIMIT "),
                  [
                    factory.createTemplateSpan(
                      factory.createPropertyAccessExpression(
                        factory.createIdentifier("pagination"),
                        factory.createIdentifier("limit")
                      ),
                      factory.createTemplateTail("", undefined)
                    ),
                  ]
                ),
                factory.createToken(ts.SyntaxKind.ColonToken),
                factory.createStringLiteral("")
              ),
              factory.createTemplateMiddle(" ", undefined)
            ),
            factory.createTemplateSpan(
              factory.createConditionalExpression(
                factory.createBinaryExpression(
                  factory.createPropertyAccessChain(
                    factory.createIdentifier("pagination"),
                    factory.createToken(SyntaxKind.QuestionDotToken),
                    factory.createIdentifier("offset")
                  ),
                  ts.SyntaxKind.ExclamationEqualsToken,
                  factory.createNull()
                ),
                factory.createToken(ts.SyntaxKind.QuestionToken),
                factory.createTemplateExpression(
                  factory.createTemplateHead("OFFSET "),
                  [
                    factory.createTemplateSpan(
                      factory.createPropertyAccessExpression(
                        factory.createIdentifier("pagination"),
                        factory.createIdentifier("offset")
                      ),
                      factory.createTemplateTail("", undefined)
                    ),
                  ]
                ),
                factory.createToken(ts.SyntaxKind.ColonToken),
                factory.createStringLiteral("")
              ),
              factory.createTemplateTail("", undefined)
            ),
          ])
        ),
      ],
      true
    )
  );
}
