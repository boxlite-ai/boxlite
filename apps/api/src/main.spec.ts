/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

describe('API HTTP server timeout configuration', () => {
  it('disables the request body timeout for slow file uploads', () => {
    const source = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    const sourceFile = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let disablesRequestTimeout = false

    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === 'httpServer' &&
        node.left.name.text === 'requestTimeout' &&
        ts.isNumericLiteral(node.right) &&
        node.right.text === '0'
      ) {
        disablesRequestTimeout = true
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    expect(disablesRequestTimeout).toBe(true)
  })
})
