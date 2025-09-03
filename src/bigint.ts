import { factory, SyntaxKind } from "typescript";
import { colName } from "./drivers/utlis";
import { Column } from "./gen/plugin/codegen_pb";

/**
 * Map the columns in the returned value so that they are parsed to actual
 * BigInt objects in Typescript
 */
export function mapReturnColumnsWithBigInt(col: Column, i: number) {
  if (col.type?.name == "int8") {
    // It's a BigInt, return the value parsed as a bigint!
    if (col.notNull) {
      // Not nullable --> BigInt(row[i])
      return factory.createPropertyAssignment(
        factory.createIdentifier(colName(i, col)),
        factory.createCallExpression(
          factory.createIdentifier("BigInt"),
          undefined,
          [
            factory.createElementAccessExpression(
              factory.createIdentifier("row"),
              factory.createNumericLiteral(`${i}`)
            ),
          ]
        )
      );
    } else {
      // Nullable --> row[i] != null ? BigInt(row[i]) : null
      return factory.createPropertyAssignment(
        factory.createIdentifier(colName(i, col)),
        factory.createConditionalExpression(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier("row"),
              factory.createNumericLiteral(`${i}`)
            ),
            factory.createToken(SyntaxKind.ExclamationEqualsToken),
            factory.createNull()
          ),
          factory.createToken(SyntaxKind.QuestionToken),
          factory.createCallExpression(
            factory.createIdentifier("BigInt"),
            undefined,
            [
              factory.createElementAccessExpression(
                factory.createIdentifier("row"),
                factory.createNumericLiteral(`${i}`)
              ),
            ]
          ),
          factory.createToken(SyntaxKind.ColonToken),
          factory.createNull()
        )
      );
    }
  } else {
    return factory.createPropertyAssignment(
      factory.createIdentifier(colName(i, col)),
      factory.createElementAccessExpression(
        factory.createIdentifier("row"),
        factory.createNumericLiteral(`${i}`)
      )
    );
  }
}
