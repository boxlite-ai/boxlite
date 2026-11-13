/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useTheme } from '@/contexts/ThemeContext'
import { cn } from '@/lib/utils'
import { Highlight, Prism, themes, type Token } from 'prism-react-renderer'
import { readableCodeTheme } from '@/lib/readable-code-theme'
import type { Key } from 'react'
import { CopyButton } from './CopyButton'

interface CodeBlockProps {
  code: string
  language: string
  showCopy?: boolean
  preserveWhitespace?: boolean
  codeAreaClassName?: string
  className?: string
}

interface HighlightProps {
  style: React.CSSProperties
  tokens: Token[][]
  getLineProps: (props: { line: Token[]; key: number }) => React.HTMLAttributes<HTMLDivElement>
  getTokenProps: (props: { token: Token; key: number }) => React.HTMLAttributes<HTMLSpanElement>
}

// The surfaces the code is drawn on: `--code-background` in each theme, and the darker of the
// Quickstart surfaces. A token colour that passes on these passes on all of them.
const oneDark = readableCodeTheme(themes.oneDark, '#121212')
const oneLight = readableCodeTheme(themes.oneLight, '#f5f7fa')

const languageAliases: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
}

function registerBashGrammar() {
  const languages = Prism.languages as typeof Prism.languages & {
    bash?: unknown
    sh?: unknown
    shell?: unknown
  }
  if (languages.bash) {
    return
  }

  languages.bash = {
    shebang: {
      pattern: /^#!\s*\/.*/,
      alias: 'important',
    },
    comment: {
      pattern: /(^|[^"{\\$])#.*/,
      lookbehind: true,
    },
    string: [
      {
        pattern: /"(?:\\[\s\S]|\$\([^)]+\)|\$(?!\()|`[^`]+`|[^"\\`$])*"/,
        greedy: true,
        inside: {
          variable: /\$(?:\w+|[#?*!@$]|\{[^}]+\})/,
        },
      },
      {
        pattern: /'[^']*'/,
        greedy: true,
      },
    ],
    variable: /\$(?:\w+|[#?*!@$]|\{[^}]+\})/,
    function: {
      pattern: /(^|[\s;|&])(?:bash|boxlite|cc|command|curl|date|echo|jq|mv|printf|read|stty|tar)(?=$|[\s;|&])/,
      lookbehind: true,
    },
    keyword: {
      pattern: /(^|[\s;|&])(?:case|do|done|elif|else|esac|fi|for|function|if|in|select|then|until|while)(?=$|[\s;|&])/,
      lookbehind: true,
    },
    builtin: {
      pattern: /(^|[\s;|&])(?:export|set|test|trap|type)(?=$|[\s;|&])/,
      lookbehind: true,
      alias: 'class-name',
    },
    boolean: {
      pattern: /(^|[\s;|&])(?:false|true)(?=$|[\s;|&])/,
      lookbehind: true,
    },
    operator: /\d?<>|>\||\+=|=[=~]?|!=?|<<[<-]?|[&\d]?>>|\d[<>]&?|[<>][&=]?|&[>&]?|\|[&|]?/,
    punctuation: /\$?\(\(?|\)\)?|\.\.|[{}[\];\\]/,
  }
  languages.sh = languages.bash
  languages.shell = languages.bash
}

registerBashGrammar()

const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language,
  showCopy = true,
  preserveWhitespace = false,
  codeAreaClassName,
  className,
}) => {
  const { resolvedTheme } = useTheme()
  const highlightLanguage = languageAliases[language] ?? language

  return (
    <div
      className={cn(
        'relative min-w-0 max-w-full overflow-hidden rounded-none border border-border/80 bg-[hsl(var(--code-background))] shadow-sm dark:border-white/10',
        className,
      )}
    >
      <Highlight
        theme={resolvedTheme === 'dark' ? oneDark : oneLight}
        code={preserveWhitespace ? code : code.trim()}
        language={highlightLanguage}
      >
        {({ style, tokens, getLineProps, getTokenProps }: HighlightProps) => (
          <pre
            className={cn(
              'scrollbar-elevated overflow-x-auto rounded-none p-4 text-body leading-6',
              // The copy button sits in this gutter, outside the scroller, so a long line never runs under it.
              showCopy && 'mr-11',
              codeAreaClassName,
            )}
            style={{ ...style, background: 'transparent' }}
          >
            {tokens.map((line, i) => {
              const props = getLineProps({ line, key: i })
              const { key: lineKey, ...rest } = props as typeof props & { key?: Key }
              return (
                <div key={lineKey ?? i} {...rest}>
                  {line.map((token, key) => {
                    const tokenProps = getTokenProps({ token, key })
                    const { key: tokenKey, ...restTokenProps } = tokenProps as typeof tokenProps & { key?: Key }
                    return <span key={tokenKey ?? key} {...restTokenProps} />
                  })}
                </div>
              )
            })}
          </pre>
        )}
      </Highlight>
      {showCopy && (
        <CopyButton
          value={preserveWhitespace ? code : code.trim()}
          variant="ghost"
          className="absolute right-2 top-2.5 bg-background/80 p-2 text-muted-foreground shadow-sm ring-1 ring-border/70 backdrop-blur hover:bg-muted hover:text-foreground"
        />
      )}
    </div>
  )
}

export default CodeBlock
